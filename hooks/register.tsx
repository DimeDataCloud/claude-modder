import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Card, GateEntry, Health, JevInfo, Row } from '../types'
import { age, doing, jevRead, mark, name, newCard, pct, recentOf, rows, title, touch } from './fleet'
import { jev, keyIn, Queue } from './jev'
import type { Decider } from './jev'
import { GATE_QUESTIONS, GONE_MS, HEALTH_QUESTIONS, NEEDS_YOU, gateState, gateVerdict, hardDeny, healthState, list, nudgeText } from './policy'
import type { Rules } from './policy'

/**
 * Every Claude Code session running this mod writes a card about itself to
 * ~/.claude-modder/sessions/. One of them, the lead, asks Jev about the others
 * and writes what it learns to health.json; every session reads both and
 * shows the fleet, most urgent first. A nudge is a note dropped in the other
 * session's inbox, put in its prompt box for a person to send.
 */

const PANE = 'modder'
const fleet = atom({ plugin: 'modder', key: 'fleet' } as const, [] as Row[])
const me = atom({ plugin: 'modder', key: 'me' } as const, '')
const leadAtom = atom({ plugin: 'modder', key: 'lead' } as const, false)
const tick = atom({ plugin: 'modder', key: 'tick' } as const, 0)
const jevAtom = atom({ plugin: 'modder', key: 'jev' } as const, { mode: 'shadow', calls: 0, fails: 0, cost: 0, lat: [] } as JevInfo)
const gateLog = atom({ plugin: 'modder', key: 'gate' } as const, [] as GateEntry[])
const hush = atom({ plugin: 'modder', key: 'hush' } as const, '')

/** Tools the gate never asks about: they only read, or they always need the person. */
const QUIET_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'TaskList', 'TaskGet', 'ToolSearch', 'NotebookRead'])
const BEAT_MS = 10_000
const LEAD_STALE_MS = 15_000
/** The orchestrator looks at a session again no sooner than this. */
const RECHECK_MS = 20_000

const slash = (p: string) => p.replace(/\\/g, '/')

let mode: JevInfo['mode'] = 'shadow'
let rules: Rules = { protect: [], denyPushFrom: [] }
let keyFile = ''
let home = ''
let dir = ''
let card: Card | undefined
let written = 0
let decider: Decider | undefined
let queue: Queue | undefined
let health: Record<string, Health> = {}
const lastLook = new Map<string, number>()
const seen = new Map<string, number>()
let isLead = false
/** The session that asks Jev, as lead.json last named it. */
let leadId = ''
const leadName = (rs: Row[]) => {
  const r = rs.find(x => x.id === leadId)
  return r ? name(r) : 'none yet'
}
let cycle = 0

async function expand($: EngineInterface, p: string): Promise<string> {
  return p.startsWith('~') ? `${home}${p.slice(1)}` : p
}

/** The OpenRouter key: the environment first, then the configured file. Never logged. */
async function loadKey($: EngineInterface): Promise<string | undefined> {
  const env = (await $.env.get('OPENROUTER_API_KEY'))?.trim()
  if (env) {
    return env
  }
  if (!keyFile) {
    return undefined
  }
  const text = await $.fs.read(await expand($, keyFile)).catch(() => undefined)
  return typeof text === 'string' ? keyIn(text) : undefined
}


async function setJev($: EngineInterface, fn: (j: JevInfo) => JevInfo): Promise<void> {
  await update($, jevAtom, fn)
}

/** One Jev call through the queue, with its cost and latency counted. */
async function ask($: EngineInterface, pri: 0 | 1, maxWait: number, timeout: number, state: unknown, qs: typeof GATE_QUESTIONS) {
  if (!decider || !queue || mode === 'off') {
    return undefined
  }
  const d = decider
  return queue.add(pri, maxWait, async () => {
    try {
      const r = await d.decide(state, qs, timeout)
      await setJev($, j => ({ ...j, down: undefined, calls: j.calls + 1, cost: j.cost + r.cost, lat: [...j.lat, r.ms].slice(-200), model: r.model }))
      return r
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await setJev($, j => ({ ...j, fails: j.fails + 1, ...(/ 401/.test(msg) ? { down: 'the OpenRouter key was refused (401)' } : {}) }))
      throw err
    }
  })
}

