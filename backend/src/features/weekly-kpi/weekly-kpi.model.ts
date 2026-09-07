/**
 * Weekly Check-In — the Effectiveness signal model.
 *
 * Source: "PhysioWard Weekly Check-In — Developer Reference" (Sam, 2026-09-01),
 * its companion "Effectiveness & Mojo" sheet, and physioward_weekly_model.json.
 * Thirty self-rated behaviour signals in five weighted groups produce a score
 * out of 10.
 *
 * THIS FILE IS THE ONLY COPY OF THE REGISTRY. The form does not carry its own
 * list of questions — it fetches this one from GET /api/weekly-kpi/model and
 * renders whatever comes back. That is deliberate: thirty rows of text, weights
 * and standard flags duplicated into the frontend is thirty chances for the two
 * to disagree about what a physio was actually asked, and a disagreement there
 * silently changes everyone's score.
 *
 * The client mirrors the ARITHMETIC (about twenty lines, in weeklyKpi.score.ts)
 * so the score can update as the physio fills the form in. It never sends a
 * score: `submitMonday` recomputes from the raw ratings and the server's number
 * is the one that is stored. A client that disagrees is a client bug, not a
 * scoring decision.
 *
 * ── Two corrections to the reference document ──────────────────────────────
 *
 * 1. BANDS ARE RESOLVED ON THE ROUNDED SCORE, not on the raw one. Section 3 of
 *    the document rounds the score to 1dp but calls `bandFor(overall * 10)`
 *    with the unrounded value. Those disagree at every boundary — a real,
 *    reachable example is a raw 4.9666, which the document displays as "5.0"
 *    and bands as "Below 5 — Intervene" on the same screen. 5 is a trigger
 *    threshold in section 8, so this is not cosmetic. `scoreSignals` bands
 *    `score`, never `raw`.
 *
 * 2. na_count IS COUNTED OVER THE REGISTRY, not over the submitted map. Section
 *    3 counts `r in ratings where r == "NA" or r is null`, which cannot see a
 *    signal the client left out of the payload entirely — even though section 5
 *    says a missing signal is to be treated exactly like "NA". Counting the
 *    thirty registry entries makes the two rules agree, and means a buggy
 *    client that drops half the form cannot dodge the `na_count >= 6` trigger.
 *
 * Everything else is implemented as written, including the deliberately
 * non-linear point map. Do not "fix" that: straight 2s across all thirty must
 * come to exactly 8.0 to match the band wording, and a linear 3/2/1/0 gives
 * 6.7. `npm run verify:kpi-model` asserts it, along with the four published
 * test vectors.
 */

/**
 * ── On versioning ──────────────────────────────────────────────────────────
 *
 * Section 5: "Weights changed after go-live -> increment model_version and
 * store it on every row. Never recalculate historical rows silently."
 *
 * Storing the version is only half of that promise. The other half is being
 * able to READ an old row: a score of 8.4 computed under v1.0 has to keep being
 * explained by v1.0's groups, weights and band labels, or the breakdown on
 * screen quietly describes it with a model it was never scored against. So the
 * models live in a registry keyed by version, and `modelFor(version)` is how
 * anything historical is rendered.
 *
 * There is exactly one version today. That is the cheapest possible moment to
 * build this — after a v1.1 exists, the same change means backfilling meaning
 * into rows nobody can interpret any more.
 *
 * TO ADD A VERSION: add a new `KpiModelDefinition` below, register it in
 * MODELS, and point KPI_MODEL_VERSION at it. Never edit a published one — a
 * row stamped '1.0' must always score and read the same way it did the day it
 * was submitted.
 */
export interface KpiModelDefinition {
  version:    string;
  point_map:  Record<0 | 1 | 2 | 3, number>;
  max_points: number;
  groups:     readonly SignalGroup[];
  signals:    readonly Signal[];
  bands:      readonly ScoreBand[];
}

/** The version new submissions are scored under. */
export const KPI_MODEL_VERSION = '1.0';

/** Raw stored rating. `null` is "N/A — did not arise this week", which the
 *  document writes as the string "NA"; it is stored as a NULL rating on a row
 *  that exists, so Postgres can range-check the numeric case with a plain
 *  CHECK. A signal with no row at all was never answered, and section 5 says to
 *  treat that as N/A too. */
