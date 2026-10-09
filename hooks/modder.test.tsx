import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import type { Card, Health, Row } from '../types'
import { doing, newCard, recentOf, rows, touch } from './fleet'
import { JEV_MODEL, JEV_URL, Queue, STATE_CHARS, jev } from './jev'
import type { Fetch } from './jev'
import { GATE_QUESTIONS, HEALTH_QUESTIONS, gateVerdict, hardDeny, nudgeText, rankOf } from './policy'
import { agreement } from './register'

const NOW = 10_000_000
const card = (over: Partial<Card>): Card => ({ ...newCard('s1', 'C:/work/shop', NOW - 5000), beat: NOW - 1000, ...over })
const hl = (over: Partial<Health>): Health => ({ at: NOW, rev: 0, needs_you: 0, off_track: 0, stuck: 0, done: 0, progress: 0.5, ms: 150, ...over })
const rules = { protect: ['~/.ssh/', '~/.api-keys'], denyPushFrom: ['C:/old/clone'] }

test('hard rules: protected paths and pushes from a denied clone never run, whatever Jev says', () => {
  expect(hardDeny('Read', { file_path: 'C:\\Users\\me\\.api-keys\\openrouter.txt' }, 'C:/work', rules, 'C:/Users/me')).toMatch(/protected/)
  expect(hardDeny('Bash', { command: 'cat ~/.ssh/id_rsa' }, 'C:/work', rules, 'C:/Users/me')).toMatch(/protected/)
  expect(hardDeny('Bash', { command: 'git push origin main' }, 'C:/old/clone/app', rules, 'C:/Users/me')).toMatch(/push/)
  expect(hardDeny('Bash', { command: 'git push origin main' }, 'C:/work/shop', rules, 'C:/Users/me')).toBeUndefined()
  expect(hardDeny('Edit', { file_path: 'C:/work/shop/src/a.ts' }, 'C:/work/shop', rules, 'C:/Users/me')).toBeUndefined()
  expect(hardDeny('PowerShell', { command: 'Get-Content C:\\Users\\me\\.api-keys\\x.txt' }, 'C:/work', rules, 'C:/Users/me')).toMatch(/protected/)
  expect(hardDeny('Bash', { command: 'cat $HOME/.ssh/config' }, 'C:/work', rules, 'C:/Users/me')).toMatch(/protected/)
  // Naming the setting in a command is not touching the folder.
  expect(hardDeny('Bash', { command: `node -e "set({ protect: '/.ssh/,/.api-keys' })"` }, 'C:/work', rules, 'C:/Users/me')).toBeUndefined()
})

test('gate: allow only when it serves and every risk is low; deny only when a risk is high and it does not serve', () => {
  const low = { destroys: 0.02, leaks: 0.01, secrets: 0.03, outward: 0.05, scope: 0.04, system: 0.01, steered: 0.02 }
  expect(gateVerdict({ serves: 0.9, ...low }).verdict).toBe('allow')
  expect(gateVerdict({ serves: 0.9, ...low, outward: 0.2 }).verdict).toBe('defer')
  expect(gateVerdict({ serves: 0.2, ...low, destroys: 0.85 }).verdict).toBe('deny')
  expect(gateVerdict({ serves: 0.2, ...low, destroys: 0.85 }).top).toBe('destroys')
  // High risk the user asked for: never Jev's to deny.
  expect(gateVerdict({ serves: 0.9, ...low, destroys: 0.85 }).verdict).toBe('defer')
  // A missing answer counts as risky, so it can't slip through as an allow.
  expect(gateVerdict({ serves: 0.9 }).verdict).toBe('defer')
  expect(Object.keys(GATE_QUESTIONS)).toHaveLength(8)
})

