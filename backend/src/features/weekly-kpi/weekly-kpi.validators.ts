import { z } from 'zod';
import { CLINIC_IDS, ClinicId } from '../../shared/roles';
import { SIGNAL_IDS, DRAIN_TYPE_IDS } from './weekly-kpi.model';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

/**
 * Optional long answer. Empty / whitespace-only becomes null rather than '' so
 * "the physio left this blank" is one value in the DB and not two — the tracker
 * renders a dash off `=== null`, and '' would slip past that as content.
 */
const longAnswer = (max: number) =>
  z.string().max(max)
    .transform(s => { const t = s.trim(); return t === '' ? null : t; })
    .nullable()
    .optional()
    .transform(v => v ?? null);

/** Required long answer — the trim happens before the length check, so a box
 *  holding only spaces is rejected as blank instead of accepted as 40 chars. */
const requiredLongAnswer = (max: number) =>
  z.string()
    .transform(s => s.trim())
    .refine(s => s.length > 0, 'This field is required')
    .refine(s => s.length <= max, `Must be ${max} characters or fewer`);

/** A KPI name / target / result cell. Short answer, all three optional per the
 *  spec's own layout (only the block as a whole is required — see below). */
const kpiCell = z.string().max(200)
  .transform(s => { const t = s.trim(); return t === '' ? null : t; })
  .nullable()
  .optional()
  .transform(v => v ?? null);

const kpiLine = z.object({
  name:   kpiCell,
  target: kpiCell,
  result: kpiCell,
  /** focus_kpis[].hit from the Weekly Check-In reference. Three-valued: null is
   *  "not answered", which is not the same as "did not hit". */
  hit:    z.boolean().nullable().optional().transform(v => v ?? null),
});

const rating = z.coerce.number().int()
  .min(1, 'Rating must be between 1 and 10')
  .max(10, 'Rating must be between 1 and 10');

export const clinicIdSchema = z.enum([...CLINIC_IDS] as [ClinicId, ...ClinicId[]]);

// ── Weekly Check-In: the 30 behaviour signals ───────────────────────────────

/**
 * One signal's rating: 0-3, or null for "N/A — did not arise this week".
 *
 * A literal union rather than `z.number().min(0).max(3)`: section 5 of the
 * reference document says a rating outside the domain must be REJECTED, not
 * coerced, and a plain number range would happily accept 2.5 and let it into
 * the point map as `undefined`.
 *
 * The client may also send the string "NA" — that is the document's own wire
 * spelling — so it is accepted and normalised to null here rather than being
 * rejected on a technicality.
 */
const signalRating = z.union([
  z.literal(0), z.literal(1), z.literal(2), z.literal(3),
  z.null(),
  z.literal('NA').transform(() => null),
]);

const SIGNAL_ID_SET = new Set(SIGNAL_IDS);

/**
 * The ratings map. Not `.length(30)`: section 5 says a signal missing from the
 * payload is to be treated exactly like "NA" (and logged as a client bug), so a
 * short map is scored, not refused.
 *
 * What IS refused: an unknown signal id, and a map with nothing rated in it.
 * The second one matters — section 5 wants a fully-N/A submission to score null
 * rather than 0, and effectiveness_rating on this table is NOT NULL, so a row
 * with no score at all has nowhere to live. Refusing it at the door keeps that
 * impossible instead of half-storing it.
 */