export type SignalRating = 0 | 1 | 2 | 3 | null;

/** Points earned per rating. Non-linear on purpose — see the header. */
export const POINT_MAP: Record<0 | 1 | 2 | 3, number> = {
  3: 3.00,
  2: 2.40,
  1: 1.35,
  0: 0.00,
};
export const MAX_POINTS = 3.00;

export interface SignalGroup {
  group_id:     string;
  name:         string;
  /** Share of the final score. Must sum to 1.00 — asserted at module load. */
  group_weight: number;
  /** The outcome this group moves, shown as the group's subheading. */
  drives:       string;
}

export interface Signal {
  signal_id: string;
  group_id:  string;
  /** Weight WITHIN the group, 1-3. Not a share — the group's denominator is
   *  the sum of the weights actually rated, so an N/A shrinks both sides. */
  weight:    number;
  /** A Standard: expected every week, not a stretch goal. Seven of the thirty.
   *  Rated 0 or 1, it counts into `standards_missed` and is named to Sam. */
  standard:  boolean;
  text:      string;
}

export const SIGNAL_GROUPS: readonly SignalGroup[] = [
  { group_id: 'G1', name: 'Initial consults',               group_weight: 0.25, drives: 'conversion, recommendations, case acceptance' },
  { group_id: 'G2', name: 'Follow-ups & continuity',        group_weight: 0.25, drives: 'retention, plan completion, cancellation rate' },
  { group_id: 'G3', name: 'Follow-through & clinical care', group_weight: 0.20, drives: 'retention, plan completion, patient outcomes' },
  { group_id: 'G4', name: 'Team & communication',           group_weight: 0.15, drives: 'culture, internal referrals, how fast the team improves' },
  { group_id: 'G5', name: 'Systems & coachability',         group_weight: 0.15, drives: 'everything downstream — and how fast you improve' },
];

/** The thirty signals, verbatim from the Effectiveness sheet. The wording is
 *  what the team is being rated against, so it is copied exactly — including
 *  the curly quotes and the arrows. Do not paraphrase. */