test('attention: asking beats error beats what Jev reads, and a read only counts for its revision', () => {
  expect(rankOf(card({ state: 'asking', doing: 'permission: $ git push' }), undefined, NOW).rank).toBe(100)
  expect(rankOf(card({ state: 'error' }), undefined, NOW).rank).toBe(90)
  const idle = card({ state: 'idle', rev: 3 })
  expect(rankOf(idle, hl({ rev: 3, needs_you: 0.9 }), NOW).why).toBe('waiting on your answer')
  expect(rankOf(idle, hl({ rev: 2, needs_you: 0.9 }), NOW).rank).toBe(0)
  expect(rankOf(idle, hl({ rev: 3, done: 0.8 }), NOW).why).toBe('done, ready for review')
  expect(rankOf(card({ state: 'working', rev: 1 }), hl({ rev: 1, stuck: 0.85 }), NOW).why).toBe('looks stuck')
  expect(rankOf(card({ beat: NOW - 60_000 }), undefined, NOW).rank).toBe(-1)
  const rs = rows([card({ id: 'a', state: 'working' }), card({ id: 'b', state: 'asking' }), card({ id: 'c', state: 'ended' })], {}, NOW)
  expect(rs.map(r => r.id)).toEqual(['b', 'a'])
  expect(nudgeText('looks stuck')).toMatch(/different approach/)
})

test('cards: a state change resets its clock; tools read as one short line', () => {
  const c = touch(card({ state: 'idle', since: 1 }), { state: 'working' }, NOW)
  expect(c.since).toBe(NOW)
  expect(c.rev).toBe(1)
  expect(touch(c, { doing: 'x' }, NOW + 5).since).toBe(NOW)
  expect(doing('Edit', { file_path: 'C:\\work\\shop\\src\\login.tsx' })).toBe('Edit login.tsx')
  expect(doing('Bash', { command: 'npm   test\n --watch' })).toBe('$ npm test --watch')
  expect(doing('AskUserQuestion', { questions: [{ question: 'Postgres or SQLite?' }] })).toBe('asks: Postgres or SQLite?')
})

test('recent: whole messages, newest last, oldest dropped to fit the window', () => {
  const big = 'x'.repeat(STATE_CHARS)
  const r = recentOf([
    { role: 'user', text: 'first' },
    { role: 'assistant', text: big },
    { role: 'user', text: 'latest ask' },
  ])
  expect(r.at(-1)?.text).toBe('latest ask')
  expect(r.some(m => m.text === 'first')).toBe(false)
  expect(r.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(STATE_CHARS)
  expect(recentOf([{ role: 'user', text: 'secret=abc keep me' }])[0]?.text).toBe('secret=abc keep me')
})

test('jev client: posts the pinned model and typed questions, reads probabilities back', async () => {
  const sent: { url: string; body: string; auth: string }[] = []
  const fetch: Fetch = async (url, init) => {
    sent.push({ url, body: init.body, auth: init.headers['Authorization'] ?? '' })
    return {
      status: 200,
      ok: true,
      text: JSON.stringify({
        model: 'jev-1.13.0',
        answers: Object.fromEntries(Object.keys(HEALTH_QUESTIONS).map(k => [k, { type: 'noul', noul: k === 'stuck' ? 0.91 : 0.1 }])),
        usage: { input_tokens: 700, cost: 0.00003 },
      }),
    }
  }
  let t = 0
  const d = jev(fetch, 'k', () => (t += 120), () => new Promise(() => undefined))
  const r = await d.decide({ task: 'x' }, HEALTH_QUESTIONS, 1000)
  expect(sent[0]?.url).toBe(JEV_URL)
  expect(JSON.parse(sent[0]!.body).model).toBe(JEV_MODEL)
  expect(JSON.parse(sent[0]!.body).questions.stuck.type).toBe('noul')
  expect(sent[0]?.auth).toBe('Bearer k')
  expect(r.answers['stuck']).toBe(0.91)
  expect(r.cost).toBe(0.00003)

  const bad = jev(async () => ({ status: 401, ok: false, text: 'invalid key' }), 'k', () => 0, () => new Promise(() => undefined))
  let msg = ''
  await bad.decide({}, HEALTH_QUESTIONS, 1000).catch((e: Error) => (msg = e.message))
  expect(msg).toMatch(/401/)
  expect(msg).not.toMatch(/Bearer/)
})

test('queue: one call at a time, the gate first, stale jobs dropped', async () => {
  let now = 0
  const q = new Queue(() => now)
  const order: string[] = []
  let release = () => undefined as void
  const first = q.add(1, 1000, () => new Promise<string>(res => (release = () => res('slow'))).then(x => (order.push('health-1'), x)))
  const late = q.add(1, 10, async () => (order.push('stale'), 'stale'))
  const health = q.add(1, 1000, async () => (order.push('health-2'), 'h'))
  const gate = q.add(0, 1000, async () => (order.push('gate'), 'g'))
  now = 50
  release()
  expect(await first).toBe('slow')
  expect(await gate).toBe('g')
  expect(await health).toBe('h')
  expect(await late).toBeUndefined()
  expect(order).toEqual(['health-1', 'gate', 'health-2'])
})

test('shadow agreement counts only the calls Jev took a side on', () => {
  const e = (jevV: 'allow' | 'deny' | 'defer' | 'error', core: 'allow' | 'ask' | 'deny') => ({ at: 0, tool: 'Bash', what: '', core, jev: jevV, serves: 0, risk: 0, top: '', ms: 0, cost: 0 })
  expect(agreement([e('allow', 'allow'), e('allow', 'ask'), e('deny', 'ask'), e('defer', 'allow'), e('error', 'allow')])).toEqual({ n: 3, agree: 2, allows: 2, denies: 1 })
})

// ── The surfaces ──────────────────────────────────────────────────────────

function host(on: On) {
  const toasts: string[] = []
  const files = new Map<string, string>()
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.write', ($, e) => {
    files.set(e.path.replace(/\\/g, '/'), e.text)
    return { value: undefined }
  })
  return { toasts, files }
}

