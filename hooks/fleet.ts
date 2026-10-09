import type { Card, Health, Recent, Row } from '../types'
import { STATE_CHARS } from './jev'
import { rankOf } from './policy'

export const newCard = (id: string, root: string, now: number): Card => ({
  id,
  rev: 0,
  beat: now,
  root,
  repo: root.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? root,
  branch: '',
  model: '',
  state: 'idle',
  since: now,
  task: '',
  lastPrompt: '',
  doing: '',
  lastText: '',
  turns: 0,
  tools: 0,
  agents: 0,
  recent: [],
})

/** A change worth a new look: bumps `rev`. */
export const touch = (c: Card, patch: Partial<Card>, now: number): Card => ({
  ...c,
  ...patch,
  ...(patch.state && patch.state !== c.state ? { since: now } : {}),
  rev: c.rev + 1,
  beat: now,
})

const base = (p: string) => p.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? p
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** A tool call as one short line: `Edit login.tsx`, `$ npm test`. */
export function doing(tool: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '')
  if (tool === 'Bash' || tool === 'PowerShell') {
    return `$ ${clip(oneLine(s('command')), 60)}`
  }
  if (s('file_path') || s('notebook_path')) {
    return `${tool} ${base(s('file_path') || s('notebook_path'))}`
  }
  if (tool === 'Grep' || tool === 'Glob') {
    return `${tool} ${clip(s('pattern'), 40)}`
  }
  if (tool === 'WebFetch' || tool === 'WebSearch') {
    return `${tool} ${clip(s('url') || s('query'), 50)}`
  }
  if (tool === 'Agent' || tool === 'Task') {
    return `agent: ${clip(s('description') || s('prompt'), 50)}`
  }
  if (tool === 'AskUserQuestion') {
    const qs = o['questions']
    const q = Array.isArray(qs) && qs[0] && typeof qs[0] === 'object' ? String((qs[0] as Record<string, unknown>)['question'] ?? '') : ''
    return `asks: ${clip(q, 70)}`
  }
  return tool.replace(/^mcp__[^_]+__/, '')
}

/**
 * The recent transcript, newest last: whole messages (no redaction), dropping
 * the oldest until it fits Jev's window.
 */
export function recentOf(messages: readonly { role: 'user' | 'assistant'; text: string }[], keep = 12): Recent[] {
  const out: Recent[] = []
  let size = 0
  for (const m of [...messages].reverse()) {
    if (out.length >= keep) {
      break
    }
    const text = m.text.trim()
    if (!text) {
      continue
    }
    const room = STATE_CHARS - size
    if (room < 200) {
      break
    }
    // One huge message keeps its start and end rather than pushing everything else out.
    const half = Math.floor(room / 2) - 3
    const fit = text.length <= room ? text : `${text.slice(0, half)}\n…\n${text.slice(-half)}`
    out.unshift({ role: m.role, text: fit })
    size += fit.length
  }
  return out
}

/** Every live session, most urgent first; ties go to the most recently active. */
export function rows(cards: Card[], health: Record<string, Health>, now: number): Row[] {
  return cards
    .map(c => ({ ...c, health: health[c.id], ...rankOf(c, health[c.id], now) }))
    .filter(r => r.rank >= 0)
    .sort((a, b) => b.rank - a.rank || b.beat - a.beat)
}

export const age = (ms: number) =>
  ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** The glyph at the head of a row: a spinner while working, a mark otherwise. */
export function mark(r: Row, tick: number): string {
  if (r.state === 'working' && r.rank < 50) {
    return SPIN[tick % SPIN.length]!
  }
  // Single-width marks: ●, ○ and ▲ draw two cells wide in some console fonts and push the row.
  return r.state === 'error' ? '✗' : r.rank >= 80 ? '?' : r.rank >= 60 ? '!' : r.rank >= 50 ? '✓' : r.state === 'working' ? '›' : '·'
}

/** The session's folder, or its id where the folder is a drive root. */
export const name = (c: Card) => (/^[a-z]:?$/i.test(c.repo) || !c.repo ? `session ${c.id.slice(0, 6)}` : c.repo)

/** A short name for a session: its task, else its folder. */
export const title = (c: Card) => clip(oneLine(c.task) || name(c), 60)

const SIGNALS = [
  ['needs_you', 'needs you'],
  ['stuck', 'stuck'],
  ['off_track', 'off track'],
  ['done', 'done'],
] as const

/** Jev's read in a few words: the signals worth a look (≥25%), strongest first, at most two. */
export function jevRead(r: { rev: number; health?: Health }): string {
  const h = r.health
  if (!h) {
    return ''
  }
  const top = SIGNALS.map(([k, label]) => [label, h[k]] as const)
    .filter(([, p]) => p >= 0.25)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([label, p]) => `${label} ${Math.round(p * 100)}%`)
  const read = top.length ? top.join(' · ') : 'all clear'
  return `Jev: ${read}${h.rev !== r.rev ? ' · earlier read' : ''}`
}

/** Percentile of a sample, for the latency readout. */
export function pct(xs: number[], p: number): number {
  if (!xs.length) {
    return 0
  }
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}
