/**
 * The decider: typed yes/no questions over a state, answered with
 * probabilities. Jev (TypeSafe System One) through OpenRouter is the one
 * implementation today; the policy code only sees `Decider`, so another
 * (TypeSafe direct, a local model) slots in without touching a threshold.
 */

export type Noul = { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
export type Questions = Record<string, Noul>
/** Each question's probability of yes. */
export type Answers = Record<string, number>
export type Decision = { answers: Answers; model: string; ms: number; cost: number; tokens: number }

export interface Decider {
  decide(state: unknown, questions: Questions, timeoutMs: number): Promise<Decision>
}

/** What `$.http.fetch` gives back, so the client is testable without a network. */
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; ok: boolean; text: string }>

export const JEV_URL = 'https://openrouter.ai/api/v1/systemone'
/** Pinned: the thresholds are tuned against this release. */
export const JEV_MODEL = 'typesafe/jev-1.13'
/** Jev's window is 32k tokens for state and questions; ~3.5 chars a token, with room for the questions. */
export const STATE_CHARS = 90_000

export class JevError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export function jev(fetch: Fetch, key: string, now: () => number, sleep: (ms: number) => Promise<void>): Decider {
  return {
    async decide(state, questions, timeoutMs) {
      const started = now()
      const body = JSON.stringify({ model: JEV_MODEL, state, questions })
      const call = fetch(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'claude-modder' },
        body,
      })
      const timer = sleep(timeoutMs).then((): never => {
        throw new JevError(`no answer in ${timeoutMs}ms`, 0)
      })
      const res = await Promise.race([call, timer])
      if (!res.ok) {
        // The body names the problem (422 names the field); never echo the request, it holds the key's header.
        throw new JevError(`Jev ${res.status}: ${res.text.slice(0, 160)}`, res.status)
      }
      const json = JSON.parse(res.text) as {
        model?: string
        answers?: Record<string, { noul?: number }>
        usage?: { input_tokens?: number; cost?: number }
      }
      const answers: Answers = {}
      for (const id of Object.keys(questions)) {
        const p = json.answers?.[id]?.noul
        if (typeof p !== 'number') {
          throw new JevError(`Jev left "${id}" unanswered`, 200)
        }
        answers[id] = p
      }
      return { answers, model: json.model ?? JEV_MODEL, ms: now() - started, cost: json.usage?.cost ?? 0, tokens: json.usage?.input_tokens ?? 0 }
    },
  }
}

/**
 * Jev serves one account's calls one at a time (observed ~100ms apart), so
 * every call goes through one queue: the permission gate first, then the
 * orchestrator's checks. A job waiting too long is dropped, not run late.
 */
export type Priority = 0 | 1 | 2
type Job = { pri: Priority; seq: number; deadline: number; run: () => Promise<void>; drop: () => void }

export class Queue {
  private jobs: Job[] = []
  private busy = false
  private seq = 0

  constructor(private readonly now: () => number) {}

  get size(): number {
    return this.jobs.length
  }

  /** Runs `fn` when its turn comes, or resolves undefined once `maxWaitMs` passes first. */
  add<T>(pri: Priority, maxWaitMs: number, fn: () => Promise<T>): Promise<T | undefined> {
    return new Promise(resolve => {
      this.jobs.push({
        pri,
        seq: this.seq++,
        deadline: this.now() + maxWaitMs,
        run: () => fn().then(resolve, () => resolve(undefined)),
        drop: () => resolve(undefined),
      })
      this.jobs.sort((a, b) => a.pri - b.pri || a.seq - b.seq)
      void this.pump()
    })
  }

  private async pump(): Promise<void> {
    if (this.busy) {
      return
    }
    this.busy = true
    try {
      for (let job = this.jobs.shift(); job; job = this.jobs.shift()) {
        if (this.now() > job.deadline) {
          job.drop()
          continue
        }
        await job.run()
      }
    } finally {
      this.busy = false
    }
  }
}

/**
 * The key in a key file: the bare key, or the last OpenRouter key in a file
 * that holds more (a pasted snippet). Anything else is refused rather than
 * sent as a header, where an error would echo it.
 */
export function keyIn(text: string): string | undefined {
  const found = text.match(/sk-or-[A-Za-z0-9_-]{20,}/g)
  if (found?.length) {
    return found.at(-1)
  }
  const t = text.trim()
  return t && !/\s/.test(t) ? t : undefined
}
