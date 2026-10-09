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
    }
  }
}