// ── This session's card ────────────────────────────────────────────────────

async function save($: EngineInterface, patch: Partial<Card>): Promise<void> {
  if (!card) {
    return
  }
  const now = await $.clock.now()
  card = touch(card, patch, now)
  await flush($)
}

async function flush($: EngineInterface): Promise<void> {
  if (!card || !dir) {
    return
  }
  const now = await $.clock.now()
  card = { ...card, beat: now }
  written = now
  await $.fs.write(`${dir}/sessions/${card.id}.json`, JSON.stringify(card)).catch(() => undefined)
}

/** What this session's mod knows about itself, in ~/.claude-modder/diag/ for troubleshooting: never the key. */
const diag: Record<string, unknown> = { checks: 0, gateRuns: 0 }

async function writeDiag($: EngineInterface, patch: Record<string, unknown>): Promise<void> {
  Object.assign(diag, patch)
  if (card && dir) {
    await $.fs.write(`${dir}/diag/${card.id}.json`, JSON.stringify(diag)).catch(() => undefined)
  }
}

async function refreshRecent($: EngineInterface): Promise<void> {
  const msgs = await $.session.messages().catch(async (err: unknown) => {
    await writeDiag($, { messagesError: String(err).slice(0, 200) })
    return []
  })
  if (!Array.isArray(msgs)) {
    await writeDiag($, { messagesShape: JSON.stringify(msgs).slice(0, 200) })
  }
  if (Array.isArray(msgs)) {
    void writeDiag($, { messages: msgs.length })
  }
  if (Array.isArray(msgs) && card) {
    const all = msgs as { role: 'user' | 'assistant'; text: string }[]
    // A resumed or reloaded session: its first ask is still what it is for.
    const first = card.task || all.find(m => m.role === 'user' && m.text.trim())?.text.trim() || ''
    card = { ...card, recent: recentOf(all), task: first.slice(0, 2000) }
  }
}

// ── The fleet ──────────────────────────────────────────────────────────────

