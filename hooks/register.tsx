import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { Card, GateEntry, Health, JevInfo, Row } from '../types'
import { age, doing, jevRead, mark, name, newCard, pct, recentOf, rows, title, touch } from './fleet'
import { jev, keyIn, Queue } from './jev'
import type { Decider } from './jev'
import { GATE_QUESTIONS, GONE_MS, HEALTH_QUESTIONS, NEEDS_YOU, gateState, gateVerdict, hardDeny, healthState, list, nudgeText } from './policy'
import type { Rules } from './policy'
import { GATE } from './policy'
import { ALL, EMPTY, PRESETS, targetOf, apply, describeStyle, frame, jsonIn, norm, parse, skinPrompt, themeFile, validOps } from './skin'
import { MIN_OUTCOMES, calibrate, curve, refused, remember, sparkline } from './learn'
import type { Calibration, Mind, Skin, SkinOp, SkinTarget, Thresholds } from '../types'

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
const skinAtom = atom({ plugin: 'modder', key: 'skin' } as const, EMPTY as Skin)
const viewAtom = atom({ plugin: 'modder', key: 'view' } as const, 'sessions')
const mindAtom = atom({ plugin: 'modder', key: 'mind' } as const, { curve: [], phrases: 0, skinBy: { code: 0, memory: 0, claude: 0, none: 0 }, said: [] } as Mind)