const seeded: Row[] = rows(
  [
    card({ id: 'me', task: 'this one', state: 'working' }),
    card({ id: 'b', task: 'Ship the billing page', repo: 'shop', branch: 'billing', state: 'asking', doing: 'permission: $ git push origin billing', turns: 4, tools: 31 }),
    card({ id: 'c', task: 'Refactor auth', state: 'idle', rev: 7, turns: 2, tools: 12 }),
  ],
  { c: hl({ rev: 7, done: 0.86 }) },
  NOW,
)

function seed(on: On) {
  on('state.get', ($, e, next) =>
    e.key === 'fleet' ? { value: { value: seeded, version: 1 } } : e.key === 'me' ? { value: { value: 'me', version: 1 } } : next(e),
  )
}

const pane = { title: 'Sessions', isFocused: true, bodyColumns: 110, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the pane lists every session, the one that needs you first, with a way to nudge it`, async ($, on) => {
    host(on)
    seed(on)
    const ui = await $.ui.mount({ plugin: 'modder', surface, component: 'Pane', requestId: 'modder', props: pane })
    expect(await ui.find({ text: /3 sessions · 1 working · 2 need you/ })).toBeDefined()
    expect(await ui.find({ text: /Ship the billing page/ })).toBeDefined()
    expect(await ui.find({ text: /permission: \$ git push origin billing/ })).toBeDefined()
    expect(await ui.find({ text: /done, ready for review/ })).toBeDefined()
    expect(await ui.find({ text: /\(this session\)/ })).toBeDefined()
    expect(await ui.find({ text: /Jev: done 86%/ })).toBeDefined()
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn.indexOf('Ship the billing page')).toBeLessThan(drawn.indexOf('Refactor auth'))
    expect(await ui.find({ key: 'nu' })).toBeDefined()
  })
}

test('the band above the prompt names the other session that most needs you', async ($, on) => {
  host(on)
  seed(on)
  const ui = await $.ui.mount({
    plugin: 'modder',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} },
  })
  expect(await ui.find({ text: /^shop$/ })).toBeDefined()
  expect(await ui.find({ text: /permission: \$ git push origin billing/ })).toBeDefined()
  expect(await ui.find({ key: 'x' })).toBeDefined()
})