export const SIGNALS: readonly Signal[] = [
  { signal_id: 'S01', group_id: 'G1', weight: 2, standard: false, text: 'I spoke with certainty — no “I think / might / hopefully”, including on cases I was less sure about' },
  { signal_id: 'S02', group_id: 'G1', weight: 3, standard: false, text: 'I gave the 3-step agenda and outcome frame at the start of every initial, and checked “sounds good?”' },
  { signal_id: 'S03', group_id: 'G1', weight: 3, standard: false, text: 'I dug past the first answer on impact instead of moving on to assessment' },
  { signal_id: 'S04', group_id: 'G1', weight: 3, standard: false, text: 'I anchored what they want to get back to, in their words, with a timeline' },
  { signal_id: 'S05', group_id: 'G1', weight: 2, standard: false, text: 'I stayed neutral during the exam — no diagnosis or reassurance before the close' },
  { signal_id: 'S06', group_id: 'G1', weight: 3, standard: false, text: 'I ran the close in order: permission → diagnosis → prognosis → plan. Then paused.' },
  { signal_id: 'S07', group_id: 'G1', weight: 3, standard: true,  text: 'I gave the full clinically appropriate recommendation every time' },
  { signal_id: 'S08', group_id: 'G1', weight: 2, standard: false, text: 'I presented the prepay options assumptively and held the silence after both questions' },
  { signal_id: 'S09', group_id: 'G1', weight: 3, standard: true,  text: 'I recorded every initial consult — including the ones that did not go well' },

  { signal_id: 'S10', group_id: 'G2', weight: 3, standard: false, text: 'I opened every follow-up by referencing the plan and where we are up to in it' },
  { signal_id: 'S11', group_id: 'G2', weight: 3, standard: false, text: 'I re-anchored the patient’s original goal — every session, not just at the start of the plan' },
  { signal_id: 'S12', group_id: 'G2', weight: 3, standard: false, text: 'I reassessed against an objective baseline, not just “how’s it feeling?”' },
  { signal_id: 'S13', group_id: 'G2', weight: 2, standard: false, text: 'I showed the patient their progress in a way they could see for themselves' },
  { signal_id: 'S14', group_id: 'G2', weight: 2, standard: false, text: 'I changed the plan out loud when it was not working, rather than quietly continuing' },
  { signal_id: 'S15', group_id: 'G2', weight: 3, standard: true,  text: 'I walked every patient out to the front desk — every appointment, not just initials' },
  { signal_id: 'S16', group_id: 'G2', weight: 3, standard: true,  text: 'I handed over to reception with a clear booking slip, and said out loud when they needed booking' },

  { signal_id: 'S17', group_id: 'G3', weight: 3, standard: true,  text: 'I called every initial-consult patient within one business day (Friday initials called Monday)' },
  { signal_id: 'S18', group_id: 'G3', weight: 3, standard: false, text: 'I set measurable objective baselines at the initial, and actually used them' },
  { signal_id: 'S19', group_id: 'G3', weight: 2, standard: false, text: 'I prescribed a home program they could realistically do — and checked they were doing it' },
  { signal_id: 'S20', group_id: 'G3', weight: 2, standard: false, text: 'I actioned my dropout list — contacted patients falling out of care' },

  { signal_id: 'S21', group_id: 'G4', weight: 3, standard: false, text: 'When a case of mine came up, I stayed open to other perspectives instead of defending my position' },
  { signal_id: 'S22', group_id: 'G4', weight: 2, standard: false, text: 'I flagged at-risk patients to reception rather than assuming they would catch it' },
  { signal_id: 'S23', group_id: 'G4', weight: 2, standard: false, text: 'I said the hard thing in the room — not in the carpark' },
  { signal_id: 'S24', group_id: 'G4', weight: 1, standard: false, text: 'I raised something with leadership rather than sitting on it' },
  { signal_id: 'S25', group_id: 'G4', weight: 2, standard: false, text: 'I contributed to team training rather than just consuming it' },

  { signal_id: 'S26', group_id: 'G5', weight: 3, standard: true,  text: 'Notes done same-day, every day' },
  { signal_id: 'S27', group_id: 'G5', weight: 3, standard: true,  text: 'Weekly KPI form in on time and completed properly — including the weeks that went badly' },
  { signal_id: 'S28', group_id: 'G5', weight: 3, standard: false, text: 'I actioned the focus point from my last consult audit, specifically' },
  { signal_id: 'S29', group_id: 'G5', weight: 2, standard: false, text: 'I took feedback without defending it' },
  { signal_id: 'S30', group_id: 'G5', weight: 1, standard: false, text: 'I asked for a Google review when the moment was right' },
];

export type BandId = 'ceiling' | 'model' | 'strong' | 'gap' | 'intervene';

export interface ScoreBand {
  band_id: BandId;
  /** Inclusive lower bound on the ROUNDED score. Written high to low for
   *  readability, but resolved by an explicit sort in `bandFor` so the order
   *  here is never load-bearing. */
  min:     number;
  label:   string;
}

export const SCORE_BANDS: readonly ScoreBand[] = [
  { band_id: 'ceiling',   min: 9.8, label: '10 — Ceiling check' },
  { band_id: 'model',     min: 8.5, label: '9–10 — Model & multiply' },
  { band_id: 'strong',    min: 6.5, label: '7–8 — Strong, one lapse' },
  { band_id: 'gap',       min: 5.0, label: '5–6 — Named gap' },
  { band_id: 'intervene', min: 0,   label: 'Below 5 — Intervene' },
];

// ── The version registry ────────────────────────────────────────────────────

/** Model 1.0 — the model as published in the reference document, 2026-09-01.
 *  Frozen. Any change to a weight, a point, a band or a signal is a NEW
 *  version, because rows already stamped '1.0' have to keep reading the way
 *  they read the day they were scored. */
const MODEL_1_0: KpiModelDefinition = {
  version:    '1.0',
  point_map:  POINT_MAP,
  max_points: MAX_POINTS,
  groups:     SIGNAL_GROUPS,
  signals:    SIGNALS,
  bands:      SCORE_BANDS,
};

const MODELS: Readonly<Record<string, KpiModelDefinition>> = {
  '1.0': MODEL_1_0,
};

/** The model new submissions are scored under. */
export const CURRENT_MODEL: KpiModelDefinition = MODELS[KPI_MODEL_VERSION];