/** Tools the gate never asks about: they only read, or they always need the person. */
const QUIET_TOOLS = new Set(['mcp__modder__skin', 'mcp__modder__mind', 'AskUserQuestion', 'ExitPlanMode', 'Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'TaskList', 'TaskGet', 'ToolSearch', 'NotebookRead'])
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

// ── What it has learned ────────────────────────────────────────────────────
let skin: Skin = EMPTY
let history: Skin[] = []
let saved: Record<string, Skin> = {}
let phrases: Record<string, SkinOp[]> = {}
let calib: Calibration | undefined
/** Calls this session put to the person, by tool_use_id, and what they chose. */
const asking = new Set<string>()
const answered = new Map<string, 'yes' | 'no'>()
let resolvedSince = 0
/** The gate's thresholds: what the outcomes taught once there are enough, else the shipped ones. */
const thresholds = (): Thresholds => (calib?.ready ? calib.learned : GATE)

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
    if (cycle % 3 === 0) {
      const other = (await $.store.get('skin').catch(() => undefined)) as Skin | undefined
      if (other && typeof other === 'object' && 'parts' in other && JSON.stringify(other) !== JSON.stringify(skin)) {
        skin = other
        await update($, skinAtom, () => skin)
      }
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

async function shadowGate($: EngineInterface, tool: string, input: unknown, core: 'allow' | 'ask' | 'deny', id: string | undefined): Promise<void> {
  const cwd = card?.root ?? ''
  const at = await $.clock.now()
  const r = await ask($, 0, 10_000, 3_000, gateState(card?.recent ?? [], tool, input, cwd), GATE_QUESTIONS).catch(async (err: unknown) => {
    await writeDiag($, { gateError: String(err).slice(0, 200) })
    return undefined
  })
  await writeDiag($, { gateRuns: (diag['gateRuns'] as number) + 1 })
  const v = r ? gateVerdict(r.answers, thresholds()) : undefined
  const human = id ? answered.get(id) : undefined
  const entry: GateEntry = {
    ...(id ? { id } : {}),
    ...(human ? { human } : {}),
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

// ── Learning from outcomes ─────────────────────────────────────────────────

/** The person answered a prompt: mark the shadow entry, and relearn every few answers. */
async function resolved($: EngineInterface, id: string, human: 'yes' | 'no'): Promise<void> {
  answered.set(id, human)
  const log = await update($, gateLog, g => g.map(x => (x.id === id ? { ...x, human } : x)))
  if (card && dir) {
    await $.fs.write(`${dir}/gate/${card.id}.json`, JSON.stringify(log)).catch(() => undefined)
  }
  if (++resolvedSince >= 5) {
    await relearn($)
  }
}

/** Refit the gate to every outcome the fleet has seen, and redraw the Mind. */
async function relearn($: EngineInterface): Promise<Calibration | undefined> {
  resolvedSince = 0
  if (!dir) {
    return undefined
  }
  const files = await $.fs.list(`${dir}/gate`).catch(() => [])
  const logs = await Promise.all(files.filter(f => f.kind === 'file' && f.name.endsWith('.json')).map(f => readJson<GateEntry[]>($, `${dir}/gate/${f.name}`)))
  const all = logs.flatMap(l => (Array.isArray(l) ? l : [])).sort((a, b) => a.at - b.at)
  calib = calibrate(all, GATE, await $.clock.now())
  await $.store.set('calibration', calib).catch(() => undefined)
  await update($, mindAtom, m => ({ ...m, calibration: calib, curve: curve(all) }))
  return calib
}

// ── The skin ───────────────────────────────────────────────────────────────

/** Write the engine colours to the theme file Claude Code reloads live; switch to it when it holds any. */
async function writeTheme($: EngineInterface, s: Skin): Promise<string | undefined> {
  if (!home) {
    return undefined
  }
  const rows = await $.config.list().catch(() => [])
  const cur = rows.find(r => r.key === 'theme')
  const now = typeof cur?.value === 'string' ? cur.value : 'dark'
  const prev = ((await $.store.get('baseTheme').catch(() => undefined)) as string | undefined) ?? (now.startsWith('custom:') ? 'dark' : now)
  const file = themeFile(s, prev)
  await $.fs.write(`${home}/.claude/themes/modder.json`, JSON.stringify(file ?? { name: 'Modder', base: /light/.test(prev) ? 'light' : 'dark', overrides: {} }, null, 2)).catch(() => undefined)
  if (file && now !== 'custom:modder') {
    await $.store.set('baseTheme', now).catch(() => undefined)
    const r = await $.config.set({ key: 'theme', value: 'custom:modder' }).catch((err: unknown) => ({ deny: String(err) }))
    if ('deny' in r && r.deny) {
      return 'engine colours saved: pick "Modder" in /theme to see them'
    }
  }
  if (!file && now === 'custom:modder') {
    await $.config.set({ key: 'theme', value: prev }).catch(() => undefined)
  }
  return undefined
}

async function persistSkin($: EngineInterface): Promise<void> {
  await Promise.all([$.store.set('skin', skin), $.store.set('skinHistory', history.slice(-20)), $.store.set('skins', saved)]).catch(() => undefined)
  await update($, skinAtom, () => skin)
}

/**
 * One request to restyle the workspace, from the person (/skin) or from
 * Claude (its skin tool). Code reads it first; a phrase code cannot read goes
 * to Claude once, and what it meant is remembered so it parses free next time.
 */
async function restyle($: EngineInterface, text: string, given?: unknown): Promise<string[]> {
  let ops: SkinOp[] = []
  let by: keyof Mind['skinBy'] = 'code'
  if (given !== undefined) {
    ops = validOps(given)
    by = 'claude'
  } else {
    const remembered = !!phrases[norm(text)]
    const p = parse(text, phrases)
    ops = p.ops
    by = remembered ? 'memory' : 'code'
    for (const u of p.unknown) {
      const r = await $.model.complete({ model: 'haiku', prompt: skinPrompt(u, skin), maxTokens: 700, effort: 'low', timeoutMs: 20_000 }).catch(() => undefined)
      const got = r?.isAnswered ? validOps(jsonIn(r.text)) : []
      if (got.length) {
        ops.push(...got)
        phrases = remember(phrases, norm(u), got)
        by = 'claude'
      } else if (!ops.length) {
        by = 'none'
      }
    }
    if (by === 'claude') {
      await $.store.set('phrases', phrases).catch(() => undefined)
    }
  }
  const out = apply(skin, ops, history, saved)
  skin = out.skin
  history = out.history
  saved = out.saved
  const said = [...out.said]
  if (out.theme) {
    const r = await $.config.set({ key: 'theme', value: out.theme }).catch((err: unknown) => ({ deny: String(err) }))
    await $.store.set('baseTheme', out.theme).catch(() => undefined)
    if ('deny' in r && r.deny) said.push(`the theme stayed: ${r.deny}`)
  }
  if (ops.some(o => o.kind !== 'theme')) {
    const note = await writeTheme($, skin)
    if (note) said.push(note)
  }
  await persistSkin($)
  const line = said.length ? said.join(' · ') : `didn't catch "${text.slice(0, 60)}"`
  const m = await update($, mindAtom, x => ({ ...x, phrases: Object.keys(phrases).length, skinBy: { ...x.skinBy, [by]: x.skinBy[by] + 1 }, said: [...x.said, line].slice(-6) }))
  await $.store.set('skinBy', m.skinBy).catch(() => undefined)
  return said
}

async function openTab($: EngineInterface, tab: string): Promise<void> {
  await update($, viewAtom, () => tab)
  await $.ui.open({ id: PANE, title: 'Modder' })
}

// ── The pane's other two tabs ──────────────────────────────────────────────

const TABS = [
  ['sessions', 'Sessions', '1'],
  ['skin', 'Skin', '2'],
  ['mind', 'Mind', '3'],
] as const

function tabs($: EngineInterface, e: RenderInput<'Pane'>, view: string) {
  const { Box, Button, Text } = $.ui.resolve(e)
  return (
    <Box key="tabs" flexDirection="row" columnGap={2}>
      <Text key="logo" color="claude" bold>✻ modder</Text>
      {TABS.map(([id, label, key]) =>
        id === view ? (
          <Text key={`t-${id}`} color="claude" bold underline>{label}</Text>
        ) : (
          <Button key={`t-${id}`} label={label} hotkey={key} plain dimColor onPress={() => update($, viewAtom, () => id).then(() => undefined)} />
        ),
      )}
    </Box>
  )
}

const PART_LABEL: Record<SkinTarget, string> = {
  user: 'Your messages',
  assistant: 'Claude replies',
  tools: 'Tool calls',
  spinner: 'Spinner',
  notices: 'Notices',
  commands: 'Command output',
  questions: 'Questions',
  band: 'Attention band',
  panes: 'Panes',
}

async function skinPane($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const [s, m] = await Promise.all([read($, skinAtom), read($, mindAtom)])
  const cols = Math.max(48, Math.min(160, e.props.bodyColumns))
  const w = Math.max(22, Math.floor((cols - 6) / 3))
  const tokens = Object.entries(s.tokens ?? {})
  return (
    <Box key="skin" flexDirection="column" rowGap={1} width={cols}>
      {tabs($, e, 'skin')}
      <Box key="head" flexDirection="column">
        <Text key="n" bold>{s.name ? `Wearing ${s.name}` : Object.keys(s.parts).length || tokens.length ? 'A look of your own' : 'The plain look'}</Text>
        <Text key="h" dimColor wrap="truncate">Say it in words: /skin make tool calls teal · /skin overlay 🔒 on tool calls · /skin warmer · /skin sunset · /skin undo</Text>
      </Box>
      <Box key="parts" flexDirection="row" flexWrap="wrap" columnGap={1}>
        {ALL.map(t => {
          const st = s.parts[t]
          const f = frame(st) ?? {}
          return (
            <Box key={`p-${t}`} width={w} borderStyle={f.borderStyle ?? 'single'} borderColor={f.borderColor ?? 'inactive'} borderDimColor={!st} {...(f.backgroundColor ? { backgroundColor: f.backgroundColor } : {})} flexDirection="column" paddingX={1}>
              <Text key="l" bold color={st ? 'text' : 'inactive'} wrap="truncate">{`${st?.badge ? `${st.badge} ` : ''}${PART_LABEL[t]}`}</Text>
              <Text key="d" dimColor wrap="truncate">{st ? describeStyle(st) || 'styled' : 'as Claude draws it'}</Text>
            </Box>
          )
        })}
      </Box>
      {tokens.length ? (
        <Box key="tok" flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text key="l" dimColor>Engine colours</Text>
          {tokens.map(([k, v]) => (
            <Text key={`k-${k}`} color={v}>{`■ ${k}`}</Text>
          ))}
        </Box>
      ) : null}
      <Box key="looks" flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text key="l" dimColor>Looks</Text>
        {Object.keys(PRESETS).map(p => (
          <Button key={`l-${p}`} label={p} plain onPress={() => restyle($, p).then(() => undefined)} />
        ))}
      </Box>
      <Box key="act" flexDirection="row" columnGap={2}>
        <Button key="u" label="Undo" hotkey="u" plain onPress={() => restyle($, 'undo').then(() => undefined)} />
        <Button key="x" label="Plain" hotkey="x" plain onPress={() => restyle($, 'reset').then(() => undefined)} />
        {Object.keys(saved).map(n => (
          <Button key={`s-${n}`} label={`wear ${n}`} plain onPress={() => restyle($, `wear ${n}`).then(() => undefined)} />
        ))}
      </Box>
      {m.said.length ? (
        <Box key="said" flexDirection="column">
          {m.said.slice(-4).map((l, i) => (
            <Text key={`s${i}`} dimColor wrap="truncate">{`› ${l}`}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

const pc = (x: number) => `${Math.round(x * 100)}%`

function bar(x: number, of: number, width = 20): string {
  const f = Math.max(0, Math.min(width, Math.round((x / Math.max(1, of)) * width)))
  return '█'.repeat(f) + '░'.repeat(width - f)
}

const th = (t: Thresholds) => `allow: serves ≥ ${pc(t.allowServes)} & risk ≤ ${pc(t.allowRisk)}   deny: risk ≥ ${pc(t.denyRisk)} & serves ≤ ${pc(t.denyServes)}`

async function mindPane($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const [m, j, rs, g] = await Promise.all([read($, mindAtom), read($, jevAtom), read($, fleet), read($, gateLog)])
  const cols = Math.max(48, Math.min(160, e.props.bodyColumns))
  const c = m.calibration
  const n = c?.n ?? 0
  const by = m.skinBy
  const asked = g.filter(x => x.core === 'ask')
  return (
    <Box key="mind" flexDirection="column" rowGap={1} width={cols}>
      {tabs($, e, 'mind')}
      <Box key="fleet" flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text key="l" dimColor>Fleet</Text>
        {rs.length ? rs.map(r => <Text key={`f-${r.id}`} color={r.tone}>{`${mark(r, 0)} ${name(r)}`}</Text>) : [<Text key="none" dimColor>just this session</Text>]}
      </Box>
      <Box key="gate" flexDirection="column">
        <Text key="h" bold>The gate learns from how calls end</Text>
        {!c || !c.ready ? (
          <Text key="p" color="suggestion">{`${bar(n, MIN_OUTCOMES)} ${n}/${MIN_OUTCOMES} outcomes before it may retune itself`}</Text>
        ) : (
          <Text key="p" color="success">{`${bar(n, n)} fitted to ${n} outcomes · ${c.ran} ran · ${c.blocked} blocked`}</Text>
        )}
        <Text key="b" dimColor wrap="truncate">{`shipped  ${th(c?.base ?? GATE)}`}</Text>
        <Text key="a" color={c?.ready ? 'claude' : 'inactive'} wrap="truncate">{`learned  ${th(c?.learned ?? GATE)}`}</Text>
        {c ? (
          <Text key="s" dimColor wrap="truncate">{`on the evidence: shipped settles ${c.before.allows + c.before.denies} (${c.before.wrong} wrong) · learned settles ${c.after.allows + c.after.denies} (${c.after.wrong} wrong)`}</Text>
        ) : null}
        <Text key="q" dimColor wrap="truncate">{`${asked.length} call${asked.length === 1 ? '' : 's'} put to you this session · ${asked.filter(x => x.human).length} answered · a learned threshold may never get a known outcome wrong`}</Text>
      </Box>
      <Box key="curve" flexDirection="column">
        <Text key="h" bold>Agreement with outcomes</Text>
        <Text key="c" color="claude">{m.curve.length ? `${sparkline(m.curve, Math.min(48, cols - 12))}  ${pc(m.curve.at(-1) ?? 0)} now` : 'no decided calls with an outcome yet'}</Text>
      </Box>
      <Box key="skin" flexDirection="column">
        <Text key="h" bold>The skin learns your words</Text>
        <Text key="b" dimColor wrap="truncate">{`read by code ${by.code} · from memory ${by.memory} · by Claude ${by.claude} · missed ${by.none} · ${m.phrases} phrase${m.phrases === 1 ? '' : 's'} learned`}</Text>
      </Box>
      <Text key="jev" dimColor wrap="truncate">{j.mode === 'off' ? 'Jev off' : `Jev ${j.mode} · ${j.calls} calls · ${j.lat.length ? `p50 ${pct(j.lat, 50)}ms · ` : ''}${j.cost.toFixed(4)}${j.down ? ` · ${j.down}` : ''}`}</Text>
      <Box key="act" flexDirection="row" columnGap={2}>
        <Button key="r" label="Relearn now" hotkey="r" plain onPress={() => relearn($).then(() => undefined)} />
      </Box>
    </Box>
  )
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
    await $.command.register({
      name: 'skin',
      description: 'Restyle the workspace in plain words: "make tool calls teal", "overlay 🔒 on tool calls", "sunset", "warmer", "undo"',
      argumentHint: '<what you want it to look like>',
      immediate: true,
    })
    await $.tool.register({
      name: 'skin',
      description:
        'Restyle the Claude Code workspace the person is looking at. Use when they ask to change how it looks (colours, borders, overlays, a mood, a named look). Pass their words as request, or precise ops. Parts: user, assistant, tools, spinner, notices, commands, questions, band, panes. Looks: ' +
        Object.keys(PRESETS).join(', ') +
        '. Returns what changed.',
      inputSchema: {
        type: 'object',
        properties: {
          request: { type: 'string', description: 'What they want, in their words: "make tool calls teal and give them a lock badge"' },
          ops: { type: 'array', description: 'Optional precise ops instead of words, as the skin schema defines them', items: { type: 'object' } },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'mind',
      description: 'What the modder orchestrator knows right now: every open Claude Code session and what it needs, what the permission gate has learned from outcomes, and the current skin. Use to answer "what are my other sessions doing" or "what have you learned".',
      inputSchema: { type: 'object', properties: {} },
    })
    const [sk, hi, sv, ph, ca, sb] = await Promise.all(['skin', 'skinHistory', 'skins', 'phrases', 'calibration', 'skinBy'].map(k => $.store.get(k).catch(() => undefined)))
    if (sk && typeof sk === 'object' && 'parts' in sk) skin = sk as Skin
    if (Array.isArray(hi)) history = hi as Skin[]
    if (sv && typeof sv === 'object') saved = sv as Record<string, Skin>
    if (ph && typeof ph === 'object') phrases = ph as Record<string, SkinOp[]>
    if (ca && typeof ca === 'object' && 'learned' in ca) calib = ca as Calibration
    await update($, skinAtom, () => skin)
    await update($, mindAtom, m => ({ ...m, calibration: calib, phrases: Object.keys(phrases).length, ...(sb && typeof sb === 'object' && 'code' in sb ? { skinBy: sb as Mind['skinBy'] } : {}) }))
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
    await relearn($).catch(() => undefined)
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
      const res = await next(e)
      const id = e.tool_use_id
      if (id && asking.has(id)) {
        asking.delete(id)
        await resolved($, id, refused(res) ? 'no' : 'yes')
      }
      return res
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
      const v = r ? gateVerdict(r.answers, thresholds()) : undefined
      if (v?.verdict === 'allow') {
        return { decision: 'allow', reason: `Jev${calib?.ready ? ' (learned thresholds)' : ''}: serves the request (${Math.round(v.serves * 100)}%), every risk low` }
      }
      if (v?.verdict === 'deny') {
        return { decision: 'deny', reason: `Jev: likely ${v.top} (${Math.round(v.risk * 100)}%) and not what you asked for` }
      }
    }
    if (real && res.decision === 'ask' && e.tool_use_id) {
      asking.add(e.tool_use_id)
    }
    if (real && e.agentId === undefined && res.decision === 'ask' && e.tool !== 'AskUserQuestion' && card) {
      await save($, { state: 'asking', doing: `permission: ${doing(e.tool, e.input)}` })
    }
    if (asked && mode === 'shadow') {
      void shadowGate($, e.tool, e.input, res.decision, e.tool_use_id).catch(() => undefined)
    }
    return res
  })

  on('command.run', { command: 'modder' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().split(/\s+/)
    if (verb === 'close') {
      await $.ui.close({ id: PANE })
      return {}
    }
    if (verb === 'skin' || verb === 'mind') {
      await openTab($, verb)
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
    await openTab($, 'sessions')
    return {}
  })

  on('command.run', { command: 'skin' }, async ($, e) => {
    const text = e.args.trim()
    if (!text) {
      await openTab($, 'skin')
      return {}
    }
    const said = await restyle($, text)
    $.ui.toast(said.length ? `✻ ${said.join(' · ')}` : `✻ didn't catch that: try "make tool calls teal" or "sunset"`)
    return {}
  })

  // Claude's own hands on the workspace.
  on('tool.call', { tool: 'mcp__modder__skin' }, async ($, e) => {
    const input = e as unknown as { request?: unknown; ops?: unknown }
    const req = typeof input.request === 'string' ? input.request : ''
    const said = Array.isArray(input.ops) && input.ops.length ? await restyle($, req || 'ops from Claude', input.ops) : req ? await restyle($, req) : []
    const text = said.length ? `Done: ${said.join('; ')}. Current skin: ${JSON.stringify({ name: skin.name, parts: skin.parts, tokens: skin.tokens ?? {} })}` : 'Nothing changed: the request named no part, colour or look the skin understood.'
    return { result: text }
  }).catch(() => ({ result: 'The modder tool failed; nothing changed.' }))

  on('tool.call', { tool: 'mcp__modder__mind' }, async ($, e) => {
    const rs = await read($, fleet)
    const m = await read($, mindAtom)
    const text = JSON.stringify({
      sessions: rs.map(r => ({ title: title(r), repo: r.repo, branch: r.branch, state: r.state, why: r.why, needsYou: r.rank >= NEEDS_YOU, doing: r.doing })),
      gate: m.calibration ? { outcomes: m.calibration.n, ready: m.calibration.ready, shipped: m.calibration.base, learned: m.calibration.learned, before: m.calibration.before, after: m.calibration.after } : 'no outcomes yet',
      agreement: m.curve.at(-1),
      skin: { name: skin.name, parts: skin.parts, tokens: skin.tokens ?? {}, phrasesLearned: m.phrases, understoodBy: m.skinBy },
    })
    return { result: text }
  }).catch(() => ({ result: 'The modder tool failed; nothing changed.' }))

  // The skin on everything the engine draws: a frame, a fill, an overlay badge.
  on(
    'ui.render',
    { component: ['UserMessage', 'AssistantMessage', 'ToolUse', 'ToolResult', 'ToolGroup', 'ToolProgress', 'Spinner', 'InfoNotice', 'TurnDuration', 'CommandOutput', 'AskUserQuestion'] },
    async ($, e, next) => {
        const t = targetOf(e.component)
        const st = t ? (await read($, skinAtom)).parts[t] : undefined
        const f = frame(st)
        if (!st || !f) {
          return next(e)
        }
        const { Box, Text } = $.ui.resolve(e)
        const inner = await next(e)
        if (st.hidden) {
          return <Box key="skin" display="none">{inner}</Box>
        }
        if (!st.badge) {
          return <Box key="skin" {...f}>{inner}</Box>
        }
        return (
          <Box key="skin" {...f} flexDirection="row" columnGap={1}>
            <Text key="badge" color={st.badgeColor ?? st.border ?? 'claude'} bold>{st.badge}</Text>
            <Box key="in" flexDirection="column" flexGrow={1} flexShrink={1}>{inner}</Box>
          </Box>
        )
    },
  )

  // Footer: `fleet 3 · 1 needs you`, only when there is more than this session.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const rs = await read($, fleet)
    const sk = await read($, skinAtom)
    if (rs.length < 2) {
      return sk.name ? next({ ...e, props: { ...e.props, modes: [...e.props.modes, `✻ ${sk.name}`] } }) : next(e)
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
    const bf = frame((await read($, skinAtom)).parts.band) ?? {}
    // One row: who, why, how long; then the ways through.
    return (
      <Box key="modder-band" {...bf} flexDirection="row" columnGap={2}>
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
    const view = await read($, viewAtom)
    if (view === 'skin') {
      return skinPane($, e)
    }
    if (view === 'mind') {
      return mindPane($, e)
    }
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
        {tabs($, e, 'sessions')}
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