const signalsSchema = z.record(z.string(), signalRating)
  .superRefine((map, ctx) => {
    for (const key of Object.keys(map)) {
      if (!SIGNAL_ID_SET.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown signal "${key}" — the form is out of date, reload the page`,
          path: [key],
        });
      }
    }
    if (!Object.values(map).some(v => v !== null && v !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Rate at least one behaviour — a week marked N/A throughout cannot be scored',
      });
    }
  });

/** A self-reported weekly tally. Optional everywhere: a physio who does not
 *  know a number must be able to leave it blank rather than type a 0 that
 *  reads as a real count of zero. */
const count = z.coerce.number().int()
  .min(0, 'A count cannot be negative')
  .max(9999, 'That count looks wrong — check the number')
  .nullable()
  .optional()
  .transform(v => v ?? null);

/**
 * The nine counts from section 6. They do not affect the score.
 *
 * Contradictions between them are NOT rejected here — section 5: "Counts
 * contradict each other -> Warn, do not block. The clinician may have a
 * legitimate reason; store the values and surface the warning to Sam." The
 * warnings are computed in the service (`countWarnings`).
 */
const countsSchema = z.object({
  initials_seen:         count,
  recommendations_full:  count,
  plans_accepted_full:   count,
  plans_accepted_part:   count,
  dropouts_contacted:    count,
  consults_recorded:     count,
  calls_due:             count,
  calls_made:            count,
  cancellations_noshows: count,
}).partial().transform(c => ({
  initials_seen:         c.initials_seen         ?? null,
  recommendations_full:  c.recommendations_full  ?? null,
  plans_accepted_full:   c.plans_accepted_full   ?? null,
  plans_accepted_part:   c.plans_accepted_part   ?? null,
  dropouts_contacted:    c.dropouts_contacted    ?? null,
  consults_recorded:     c.consults_recorded     ?? null,
  calls_due:             c.calls_due             ?? null,
  calls_made:            c.calls_made            ?? null,
  cancellations_noshows: c.cancellations_noshows ?? null,
}));

const drainSchema = z.enum(
  [...DRAIN_TYPE_IDS] as [string, ...string[]],
  { errorMap: () => ({ message: 'Pick one drain type, or "No drain"' }) },
);

/** "What kind of drain was it?" — multi-select since 2026-09-04. At least one
 *  pick, and 'none' ("No drain") is exclusive: it says nothing else drained
 *  you, which cannot be true alongside a real drain type. */
const drainsSchema = z.array(drainSchema)
  .min(1, 'Pick at least one drain type, or "No drain"')
  .refine(v => new Set(v).size === v.length, 'Duplicate drain type')
  .refine(v => !v.includes('none') || v.length === 1, {
    message: '"No drain" cannot be combined with another drain type',
  });

/**
 * Monday half.
 *
 * Name and Clinic are ABSENT on purpose. The spec asks for both because a Teams
 * card cannot know who is filling it in; this app does, so they come off the
 * JWT / the account's default clinic and are never accepted from the client.
 * Trusting a client-sent clinician_id here would let any physio file a report
 * under a colleague's name. The Weekly Check-In reference document reintroduces
 * both in its section 6 payload, and they are still not accepted — same reason.
 *
 * The whole Effectiveness / Mojo block is ABSENT for a different reason: it
 * lives on the Friday half. `signals` and `mojo_rating` moved there 2026-09-04;
 * `mojo_drain` and `mojo_action` followed on 2026-09-07 at Sam's request, so
 * the reflection is answered once, at the end of the week it describes. Monday
 * is now intention-setting only. See submitFridaySchema below.
 */
export const submitMondaySchema = z.object({
  // Exactly three rows, matching the spec's KPI #1-#3.
  kpis: z.array(kpiLine).length(3, 'Expected exactly 3 KPI rows'),

  missed_goal_actions: longAnswer(4000),

  counts: countsSchema.optional().default({}),

  intention:       requiredLongAnswer(4000),
  case_to_discuss: longAnswer(4000),
  help_needed:     longAnswer(4000),
  checkin_needed:  z.boolean(),
  checkin_focus:   longAnswer(4000),
})
  // "My KPIs for the previous week — Required". The spec marks the block
  // required but each cell is a plain short answer, so the honest reading is
  // "at least the first KPI has to say something".
  .refine(v => !!(v.kpis[0].name || v.kpis[0].target || v.kpis[0].result), {
    message: 'Fill in at least KPI #1 — name, target or result',
    path:    ['kpis'],
  })
  // The conditional follow-up from the spec: shown only if Yes. Asking for it
  // when the answer was No would store a note against a check-in nobody wants.
  .refine(v => v.checkin_needed || v.checkin_focus === null, {
    message: 'Remove the check-in focus, or answer Yes to the check-in question',
    path:    ['checkin_focus'],
  });

/**
 * Friday half.
 *
 * Effectiveness (`signals`) and the Mojo rating moved here from Monday
 * (2026-09-04) — see the note above submitMondaySchema. Required here the same
 * way they used to be required on Monday: the week still has to be rated, just
 * at its close instead of its start. Everything else is optional except the
 * goal question. `mojo_drain` / `mojo_action` joined them here 2026-09-07 —
 * the drain and the action about it are end-of-week reflection, so they are
 * asked next to the rating they explain rather than five days before it.
 *
 * effectiveness_rating is not accepted from the client at all — it is DERIVED
 * from the thirty signals, server-side. Accepting a number the client computed
 * would make the score a claim rather than a calculation.
 *
 * best_behaviour / slipped / commitment are the Weekly Check-In reference's
 * `reflection` block. Its fourth field, `flag`, is the flag_for_sam that has
 * been on this half since migration 032 — not duplicated under a second name.
 */
export const submitFridaySchema = z.object({
  /**
   * Which week is being closed. Absent = the current week, which is the normal
   * case and how this endpoint behaved before 2026-09-07.
   *
   * A past week is accepted ONLY if it is still open and still inside the
   * late-close window — the service checks that, not this schema, because the
   * answer depends on the caller's own rows. Sam asked for this so a physio who
   * missed a Friday can still close that week instead of losing it, and so the
   * block on the new week's Monday half always has a way out.
   */
  week_start:      isoDate.optional(),

  wins:            longAnswer(4000),
  goal_achieved:   z.boolean(),
  goal_reflection: longAnswer(4000),
  flag_for_sam:    longAnswer(4000),

  best_behaviour:  longAnswer(4000),
  slipped:         longAnswer(4000),
  commitment:      longAnswer(4000),

  /** signal_id -> 0|1|2|3|null. The score is computed from this and nothing else. */
  signals: signalsSchema,

  mojo_rating: rating,

  /** Mojo question 2. Required, as it was on Monday: the sheet's whole point is
   *  that "the wrong strategy on the right drain does nothing", so a drain type
   *  has to be on record alongside the rating. */
  mojo_drain:  drainsSchema,
  /** Mojo question 3 — "one thing you will do next week, and when". */
  mojo_action: longAnswer(4000),
})
  // "If No — Why do you think that was?" is asked only when the goal was
  // missed. A reflection alongside goal_achieved = true is a client bug.
  .refine(v => v.goal_achieved === false || v.goal_reflection === null, {
    message: 'The reflection is only for a goal that was not achieved',
    path:    ['goal_reflection'],
  });

/** Tracker query — spec section 8's main view plus its optional filters. */
export const trackerQuerySchema = z.object({
  /** Any date in the week of interest; the service normalises it to the Monday. */
  week:         isoDate.optional(),
  clinic_id:    clinicIdSchema.optional(),
  checkin_only: z.enum(['true', 'false']).optional().transform(v => v === 'true'),
  open_only:    z.enum(['true', 'false']).optional().transform(v => v === 'true'),
});

export const historyQuerySchema = z.object({
  limit:  z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * A comment on a report (migration 033).
 *
 * Same 4000-char ceiling as the long answers, and the same trim-then-measure
 * order so a box of spaces is rejected as blank. The DB carries both rules as
 * CHECK constraints too — this is the layer that produces a readable message.
 */
export const commentBodySchema = z.object({
  body: requiredLongAnswer(4000),
});

export type SubmitMondayBody = z.infer<typeof submitMondaySchema>;
export type CommentBody      = z.infer<typeof commentBodySchema>;
export type SubmitFridayBody = z.infer<typeof submitFridaySchema>;
export type TrackerQuery     = z.infer<typeof trackerQuerySchema>;
export type WeeklyCounts     = z.infer<typeof countsSchema>;
