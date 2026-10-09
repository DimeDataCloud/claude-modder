import type { Calibration, GateEntry, SkinOp, Thresholds } from '../types'

/**
 * What the mod learns, and how it is held to account. The gate starts on the
 * thresholds in policy.ts; every call it shadowed then resolves to an outcome
 * (it ran, or it was blocked, by your rules or by your click), and those
 * outcomes refit the thresholds. The one rule of the fit: on the evidence, a
 * learned threshold never settles a call the other way from how it ended.
 * It may only become more useful, never less safe, and with too few outcomes
 * it changes nothing.
 */

/** Outcomes needed before a fit replaces the shipped thresholds. */
export const MIN_OUTCOMES = 20

/** How far a fit may move: never laxer than these, whatever the evidence. */
export const FLOOR = { allowServes: 0.5, allowRisk: 0.3, denyRisk: 0.5, denyServes: 0.5 } as const

/** How a shadowed call ended: it ran, or it did not. Unknown while a prompt is open. */
export function outcome(e: GateEntry): 'ran' | 'blocked' | undefined {
  if (e.core === 'allow') return 'ran'
  if (e.core === 'deny') return 'blocked'
  return e.human === 'yes' ? 'ran' : e.human === 'no' ? 'blocked' : undefined
}

export function verdictWith(serves: number, risk: number, t: Thresholds): 'allow' | 'deny' | 'defer' {
  return serves >= t.allowServes && risk <= t.allowRisk ? 'allow' : risk >= t.denyRisk && serves <= t.denyServes ? 'deny' : 'defer'
}

function score(xs: { serves: number; risk: number; out: 'ran' | 'blocked' }[], t: Thresholds) {
  let allows = 0
  let denies = 0
  let wrong = 0
  for (const x of xs) {
    const v = verdictWith(x.serves, x.risk, t)
    if (v === 'allow') {
      allows++
      if (x.out === 'blocked') wrong++
    } else if (v === 'deny') {
      denies++
      if (x.out === 'ran') wrong++
    }
  }
  return { allows, denies, wrong }
}

const steps = (from: number, to: number, by: number) => {
  const out: number[] = []
  for (let x = from; x <= to + 1e-9; x += by) out.push(Math.round(x * 100) / 100)
  return out
}

/**
 * Refit the thresholds to the outcomes. Allow and deny are fitted apart: each
 * picks, among the cut-offs that get no labelled call wrong, the one that
 * settles the most, and on a tie the strictest. A side with no such cut-off
 * keeps the shipped one.
 */
export function calibrate(entries: readonly GateEntry[], base: Thresholds, now: number): Calibration {
  const xs = entries
    .filter(e => e.jev !== 'error')
    .map(e => ({ serves: e.serves, risk: e.risk, out: outcome(e) }))
    .filter((x): x is { serves: number; risk: number; out: 'ran' | 'blocked' } => x.out !== undefined)
  const ran = xs.filter(x => x.out === 'ran').length
  const blocked = xs.length - ran
  const before = score(xs, base)
  const ready = xs.length >= MIN_OUTCOMES
  let learned = { ...base }
  if (ready) {
    // Allow: serves >= a and risk <= b. Stricter is higher a, lower b.
    let best: { a: number; b: number; n: number } | undefined
    for (const a of steps(FLOOR.allowServes, 0.95, 0.05)) {
      for (const b of steps(0.02, FLOOR.allowRisk, 0.02)) {
        const hit = xs.filter(x => x.serves >= a && x.risk <= b)
        if (hit.some(x => x.out === 'blocked') || !hit.length) continue
        if (!best || hit.length > best.n || (hit.length === best.n && (a > best.a || (a === best.a && b < best.b)))) best = { a, b, n: hit.length }
      }
    }
    // Deny: risk >= c and serves <= d. Stricter is higher c, lower d.
    let worst: { c: number; d: number; n: number } | undefined
    for (const c of steps(FLOOR.denyRisk, 0.95, 0.05)) {
      for (const d of steps(0.05, FLOOR.denyServes, 0.05)) {
        const hit = xs.filter(x => x.risk >= c && x.serves <= d)
        if (hit.some(x => x.out === 'ran') || !hit.length) continue
        if (!worst || hit.length > worst.n || (hit.length === worst.n && (c > worst.c || (c === worst.c && d < worst.d)))) worst = { c, d, n: hit.length }
      }
    }
    learned = {
      allowServes: best?.a ?? base.allowServes,
      allowRisk: best?.b ?? base.allowRisk,
      denyRisk: worst?.c ?? base.denyRisk,
      denyServes: worst?.d ?? base.denyServes,
    }
    // A fit that would be wrong where the shipped one is not is no fit.
    if (score(xs, learned).wrong > before.wrong) learned = { ...base }
  }
  return { n: xs.length, ran, blocked, base, learned, before, after: score(xs, learned), ready, at: now }
}

/** Rolling agreement of Jev's verdicts with how calls ended, one point per `window` decided calls. */
export function curve(entries: readonly GateEntry[], window = 10): number[] {
  const judged = entries
    .filter(e => e.jev === 'allow' || e.jev === 'deny')
    .map(e => ({ v: e.jev, out: outcome(e) }))
    .filter(x => x.out)
  const out: number[] = []
  for (let i = window; i <= judged.length; i += Math.max(1, Math.floor(window / 2))) {
    const w = judged.slice(i - window, i)
    out.push(w.filter(x => (x.v === 'allow' ? x.out === 'ran' : x.out === 'blocked')).length / w.length)
  }
  return out
}

const BARS = '▁▂▃▄▅▆▇█'

/** Values 0..1 as one line of bars, the newest `width` of them. */
export function sparkline(values: readonly number[], width = 24): string {
  return values
    .slice(-width)
    .map(v => BARS[Math.max(0, Math.min(7, Math.round(v * 7)))])
    .join('')
}

/** Did the person refuse the call? Read from what the tool call resolved to. */
export function refused(res: { deny?: string; isError?: true; text?: string } | undefined): boolean {
  if (!res) return false
  if (typeof res.deny === 'string') return true
  return !!res.isError && /doesn'?t want to proceed|rejected|denied|declined|was not approved|permission/i.test(res.text ?? '')
}

/** Remember what a phrase meant, newest kept, at most `cap` phrases. */
export function remember(dict: Record<string, SkinOp[]>, phrase: string, ops: SkinOp[], cap = 300): Record<string, SkinOp[]> {
  const next = { ...dict }
  delete next[phrase]
  next[phrase] = ops
  const keys = Object.keys(next)
  for (const k of keys.slice(0, Math.max(0, keys.length - cap))) delete next[k]
  return next
}
