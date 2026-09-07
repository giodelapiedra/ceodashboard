// `import type`, not a plain import: this module is the client half of a
// calculation that also exists on the server, and the parity check in
// backend/tools imports THIS FILE directly to prove the two agree. A value
// import of the app's type barrel would drag the whole frontend module graph
// into a Node script that only wants the arithmetic. Types erase; this does not.
import type { KpiModel, KpiBandId, SignalRating } from '../types'

/**
 * The Weekly Check-In scoring arithmetic, client side.
 *
 * WHY THIS EXISTS AT ALL: the form has to show the physio their score moving as
 * they answer. Waiting for a round trip on every one of thirty clicks is not a
 * form, and submitting blind and finding out afterwards defeats the point of a
 * self-assessment.
 *
 * WHAT IT IS NOT: authoritative. `POST /api/weekly-kpi/monday` recomputes the
 * score from the raw ratings and stores ITS number. Nothing here is ever sent —
 * the payload carries ratings only. If this file and the server ever disagree,
 * the server is right by construction and this is the bug.
 *
 * WHAT IT DOES NOT DUPLICATE: the questions. Every weight, group, band and
 * point value comes in through `model`, fetched from the server's registry.
 * This file knows the shape of the calculation and none of its content, so
 * retuning the model on the server retunes the preview with it and there is no
 * second list of signals to keep in step.
 *
 * Mirrors weekly-kpi.model.ts `scoreSignals`, including its two corrections to
 * the reference document: the band is resolved on the ROUNDED score, and
 * na_count is counted over the registry rather than over the answers map (a
 * signal the physio has not reached yet is N/A, and has to count as one).
 */

export interface GroupScore {
  group_id: string
  /** Share of this group's available points earned, 0-1. Null when every signal
   *  in the group is N/A — the group is then excluded and its weight spread
   *  across the rest, rather than dragging the score to zero. */
  pct:      number | null
  /** How many of the group's signals counted, and how many there are. */
  rated:    number
  total:    number
}

export interface LocalScore {
  /** 0.0-10.0, 1dp. Null when nothing has been rated yet — a zero is a real
   *  score and must never be produced by an absence of answers. */
  score:            number | null
  band_id:          KpiBandId | null
  band_label:       string | null
  groups:           GroupScore[]
  /** Signal ids of Standards rated 0 or 1. */
  standards_missed: string[]
  /** Signal ids of Standards marked N/A. Not a miss, but worth surfacing. */
  standards_na:     string[]
  na_count:         number
  /** Signals with a 0-3 answer. Drives the "18 of 30 answered" progress line. */
  answered:         number
  total:            number
}

/** Round half away from zero to 1dp — the same rule as the server. */
export function round1(n: number): number {
  return Math.round((n + Number.EPSILON) * 10) / 10
}

/** The band for an ALREADY-ROUNDED score. Sorted descending here rather than
 *  trusting the order the server happened to send the bands in. */
export function bandFor(model: KpiModel, score: number): KpiBandId | null {
  const ordered = [...model.bands].sort((a, b) => b.min - a.min)
  for (const b of ordered) if (score >= b.min) return b.band_id
  return null
}

export function bandLabel(model: KpiModel, id: KpiBandId | null): string | null {
  return model.bands.find(b => b.band_id === id)?.label ?? null
}

/** Points for one rating, from the served map. Its keys are JSON object keys
 *  and therefore strings, which is why the lookup stringifies. */
function points(model: KpiModel, rating: 0 | 1 | 2 | 3): number {
  return model.point_map[String(rating)] ?? 0
}

export function scoreLocally(
  model: KpiModel,
  answers: Record<string, SignalRating | undefined>,
): LocalScore {
  const groups: GroupScore[] = model.groups.map(g => {
    let earned = 0
    let possible = 0
    let rated = 0
    let total = 0

    for (const s of model.signals) {
      if (s.group_id !== g.group_id) continue
      total++
      const r = answers[s.signal_id]
      // N/A is excluded from BOTH sides, so it costs the physio nothing.
      if (r === null || r === undefined) continue
      earned   += points(model, r) * s.weight
      possible += model.max_points  * s.weight
      rated++
    }

    return { group_id: g.group_id, pct: possible === 0 ? null : earned / possible, rated, total }
  })

  const byId = new Map(groups.map(g => [g.group_id, g]))

  const live = model.groups.reduce(
    (sum, g) => (byId.get(g.group_id)?.pct == null ? sum : sum + g.group_weight),
    0,
  )

  // Counted over the REGISTRY, not over `answers` — a signal the physio has not
  // reached yet is absent from the map and is N/A all the same.
  const na_count = model.signals.filter(s => {
    const r = answers[s.signal_id]
    return r === null || r === undefined
  }).length

  const standards_missed = model.signals
    .filter(s => s.standard && (answers[s.signal_id] === 0 || answers[s.signal_id] === 1))
    .map(s => s.signal_id)

  const standards_na = model.signals
    .filter(s => s.standard && (answers[s.signal_id] === null || answers[s.signal_id] === undefined))
    .map(s => s.signal_id)

  const total    = model.signals.length
  const answered = total - na_count

  if (live === 0) {
    return {
      score: null, band_id: null, band_label: null, groups,
      standards_missed, standards_na, na_count, answered, total,
    }
  }

  const raw = model.groups.reduce((sum, g) => {
    const r = byId.get(g.group_id)
    return r?.pct == null ? sum : sum + r.pct * (g.group_weight / live)
  }, 0) * 10

  const score   = round1(raw)
  const band_id = bandFor(model, score)

  return {
    score,
    band_id,
    band_label: bandLabel(model, band_id),
    groups,
    standards_missed,
    standards_na,
    na_count,
    answered,
    total,
  }
}

/**
 * The colour a Weekly Check-In score gets, as one of the five band keys already
 * used across this feature. Kept here rather than in weeklyKpi.format so the
 * 0-10 score and the 1-10 self-ratings stay visually one ramp: teal for a good
 * week down to red for one that needs a conversation.
 */
export function bandKeyForScore(band: KpiBandId | null): 'high' | 'good' | 'mid' | 'low' | 'bad' {
  switch (band) {
    case 'ceiling':   return 'high'
    case 'model':     return 'high'
    case 'strong':    return 'good'
    case 'gap':       return 'mid'
    case 'intervene': return 'bad'
    default:          return 'low'
  }
}
