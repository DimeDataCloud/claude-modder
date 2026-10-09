/** What a session is doing, as its own mod reports it. */
export type SessionState = 'working' | 'asking' | 'idle' | 'error' | 'ended'

/** One message of a session's recent transcript, as the orchestrator reads it. */
export type Recent = { role: 'user' | 'assistant'; text: string }

/**
 * A session's card: every full session running the mod writes its own to
 * `~/.claude-modder/sessions/<id>.json`; the orchestrator reads them all.
 */
export type Card = {
  id: string
  /** Bumped on every change the orchestrator should look at again. */
  rev: number
  /** Epoch ms of the last write: a card 45s old is a session that went away. */
  beat: number
  pid?: number
  root: string
  repo: string
  branch: string
  model: string
  state: SessionState
  /** Epoch ms the state began. */
  since: number
  /** The first prompt: what the session is for. */
  task: string
  lastPrompt: string
  /** What it is doing right now (`Edit login.tsx`), or what it asks. */
  doing: string
  /** The tail of the last answer. */
  lastText: string
  turns: number
  tools: number
  /** Subagents running inside it now. */
  agents: number
  ctxPct?: number
  /** The recent transcript, newest last, sent to Jev whole (capped only to fit its window). */
  recent: Recent[]
}

/** Jev's read of one session (probabilities 0..1), from the orchestrator. */
export type Health = {
  at: number
  rev: number
  needs_you: number
  off_track: number
  stuck: number
  done: number
  progress: number
  ms: number
}

/** A row of the fleet: a card, what Jev made of it, and where it ranks. */
export type Row = Card & { health?: Health; rank: number; why: string; tone: Tone }

export type Tone = 'error' | 'warning' | 'suggestion' | 'success' | 'claude' | 'inactive'

/** One shadow verdict of the permission gate. */
export type GateEntry = {
  at: number
  tool: string
  what: string
  /** What the session actually decided. */
  core: 'allow' | 'ask' | 'deny'
  /** What Jev's policy would have decided. */
  jev: 'allow' | 'deny' | 'defer' | 'error'
  serves: number
  risk: number
  /** The risk question that scored highest. */
  top: string
  ms: number
  cost: number
  /** The call's tool_use_id, so its outcome can be matched to it. */
  id?: string
  /** For a call put to the person: what they chose, once the call resolved. */
  human?: 'yes' | 'no'
}

export type JevInfo = {
  mode: 'off' | 'shadow' | 'enforce'
  /** Why Jev is not answering, when it is not. */
  down?: string
  calls: number
  fails: number
  cost: number
  /** Recent latencies, ms. */
  lat: number[]
  model?: string
}

// ── The skin ─────────────────────────────────────────────────────────────

/** A part of the workspace a skin paints. */
export type SkinTarget = 'user' | 'assistant' | 'tools' | 'spinner' | 'notices' | 'commands' | 'questions' | 'band' | 'panes' | 'footer'

/** How one part is drawn: colours are #rrggbb or a theme key. */
export type SkinStyle = {
  border?: string
  borderStyle?: 'single' | 'double' | 'round' | 'bold' | 'singleDouble' | 'doubleSingle' | 'classic' | 'arrow'
  borderDim?: boolean
  bg?: string
  /** A short overlay drawn on the part's first row: an emoji, a word. */
  badge?: string
  badgeColor?: string
  padX?: number
  /** Spinner and notices only. */
  hidden?: boolean
}

export type SkinOp =
  | { kind: 'set'; targets: SkinTarget[]; style: SkinStyle }
  | { kind: 'clear'; targets: SkinTarget[]; keys: (keyof SkinStyle)[] }
  | { kind: 'tune'; targets: SkinTarget[]; warm?: number; light?: number; sat?: number }
  | { kind: 'token'; key: string; value: string }
  | { kind: 'preset'; name: string }
  | { kind: 'theme'; value: string }
  | { kind: 'save'; name: string }
  | { kind: 'load'; name: string }
  | { kind: 'undo' }
  | { kind: 'reset' }

export type Skin = {
  parts: Partial<Record<SkinTarget, SkinStyle>>
  /** Engine colour tokens, written to ~/.claude/themes/modder.json. */
  tokens?: Record<string, string>
  name?: string
  rev: number
}

// ── What the mod learns ──────────────────────────────────────────────────

/** Gate thresholds: the shipped ones, or what the outcomes taught. */
export type Thresholds = { allowServes: number; allowRisk: number; denyRisk: number; denyServes: number }

export type Calibration = {
  /** Calls with a known outcome the thresholds were fitted to. */
  n: number
  ran: number
  blocked: number
  base: Thresholds
  learned: Thresholds
  /** On the labelled calls: how many each would settle, and how many it would get wrong. */
  before: { allows: number; denies: number; wrong: number }
  after: { allows: number; denies: number; wrong: number }
  /** Too few outcomes yet: the shipped thresholds stand. */
  ready: boolean
  at: number
}

/** What the Mind view draws. */
export type Mind = {
  calibration?: Calibration
  /** Rolling share of the gate's verdicts that matched the outcome, oldest first. */
  curve: number[]
  /** Phrases the skin learned from Claude, so they parse for free next time. */
  phrases: number
  /** Skin requests: read by code, by memory, by Claude, not understood. */
  skinBy: { code: number; memory: number; claude: number; none: number }
  /** The last few things the skin did, newest last. */
  said: string[]
}

declare module 'claude-code' {
  interface PluginState {
    modder: {
      fleet: Row[]
      me: string
      lead: boolean
      tick: number
      jev: JevInfo
      gate: GateEntry[]
      /** The band above the prompt was dismissed for this attention key. */
      hush: string
      skin: Skin
      /** Which tab of the pane: sessions, skin or mind. */
      view: string
      mind: Mind
    }
  }
}