/**
 * The model a given row was scored under.
 *
 * Returns null for a version this build has never heard of — which is a real
 * possibility on a rollback, where the database holds rows from a newer deploy.
 * Callers must render the stored numbers and skip the explanation rather than
 * describing an old score with today's model. Null, never a silent fallback to
 * CURRENT_MODEL: a wrong explanation is worse than no explanation.
 */
export function modelFor(version: string | null | undefined): KpiModelDefinition | null {
  if (!version) return null;
  return MODELS[version] ?? null;
}

export function knownModelVersions(): string[] {
  return Object.keys(MODELS);
}

/** The Mojo drain types and their first response.
 *
 *  NOT versioned, unlike everything above: Mojo is never scored and never part
 *  of Effectiveness — the sheet is explicit that it is a thermometer, not a
 *  rating — so nothing here can change a number anybody was measured on. */
export const DRAIN_TYPES = [
  { type: 'physical',   label: 'Physical',   signs: 'Sleep debt, poor fuel, no movement, no breaks between patients',             first_action: 'Fix the basics first. Low energy is a fuel problem more often than a mindset one.' },
  { type: 'emotional',  label: 'Emotional',  signs: 'A hard case, a difficult patient, a poor outcome, or something outside work', first_action: 'Ask honestly: is this mine to carry, or mine to manage?' },
  { type: 'mental',     label: 'Mental',     signs: 'Admin backlog, decision fatigue, open loops, constant context switching',     first_action: 'Close the loops. Batch the admin. One thing at a time.' },
  { type: 'relational', label: 'Relational', signs: 'Team friction, a patient conflict, something unsaid, feeling unsupported',    first_action: 'Name it — to the person or to Sam. These never resolve on their own.' },
  // The reference document is inconsistent here: the JSON model calls this
  // "no_drain" and the section 6 payload comment calls it "none". One value has
  // to win or the CHECK constraint and the form disagree; 'none' is the one the
  // wire format specifies, so that is what is stored.
  { type: 'none',       label: 'No drain',   signs: 'A good week',                                                                first_action: 'Name what created it so you can repeat it.' },
] as const;

export type DrainType = typeof DRAIN_TYPES[number]['type'];
export const DRAIN_TYPE_IDS: readonly DrainType[] = DRAIN_TYPES.map(d => d.type);

export function isDrainType(v: unknown): v is DrainType {
  return typeof v === 'string' && (DRAIN_TYPE_IDS as readonly string[]).includes(v);
}

/** Mojo at or below this needs flagging to Sam (section 8). At exactly 5 it is
 *  "a conversation this week"; below 5, "we talk now". */
export const MOJO_FLAG_AT_OR_BELOW = 5;
/** Section 8: a high N/A count shrinks the denominator and can inflate a score. */
export const NA_COUNT_REVIEW_AT = 6;

// ── Load-time invariants ────────────────────────────────────────────────────
// Section 1.1: "group_weight must sum to 1.00. Validate this on load — a silent
// drift here corrupts every score." These throw at import, so the server
// refuses to start on a bad registry rather than scoring a whole week with it.

(function assertRegistrySane(): void {
  // EVERY registered version, not just the current one. A frozen model that has
  // been quietly edited into an invalid state would score history wrongly the
  // next time anything recomputes it.
  for (const [version, model] of Object.entries(MODELS)) {
    if (model.version !== version) {
      throw new Error(`[weekly-kpi] model registered as ${version} declares version ${model.version}`);
    }

    const total = model.groups.reduce((s, g) => s + g.group_weight, 0);
    // Float tolerance: 0.25+0.25+0.20+0.15+0.15 is not exactly 1 in binary.
    if (Math.abs(total - 1) > 1e-9) {
      throw new Error(`[weekly-kpi] ${version}: group weights must sum to 1.00, got ${total}`);
    }

    const groupIds = new Set(model.groups.map(g => g.group_id));
    const seen = new Set<string>();
    for (const s of model.signals) {
      if (seen.has(s.signal_id)) {
        throw new Error(`[weekly-kpi] ${version}: duplicate signal id ${s.signal_id}`);
      }
      seen.add(s.signal_id);
      if (!groupIds.has(s.group_id)) {
        throw new Error(`[weekly-kpi] ${version}: signal ${s.signal_id} references unknown group ${s.group_id}`);
      }
      if (!Number.isInteger(s.weight) || s.weight < 1) {
        throw new Error(`[weekly-kpi] ${version}: signal ${s.signal_id} has a non-positive weight`);
      }
    }
    for (const g of model.groups) {
      if (!model.signals.some(s => s.group_id === g.group_id)) {
        throw new Error(`[weekly-kpi] ${version}: group ${g.group_id} has no signals`);
      }
    }
    // A band set with no floor would leave a low score unbanded, and
    // score/band are stored together under a CHECK constraint.
    if (!model.bands.some(b => b.min <= 0)) {
      throw new Error(`[weekly-kpi] ${version}: bands do not cover 0`);
    }
  }

  if (!MODELS[KPI_MODEL_VERSION]) {
    throw new Error(`[weekly-kpi] KPI_MODEL_VERSION ${KPI_MODEL_VERSION} is not registered`);
  }
})();