async function readJson<T>($: EngineInterface, path: string): Promise<T | undefined> {
  const raw = await $.fs.read(path).catch(() => undefined)
  if (typeof raw !== 'string') {
    return undefined
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

async function cards($: EngineInterface, now: number): Promise<Card[]> {
  const files = await $.fs.list(`${dir}/sessions`).catch(() => [])
  const fresh = files.filter(f => f.kind === 'file' && f.name.endsWith('.json') && now - f.mtimeMs < GONE_MS * 4)
  const all = await Promise.all(fresh.map(f => readJson<Card>($, `${dir}/sessions/${f.name}`)))
  return all.filter((c): c is Card => !!c && typeof c.id === 'string')
}

/** The lead is whoever wrote lead.json last within 15s; a missing or stale lead is claimed. */
async function elect($: EngineInterface, now: number, force = false): Promise<boolean> {
  const id = card?.id
  if (!id) {
    return false
  }
  const cur = await readJson<{ id: string; beat: number }>($, `${dir}/lead.json`)
  leadId = cur?.id ?? ''
  const mine = force || !cur || cur.id === id || now - cur.beat > LEAD_STALE_MS
  if (mine) {
    leadId = id
    await $.fs.write(`${dir}/lead.json`, JSON.stringify({ id, beat: now })).catch(() => undefined)
  }
  if (mine !== isLead) {
    isLead = mine
    await update($, leadAtom, () => mine)
  }
  return mine
}

/** The lead's job: ask Jev about every other session that changed. */
async function look($: EngineInterface, cs: Card[], now: number): Promise<void> {
  // Forget sessions that are gone, so health.json stays the size of the fleet.
  const live = new Set(cs.map(c => c.id))
  for (const id of Object.keys(health)) {
    if (!live.has(id)) {
      delete health[id]
    }
  }
  for (const c of cs) {
    // The lead reads itself too: any session can be the lead, and it can need you as much as the rest.
    if (c.state === 'ended' || now - c.beat > GONE_MS) {
      continue
    }
    // Asking and erroring speak for themselves; Jev reads the ambiguous ones.
    if (c.state === 'asking' || c.state === 'error' || health[c.id]?.rev === c.rev || now - (lastLook.get(c.id) ?? 0) < RECHECK_MS) {
      continue
    }
    if (c.state === 'working' && now - c.since < 60_000) {
      continue
    }
    lastLook.set(c.id, now)
    void ask($, 1, 30_000, 5_000, healthState(c, now), HEALTH_QUESTIONS)
      .then(async r => {
        if (!r) {
          return
        }
        const a = r.answers
        health[c.id] = { at: await $.clock.now(), rev: c.rev, needs_you: a['needs_you']!, off_track: a['off_track']!, stuck: a['stuck']!, done: a['done']!, progress: a['progress']!, ms: r.ms }
        await $.fs.write(`${dir}/health.json`, JSON.stringify(health)).catch(() => undefined)
        await refresh($)
      })
      .catch(() => undefined)
  }
}

let refreshing = false

async function refresh($: EngineInterface): Promise<void> {
  if (refreshing || !dir) {
    return
  }
  refreshing = true
  try {
    const now = await $.clock.now()
    if (now - written > BEAT_MS) {
      await flush($)
    }
    const cs = await cards($, now)
    const lead = await elect($, now)
    if (lead) {
      await look($, cs, now)
    } else {
      health = (await readJson<Record<string, Health>>($, `${dir}/health.json`)) ?? health
    }
    const rs = rows(cs, health, now)
    await update($, fleet, () => rs)
    await notice($, rs)
    if (++cycle % 2 === 0) {
      await inbox($)
    }
  } finally {
    refreshing = false
  }
}

/** A toast the first time another session comes to need you. */
async function notice($: EngineInterface, rs: Row[]): Promise<void> {
  for (const r of rs) {
    const was = seen.get(r.id) ?? 0
    seen.set(r.id, r.rank)
    if (r.id !== card?.id && r.rank >= NEEDS_YOU && was < NEEDS_YOU && was !== 0) {
      $.ui.toast(`${mark(r, 0)} ${name(r)}: ${r.why}`)
    }
  }
}

/** A note from the orchestrator: into the prompt box, for a person to send. */
async function inbox($: EngineInterface): Promise<void> {
  if (!card) {
    return
  }
  const path = `${dir}/inbox/${card.id}.json`
  const notes = await readJson<string[]>($, path)
  if (!notes?.length) {
    return
  }
  const box = await $.prompt.read().catch(() => ({ text: 'x', cursor: 0 }))
  if (box.text.trim()) {
    return
  }
  await $.fs.write(path, '[]').catch(() => undefined)
  const filled = await $.prompt.fill({ text: notes.at(-1)!, mode: 'replace' }).catch(() => ({ isFilled: false }))
  $.ui.toast(filled.isFilled ? 'Your orchestrator left a note in the prompt box: Enter sends it, Esc clears it' : `Note from your orchestrator: ${notes.at(-1)}`)
}

async function nudge($: EngineInterface, r: Row): Promise<void> {
  const path = `${dir}/inbox/${r.id}.json`
  const notes = (await readJson<string[]>($, path)) ?? []
  await $.fs.write(path, JSON.stringify([...notes, nudgeText(r.why)].slice(-3)))
  $.ui.toast(`Note left for "${title(r)}": it shows in that session's prompt box`)
}

// ── The gate ───────────────────────────────────────────────────────────────

async function shadowGate($: EngineInterface, tool: string, input: unknown, core: 'allow' | 'ask' | 'deny'): Promise<void> {
  const cwd = card?.root ?? ''
  const at = await $.clock.now()
  const r = await ask($, 0, 10_000, 3_000, gateState(card?.recent ?? [], tool, input, cwd), GATE_QUESTIONS).catch(async (err: unknown) => {
    await writeDiag($, { gateError: String(err).slice(0, 200) })
    return undefined
  })
  await writeDiag($, { gateRuns: (diag['gateRuns'] as number) + 1 })
  const v = r ? gateVerdict(r.answers) : undefined
  const entry: GateEntry = {
    at,
    tool,
    what: doing(tool, input),
    core,
    jev: v?.verdict ?? 'error',
    serves: v?.serves ?? 0,
    risk: v?.risk ?? 0,
    top: v?.top ?? '',
    ms: r?.ms ?? 0,
    cost: r?.cost ?? 0,
  }
  const log = await update($, gateLog, g => [...g, entry].slice(-300))
  if (card) {
    await $.fs.write(`${dir}/gate/${card.id}.json`, JSON.stringify(log)).catch(() => undefined)
  }
}

/** Shadow agreement: Jev's allow vs a session that ran the call, Jev's deny vs one that refused or asked. */
export function agreement(g: GateEntry[]): { n: number; agree: number; allows: number; denies: number } {
  const judged = g.filter(x => x.jev !== 'error' && x.jev !== 'defer')
  const agree = judged.filter(x => (x.jev === 'allow' ? x.core === 'allow' : x.core !== 'allow')).length
  return { n: judged.length, agree, allows: judged.filter(x => x.jev === 'allow').length, denies: judged.filter(x => x.jev === 'deny').length }
}

// ── Registration ───────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const m = options['jevMode']
  mode = m === 'off' || m === 'enforce' ? m : 'shadow'
  keyFile = typeof options['keyFile'] === 'string' ? options['keyFile'].trim() : ''
  rules = { protect: list(options['protect'] ?? '/.ssh/,/.aws/credentials,/.gnupg/'), denyPushFrom: list(options['denyPushFrom']) }

  on('session.start', async ($, e, next) => {
    const res = await next(e)
    await $.command.register({
      name: 'modder',
      description: 'Your Claude sessions at a glance: who is working, who needs you, and what Jev makes of each',
      argumentHint: '[lead | nudge <n> | gate | close]',
      immediate: true,
    })
    home = slash((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '')
    if (!home) {
      return res
    }
    dir = `${home}/.claude-modder`
    const [id, root, repo, model] = await Promise.all([
      $.session.id(),
      $.session.root(),
      $.session.repo().catch(() => null),
      $.session.model().catch(() => ''),
    ])
    const now = await $.clock.now()
    card = { ...newCard(id, slash(root), now), model, repo: repo?.name ?? newCard(id, slash(root), now).repo }
    const head = await $.fs.read(`${slash(repo?.root ?? root)}/.git/HEAD`).catch(() => '')
    if (typeof head === 'string') {
      card.branch = head.replace(/^ref: refs\/heads\//, '').trim().slice(0, 40)
    }
    await update($, me, () => id)
    // A resumed session or a reload starts with what is already said.
    await refreshRecent($)
    await flush($)

    const key = mode === 'off' ? undefined : await loadKey($)
    await writeDiag($, { mode, keyFile, hasKey: !!key, protect: rules.protect, denyPushFrom: rules.denyPushFrom })
    if (key) {
      decider = jev((url, init) => $.http.fetch(url, init), key, () => Date.now(), ms => $.clock.sleep(ms))
      queue = new Queue(() => Date.now())
    }
    await setJev($, j => ({
      ...j,
      mode,
      ...(mode !== 'off' && !key ? { down: keyFile ? `no key in ${keyFile}` : 'no OpenRouter key: set OPENROUTER_API_KEY or the keyFile option' } : {}),
    }))

    await refresh($)
    $.clock.every(3000, () => void refresh($).catch(() => undefined))
    // The heartbeat of the view: spinners turn while anyone works.
    $.clock.every(250, () => {
      void (async () => {
        const rs = await read($, fleet)
        if (rs.some(r => r.state === 'working')) {
          await update($, tick, t => t + 1)
        }
      })()
    })
    return res
  })

  on('session.end', async ($, e, next) => {
    await save($, { state: 'ended', doing: '' })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const text = e.text.trim()
    if (card && text) {
      // The gate and the lead see the new ask right away, not at the end of the turn.
      const recent = recentOf([...card.recent, { role: 'user' as const, text }])
      await save($, { state: 'working', lastPrompt: text.slice(0, 2000), task: card.task || text.slice(0, 2000), turns: card.turns + 1, doing: 'thinking', recent })
    } else if (card) {
      await save($, { state: 'working', doing: 'thinking' })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId === undefined && card) {
      await refreshRecent($)
      const err = e.reason === 'error'
      await save($, { state: err ? 'error' : 'idle', doing: err ? 'the turn ended on an error' : '', lastText: e.answer.slice(-600) })
    }
    return res
  })

  on('session.measure', async ($, e, next) => {
    if (card && typeof e.context.percent === 'number') {
      card = { ...card, ctxPct: Math.round(e.context.percent) }
    }
    return next(e)
  })

  // Hard rules first, in every loop; then keep the card current.
  on('tool.call', async ($, e, next) => {
    const no = hardDeny(e.tool, e, card?.root ?? '', rules, home)
    if (no) {
      return { deny: no }
    }
    if (e.agentId !== undefined || !card) {
      return next(e)
    }
    const isAgent = e.tool === 'Agent'
    const asks = e.tool === 'AskUserQuestion'
    await save($, {
      doing: doing(e.tool, e),
      tools: card.tools + 1,
      ...(isAgent ? { agents: card.agents + 1 } : {}),
      ...(asks ? { state: 'asking' as const } : { state: 'working' as const }),
    })
    try {
      return await next(e)
    } finally {
      if (card && (isAgent || asks)) {
        await save($, { ...(isAgent ? { agents: Math.max(0, card.agents - 1) } : {}), ...(asks ? { state: 'working' as const } : {}) })
      }
    }
  })

  // The permission gate: shadow logs Jev beside what the session did; enforce acts on it.
  on('tool.check', async ($, e, next) => {
    const real = e.tool_use_id !== undefined
    const asked = real && mode !== 'off' && decider && !QUIET_TOOLS.has(e.tool)
    void writeDiag($, { checks: (diag['checks'] as number) + 1, lastCheck: `${e.tool} real=${real} asked=${!!asked}` })
    const res = await next(e)
    // Enforce settles only what would be put to you: the session's own allow
    // and deny (settings rules, mode, classic hooks) always stand.
    if (asked && mode === 'enforce' && res.decision === 'ask' && e.tool !== 'AskUserQuestion') {
      const r = await ask($, 0, 1500, 1500, gateState(card?.recent ?? [], e.tool, e.input, card?.root ?? ''), GATE_QUESTIONS).catch(() => undefined)
      const v = r ? gateVerdict(r.answers) : undefined
      if (v?.verdict === 'allow') {
        return { decision: 'allow', reason: `Jev: serves the request (${Math.round(v.serves * 100)}%), every risk low` }
      }
      if (v?.verdict === 'deny') {
        return { decision: 'deny', reason: `Jev: likely ${v.top} (${Math.round(v.risk * 100)}%) and not what you asked for` }
      }
    }
    if (real && e.agentId === undefined && res.decision === 'ask' && e.tool !== 'AskUserQuestion' && card) {
      await save($, { state: 'asking', doing: `permission: ${doing(e.tool, e.input)}` })
    }
    if (asked && mode === 'shadow') {
      void shadowGate($, e.tool, e.input, res.decision).catch(() => undefined)
    }
    return res
  })

  on('command.run', { command: 'modder' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().split(/\s+/)
    if (verb === 'close') {
      await $.ui.close({ id: PANE })
      return {}
    }
    if (verb === 'lead') {
      await elect($, await $.clock.now(), true)
      $.ui.toast('This session is the lead now: it asks Jev about the others')
      return {}
    }
    if (verb === 'nudge') {
      const rs = (await read($, fleet)).filter(r => r.id !== card?.id)
      const r = rs[Number(arg) - 1]
      if (!r) {
        $.ui.toast('Usage: /modder nudge <n>, n as numbered in /modder')
        return {}
      }
      await nudge($, r)
      return {}
    }
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Sessions' })
    return {}
  })

  // Footer: `fleet 3 · 1 needs you`, only when there is more than this session.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const rs = await read($, fleet)
    if (rs.length < 2) {
      return next(e)
    }
    const id = await read($, me)
    const need = rs.filter(r => r.id !== id && r.rank >= NEEDS_YOU).length
    const label = need ? `fleet ${rs.length} · ${need} need${need === 1 ? 's' : ''} you` : `fleet ${rs.length}`
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } })
  })

  // Above the prompt: the one other session that most needs you, until dismissed.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const [rs, id, hushed] = await Promise.all([read($, fleet), read($, me), read($, hush)])
    const top = rs.find(r => r.id !== id && r.rank >= NEEDS_YOU)
    if (!top || hushed === `${top.id}:${top.rev}`) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = Date.now()
    // One row: who, why, how long; then the ways through.
    return (
      <Box key="modder-band" flexDirection="row" columnGap={2}>
        <Text key="m" color={top.tone} bold>{mark(top, 0)}</Text>
        <Box key="t" flexShrink={0}>
          <Text bold>{name(top)}</Text>
        </Box>
        <Box key="w" flexGrow={1} flexShrink={1}>
          <Text color={top.tone} wrap="truncate">{top.why}</Text>
        </Box>
        <Box key="a" flexShrink={0}>
          <Text dimColor>{age(now - top.since)}</Text>
        </Box>
        <Button key="n" label="Nudge" plain onPress={() => nudge($, top)} />
        <Button key="f" label="Sessions" plain onPress={() => $.ui.open({ id: PANE, title: 'Sessions' }).then(() => undefined)} />
        <Button key="x" label="Dismiss" plain onPress={() => update($, hush, () => `${top.id}:${top.rev}`).then(() => undefined)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [rs, id, lead, t, j, g] = await Promise.all([read($, fleet), read($, me), read($, leadAtom), read($, tick), read($, jevAtom), read($, gateLog)])
    const now = Date.now()
    const cols = Math.max(48, Math.min(160, e.props.bodyColumns))
    const others = rs.filter(r => r.id !== id)
    const need = others.filter(r => r.rank >= NEEDS_YOU).length
    const working = rs.filter(r => r.state === 'working').length

    const head = [
      `${rs.length} session${rs.length === 1 ? '' : 's'}`,
      working ? `${working} working` : '',
      need ? `${need} need${need === 1 ? 's' : ''} you` : 'nobody needs you',
    ].filter(Boolean)

    // Fixed columns: number, mark, title (takes the rest), age, Nudge. Nothing wraps.
    const inner = cols - 4
    let n = 0
    const list = rs.map(r => {
      const self = r.id === id
      const num = self ? '·' : String(++n)
      const facts = [r.branch ? `${r.repo}@${r.branch}` : r.repo, `${r.turns} turn${r.turns === 1 ? '' : 's'}`, `${r.tools} tools`, r.agents ? `${r.agents} agents` : '', r.ctxPct !== undefined ? `ctx ${r.ctxPct}%` : '']
        .filter(Boolean)
        .join(' · ')
      const read = jevRead(r)
      return (
        <Box key={`r-${r.id}`} flexDirection="column" width={inner}>
          <Box key="l1" flexDirection="row" columnGap={1}>
            <Box key="n" width={2} flexShrink={0}>
              <Text dimColor>{num.padStart(2)}</Text>
            </Box>
            <Box key="m" width={2} flexShrink={0}>
              <Text color={r.tone} bold>{mark(r, t)}</Text>
            </Box>
            <Box key="t" flexGrow={1} flexShrink={1}>
              <Text bold wrap="truncate">{self ? `${title(r)} (this session)` : title(r)}</Text>
            </Box>
            <Box key="a" width={7} flexShrink={0} justifyContent="flex-end">
              <Text dimColor>{age(now - r.since)}</Text>
            </Box>
            <Box key="b" width={9} flexShrink={0}>{!self ? <Button key="nu" label="Nudge" plain onPress={() => nudge($, r)} /> : <Text> </Text>}</Box>
          </Box>
          <Box key="l2" paddingLeft={5} flexDirection="column">
            <Text key="w" color={r.tone} wrap="truncate">{r.why}</Text>
            <Text key="f" dimColor wrap="truncate">{facts}</Text>
            {read ? <Text key="c" dimColor wrap="truncate">{read}</Text> : null}
          </Box>
        </Box>
      )
    })

    const ag = agreement(g)
    const jline =
      j.mode === 'off'
        ? 'Jev off (jevMode in /config)'
        : j.down
          ? `Jev ${j.mode}, not answering: ${j.down}`
          : [
              `Jev ${j.mode}${j.model ? ` (${j.model})` : ''}`,
              `${j.calls} call${j.calls === 1 ? '' : 's'} from here`,
              j.lat.length ? `p50 ${pct(j.lat, 50)}ms` : '',
              j.cost ? `$${j.cost.toFixed(4)}` : '',
              j.fails ? `${j.fails} failed` : '',
              lead ? 'this session leads' : `lead: ${leadName(rs)}`,
            ]
              .filter(Boolean)
              .join(' · ')
    const gline = g.length ? `Gate (shadow, this session): ${g.length} checked · Jev would allow ${ag.allows}, deny ${ag.denies}, defer ${g.filter(x => x.jev === 'defer').length} · agrees with what ran ${ag.n ? Math.round((ag.agree / ag.n) * 100) : 0}% of ${ag.n}` : ''
    const recentGate = [...g].reverse().slice(0, 5)

    return (
      <Box key="modder" flexDirection="column" rowGap={1} width={cols}>
        <Box key="h" flexDirection="row" columnGap={2} flexWrap="wrap">
          <Text key="t" bold>{head.join(' · ')}</Text>
          <Button key="lead" label="Lead from here" hotkey="l" plain onPress={() => elect($, Date.now(), true).then(() => undefined)} />
          <Button key="r" label="Refresh" hotkey="r" plain onPress={() => refresh($)} />
        </Box>
        <Box key="list" flexDirection="column" rowGap={1}>
          {list.length ? list : [<Text key="none" dimColor>No sessions yet. Every Claude Code session with this mod shows up here.</Text>]}
        </Box>
        <Box key="jev" flexDirection="column">
          <Text key="j" color={j.down ? 'warning' : 'subtle'}>{jline}</Text>
          {gline ? <Text key="g" dimColor>{gline}</Text> : null}
          {recentGate.map((x, i) => (
            <Text key={`g${i}`} dimColor wrap="truncate">
              {`  ${x.jev.padEnd(6)} ${x.what}  ran: ${x.core} · serves ${Math.round(x.serves * 100)}% · ${x.top || 'risk'} ${Math.round(x.risk * 100)}% · ${x.ms}ms`}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}