export const SIGNAL_IDS: readonly string[] = SIGNALS.map(s => s.signal_id);
export const STANDARD_SIGNAL_IDS: readonly string[] =
  SIGNALS.filter(s => s.standard).map(s => s.signal_id);

/** Per-version id lookup, built once. `signalById` defaults to the current
 *  model; pass an older one to resolve an id the way that model meant it. */
const SIGNAL_INDEX = new Map<string, Map<string, Signal>>(
  Object.entries(MODELS).map(([v, m]) => [v, new Map(m.signals.map(s => [s.signal_id, s]))]),
);

export function signalById(id: string, model: KpiModelDefinition = CURRENT_MODEL): Signal | undefined {
  return SIGNAL_INDEX.get(model.version)?.get(id);
}

/** Ratings as they arrive and as they are stored: signal id -> rating, where a
 *  missing key and an explicit null both mean N/A (section 5). */
export type RatingMap = Record<string, SignalRating | undefined>;

export interface GroupResult {
  group_id: string;
  /** Share of this group's available points that were earned, 0-1. Null when
   *  every signal in the group was N/A — the group is then excluded and its
   *  weight redistributed, rather than dragging the score to zero. */
  pct:      number | null;
  /** How many of the group's signals actually counted, for the UI. */
  rated:    number;
}

export interface ScoreResult {
  /** 0.0-10.0, rounded to 1dp. Null only when NOTHING was rated — section 5 is
   *  explicit that a zero is a real score and must never be produced by an
   *  absence of data. */
  score:            number | null;
  /** The unrounded value, for tests and for anyone re-deriving a band. */
  raw:              number | null;
  groups:           GroupResult[];
  band_id:          BandId | null;
  /** Standards rated 0 or 1. These get named on screen and in Sam's alert. */
  standards_missed: string[];
  /** Standards marked N/A. Not a miss — but a Standard is expected every week,
   *  so "did not arise" on one is worth Sam seeing rather than it vanishing
   *  into the general N/A count. Not in the reference document; added because
   *  N/A on a Standard is otherwise indistinguishable from a clean week. */
  standards_na:     string[];
  /** Signals not rated, counted over the registry — see the header, note 2. */
  na_count:         number;
  incomplete:       boolean;
  /** Which model produced this. Returned rather than assumed by the caller, so
   *  the version stamped on the row can never be a different one from the
   *  version that actually did the arithmetic. */
  model_version:    string;
}

/** Round half away from zero to 1dp. Pinned deliberately: JS `Math.round` is
 *  half-up and a score is never negative, so the two agree here — stating it
 *  stops a future refactor to `toFixed` (half-even in some engines) from
 *  quietly moving scores at a band boundary. */
export function round1(n: number): number {
  return Math.round((n + Number.EPSILON) * 10) / 10;
}

/** The band for an already-rounded score, under a given model. Sorted
 *  descending explicitly rather than trusting the order the bands happen to be
 *  written in. */
export function bandFor(score: number, model: KpiModelDefinition = CURRENT_MODEL): BandId {
  const ordered = [...model.bands].sort((a, b) => b.min - a.min);
  for (const b of ordered) if (score >= b.min) return b.band_id;
  // Unreachable: assertRegistrySane refuses a band set that does not cover 0,
  // and a score cannot be negative.
  return 'intervene';
}

export function bandLabel(id: BandId | null, model: KpiModelDefinition = CURRENT_MODEL): string | null {
  return model.bands.find(b => b.band_id === id)?.label ?? null;
}

/**
 * Score one submission. Pure: no clock, no database, no I/O.
 *
 * A rating that is not 0-3 and not null is a validation failure, not something
 * to coerce (section 5) — the validator rejects it before this is ever called,
 * and anything that still reaches here is treated as N/A rather than being
 * allowed to become NaN and poison the whole score.
 */
export function scoreSignals(
  ratings: RatingMap,
  model: KpiModelDefinition = CURRENT_MODEL,
): ScoreResult {
  const groups: GroupResult[] = model.groups.map(g => {
    let earned = 0;
    let possible = 0;
    let rated = 0;

    for (const s of model.signals) {
      if (s.group_id !== g.group_id) continue;
      const r = ratings[s.signal_id];
      // N/A: excluded from BOTH sides, so it costs the physio nothing.
      if (r === null || r === undefined) continue;
      if (r !== 0 && r !== 1 && r !== 2 && r !== 3) continue;
      earned   += model.point_map[r] * s.weight;
      possible += model.max_points   * s.weight;
      rated++;
    }

    return { group_id: g.group_id, pct: possible === 0 ? null : earned / possible, rated };
  });

  const byId = new Map(groups.map(g => [g.group_id, g]));

  // Renormalise: a fully-N/A group's weight is redistributed proportionally
  // across the groups that are live, so it neither counts as zero nor as full
  // marks.
  const live = model.groups.reduce(
    (sum, g) => (byId.get(g.group_id)!.pct === null ? sum : sum + g.group_weight),
    0,
  );

  const na_count = model.signals.filter(s => {
    const r = ratings[s.signal_id];
    return r === null || r === undefined;
  }).length;

  const standards_missed = model.signals
    .filter(s => s.standard && (ratings[s.signal_id] === 0 || ratings[s.signal_id] === 1))
    .map(s => s.signal_id);

  const standards_na = model.signals
    .filter(s => s.standard && (ratings[s.signal_id] === null || ratings[s.signal_id] === undefined))
    .map(s => s.signal_id);

  if (live === 0) {
    return {
      score: null, raw: null, groups, band_id: null,
      standards_missed, standards_na, na_count, incomplete: true,
      model_version: model.version,
    };
  }

  const raw = model.groups.reduce((sum, g) => {
    const r = byId.get(g.group_id)!;
    return r.pct === null ? sum : sum + r.pct * (g.group_weight / live);
  }, 0) * 10;

  const score = round1(raw);

  return {
    score,
    raw,
    groups,
    // Banded on the ROUNDED score — see the header, note 1.
    band_id: bandFor(score, model),
    standards_missed,
    standards_na,
    na_count,
    incomplete: false,
    model_version: model.version,
  };
}

/**
 * The whole registry, as the form receives it. One payload, one version stamp,
 * so a client can never render questions from one model and be scored against
 * another.
 */
export interface KpiModelPayload {
  model_version:         string;
  point_map:             Record<string, number>;
  max_points:            number;
  groups:                readonly SignalGroup[];
  signals:               readonly Signal[];
  bands:                 readonly ScoreBand[];
  drain_types:           typeof DRAIN_TYPES;
  mojo_flag_at_or_below: number;
  na_count_review_at:    number;
}

/** The registry as the form receives it. Defaults to the current model; pass an
 *  older one to explain a score that was computed under it. */
export function kpiModelPayload(model: KpiModelDefinition = CURRENT_MODEL): KpiModelPayload {
  return {
    model_version:         model.version,
    /** Object keys are strings over JSON, so the client looks these up by
     *  String(rating). Spread rather than shared by reference: a served payload
     *  must not hand a caller a mutable view of a frozen model. */
    point_map:             { ...model.point_map } as unknown as Record<string, number>,
    max_points:            model.max_points,
    groups:                model.groups,
    signals:               model.signals,
    bands:                 model.bands,
    drain_types:           DRAIN_TYPES,
    mojo_flag_at_or_below: MOJO_FLAG_AT_OR_BELOW,
    na_count_review_at:    NA_COUNT_REVIEW_AT,
  };
}
