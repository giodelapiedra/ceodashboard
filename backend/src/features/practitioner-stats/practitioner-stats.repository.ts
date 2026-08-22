import { query } from '../../db/pool';

/**
 * Per-clinician, per-DAY rollups of case_acceptances + patient_dropouts.
 *
 * Day-grained on purpose: the service buckets these into Monday-anchored weeks
 * with week.calculator, so the week convention lives in exactly one place and
 * this file never has to know about it. Volume is tiny (≈10 clinicians × 31
 * days), so one query per month beats one query per week.
 *
 * Bypasses RequestScope — the route is ADMIN-only and the report is deliberately
 * cross-clinic (that is what makes it a practice-wide board).
 */

export interface PractitionerDayRow {
  clinician_id:   string;
  clinician_name: string | null;
  clinic_id:      string;
  day:            string;   // YYYY-MM-DD
  /** Initial-consultation rows logged that day — the honest prepay denominator. */
  initials:       number;
  sum_recs:       number;
  sum_booked:     number;
  /**
   * Rows with at least one recommendation. Used as the AVG denominator so a
   * "no treatment plan" row (which lands in the DB as recommendations = 0,
   * because the column is NOT NULL DEFAULT 0) cannot drag the average toward
   * zero. The source spreadsheet leaves those cells blank and Sheets' AVG
   * skips blanks — this reproduces that behaviour explicitly instead of by
   * accident. tp_yes / tp_no below keep the excluded rows visible.
   */
  rows_with_recs: number;
  tp_yes:         number;
  tp_no:          number;
  prepay_offered: number;
  prepay_accepted: number;
}

export interface CancellationDayRow {
  clinician_id: string;
  clinic_id:    string;
  day:          string;   // YYYY-MM-DD
  /**
   * Cancellation EVENTS, not dropout rows. patient_dropouts stores
   * appointment_cancelled_dates as a DATE[] because one patient can cancel
   * several appointments before being logged once (migration 009), so a row
   * with three dates is three cancellation events. Each event is bucketed on
   * its own cancelled-appointment date — the SOP counts cancellations by when
   * the appointment was cancelled, not by when front desk keyed the entry.
   */
  cancellations: number;
  /**
   * Churns, counted per ENTRY rather than per event: churn is a property of the
   * patient (no future booking left), so three cancelled appointments by one
   * patient is still one churn. Bucketed on the LAST cancelled date, which is
   * when the patient actually stopped.
   *
   * Maps 1:1 onto Sam's SOP rules via the status vocabulary — 'Re-scheduled'
   * keeps a future booking, so it is a cancellation event but NOT a churn.
   */
  churns: number;
  /**
   * The Cancellation % numerator: patients who dropped out, counted per ENTRY
   * and bucketed exactly like churns.
   *
   * A SUBSET of churns. Sam settled this 2026-08-20: 'No Future Bookings' and
   * 'Cancelled - not rescheduled' count, 'Completed Treatment Plan' does NOT —
   * a patient who finished their treatment plan is a success, and counting that
   * as a cancellation would penalise the practitioner for doing the job right.
   * 'Re-scheduled' is out for the churn reason: the booking still exists.
   *
   * Whole practice, June 2026 Week 1, on 410 Total Appts: 70 no-future-booking
   * + 22 cancelled-not-rescheduled = 92, so 22.4%. Including the 8 completed
   * treatment plans would have read 24.4%.
   */
  cancellation_dropouts: number;
}

function isoDay(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  // pg hands back DATE as a JS Date at LOCAL midnight; toISOString() would
  // shift it a day west of UTC. Read the local components instead.
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * Statuses that end in a genuine drop-off — the Cancellation % numerator.
 * See CancellationDayRow.cancellation_dropouts for why these two and not more.
 */
const CANCELLATION_STATUSES = [
  'Cancelled - not rescheduled',
  'No Future Bookings',
];

/**
 * Statuses that leave the patient with no future booking. 'Re-scheduled' is
 * deliberately absent — see CancellationDayRow.churns.
 *
 * A superset of CANCELLATION_STATUSES: a completed treatment plan leaves no
 * future booking, so it is a churn, but it is not a cancellation.
 */
const CHURN_STATUSES = [
  ...CANCELLATION_STATUSES,
  'Completed Treatment Plan',
];

/** One practitioner-week's hand-entered Nookal figures (migration 024). */
export interface WeekInputRow {
  clinician_id:  string;
  year:          number;
  month:         number;
  week_num:      number;   // 1-4, 5 = Remainder
  total_appts:   number | null;
  occupancy_pct: number | null;
  new_cases:     number | null;
  /** Nookal 'Cancelled' appointments — see migration 026 for why it is a count. */
  cancelled_count: number | null;
  /** Null = never synced from Nookal (hand-entered only). */
  synced_at:     string | null;

  /**
   * Where occupancy_pct came from. 'nookal' = computed by the sync, 'manual' =
   * a person typed it. NULL with a value present means it predates migration
   * 029, and every one of those was hand-entered — so the service reads a NULL
   * source with a value as manual.
   */
  occupancy_source: 'nookal' | 'manual' | 'nookal_report' | 'nookal_api' | null;
  /**
   * The minutes behind occupancy_pct, when Nookal computed it. Present so the
   * Team row can pool — SUM(booked) / SUM(booked + available) — rather than
   * averaging percentages, which is what migration 024 was stuck with.
   */
  occupancy_booked_minutes:    number | null;
  occupancy_available_minutes: number | null;
  occupancy_blocked_minutes:   number | null;
  /**
   * Nookal "Scheduled Minutes" — rostered shift time, and the denominator its
   * own Occupancy report divides by. Only ever set by the report import
   * (migration 030): the roster is absent from the v3 API, so the derived path
   * cannot fill this in. NULL means occupancy was derived, not imported.
   */
  occupancy_scheduled_minutes: number | null;
}

export interface UpsertWeekInput {
  clinician_id:  string;
  year:          number;
  month:         number;
  week_num:      number;
  total_appts:   number | null;
  occupancy_pct: number | null;
  new_cases:     number | null;
  entered_by:    string;
}

export const practitionerStatsRepository = {
  /** Case-acceptance side: recommendations, conversion, prepay, treatment plans. */
  async caseAcceptanceByDay(
    dateFrom: string,
    dateTo:   string,
    clinicId: string | null
  ): Promise<PractitionerDayRow[]> {
    const { rows } = await query<{
      clinician_id:    string;
      clinician_name:  string | null;
      clinic_id:       string;
      day:             Date;
      initials:        string;
      sum_recs:        string;
      sum_booked:      string;
      rows_with_recs:  string;
      tp_yes:          string;
      tp_no:           string;
      prepay_offered:  string;
      prepay_accepted: string;
    }>(
      `SELECT
         c.clinician_id,
         u.full_name                                                        AS clinician_name,
         c.clinic_id,
         c.date_logged::date                                                AS day,
         COUNT(*)::bigint                                                   AS initials,
         COALESCE(SUM(c.case_recommendations), 0)::bigint                   AS sum_recs,
         COALESCE(SUM(c.appointments_booked), 0)::bigint                    AS sum_booked,
         COUNT(*) FILTER (WHERE c.case_recommendations > 0)::bigint         AS rows_with_recs,
         COUNT(*) FILTER (WHERE c.treatment_plan_provided IS TRUE)::bigint  AS tp_yes,
         COUNT(*) FILTER (WHERE c.treatment_plan_provided IS FALSE)::bigint AS tp_no,
         COUNT(*) FILTER (WHERE c.prepay_offered  IS TRUE)::bigint          AS prepay_offered,
         COUNT(*) FILTER (WHERE c.prepay_accepted IS TRUE)::bigint          AS prepay_accepted
       FROM case_acceptances c
       LEFT JOIN users u ON u.id = c.clinician_id
       WHERE c.date_logged >= $1::date
         AND c.date_logged <= $2::date
         AND ($3::text IS NULL OR c.clinic_id = $3)
       GROUP BY c.clinician_id, u.full_name, c.clinic_id, c.date_logged::date`,
      [dateFrom, dateTo, clinicId]
    );

    return rows.map((r) => ({
      clinician_id:    r.clinician_id,
      clinician_name:  r.clinician_name,
      clinic_id:       r.clinic_id,
      day:             isoDay(r.day),
      initials:        Number(r.initials),
      sum_recs:        Number(r.sum_recs),
      sum_booked:      Number(r.sum_booked),
      rows_with_recs:  Number(r.rows_with_recs),
      tp_yes:          Number(r.tp_yes),
      tp_no:           Number(r.tp_no),
      prepay_offered:  Number(r.prepay_offered),
      prepay_accepted: Number(r.prepay_accepted),
    }));
  },

  /**
   * Dropout side: the cancellation numerator, split into events and churns.
   *
   * Two queries because the two metrics have different grains — events are per
   * cancelled appointment date, churns are per patient — and bucketing them on
   * the same day column would double-count one and misdate the other. Merged
   * here so the service still sees one row per (clinician, day).
   */
  async cancellationsByDay(
    dateFrom: string,
    dateTo:   string,
    clinicId: string | null
  ): Promise<CancellationDayRow[]> {
    // EVENTS count real cancelled appointments only — no fallback. An entry
    // saved with an empty array had nothing cancelled (the entry form no longer
    // requires a date; 'Completed Treatment Plan' is the case that motivated
    // it), so unnest() yields no rows and it contributes no cancellation event.
    //
    // Both GSheets importers substitute date_logged when the source sheet had
    // no dates, so imported history is unaffected. Rows keyed before migration
    // 009 with a blank appointment_cancelled_date DID become an empty array,
    // and those stop counting here — see the count in docs before assuming the
    // historical cancellation totals are unchanged.
    const EVENT_DATES = 'd.appointment_cancelled_dates';

    // CHURNS still fall back. A churn is a property of the patient — no future
    // booking left — which holds whether or not an appointment was cancelled,
    // so a dateless entry is bucketed on the day it was logged rather than
    // vanishing from the churn count.
    const CHURN_DATES = `
      CASE WHEN cardinality(d.appointment_cancelled_dates) > 0
           THEN d.appointment_cancelled_dates
           ELSE ARRAY[d.date_logged] END
    `;

    const [events, churns] = await Promise.all([
      query<{ clinician_id: string; clinic_id: string; day: Date; n: string }>(
        `SELECT d.clinician_id, d.clinic_id, cd::date AS day, COUNT(*)::bigint AS n
           FROM patient_dropouts d
           CROSS JOIN LATERAL unnest(${EVENT_DATES}) AS cd
          WHERE cd >= $1::date
            AND cd <= $2::date
            AND ($3::text IS NULL OR d.clinic_id = $3)
          GROUP BY d.clinician_id, d.clinic_id, cd::date`,
        [dateFrom, dateTo, clinicId]
      ),
      // Churns and the Cancellation % numerator come out of ONE query, grouped by
      // status, rather than two queries with two status lists. They must agree
      // about which patients stopped and when — a second query with its own
      // date bucketing is a place for them to silently diverge.
      query<{ clinician_id: string; clinic_id: string; day: Date; status: string; n: string }>(
        `SELECT d.clinician_id, d.clinic_id, last_cd::date AS day, d.status, COUNT(*)::bigint AS n
           FROM patient_dropouts d
           CROSS JOIN LATERAL (
             SELECT MAX(cd) AS last_cd FROM unnest(${CHURN_DATES}) AS cd
           ) AS agg
          WHERE d.status = ANY($4::text[])
            AND agg.last_cd >= $1::date
            AND agg.last_cd <= $2::date
            AND ($3::text IS NULL OR d.clinic_id = $3)
          GROUP BY d.clinician_id, d.clinic_id, last_cd::date, d.status`,
        [dateFrom, dateTo, clinicId, CHURN_STATUSES]
      ),
    ]);

    const merged = new Map<string, CancellationDayRow>();
    const slot = (clinicianId: string, clinicIdVal: string, day: string): CancellationDayRow => {
      const key = `${clinicianId}|${day}`;
      let row = merged.get(key);
      if (!row) {
        merged.set(key, row = {
          clinician_id:  clinicianId,
          clinic_id:     clinicIdVal,
          day,
          cancellations: 0,
          churns:        0,
          cancellation_dropouts: 0,
        });
      }
      return row;
    };

    for (const r of events.rows) {
      slot(r.clinician_id, r.clinic_id, isoDay(r.day)).cancellations += Number(r.n);
    }
    const isCancellation = new Set(CANCELLATION_STATUSES);
    for (const r of churns.rows) {
      const row = slot(r.clinician_id, r.clinic_id, isoDay(r.day));
      const n   = Number(r.n);
      row.churns += n;
      if (isCancellation.has(r.status)) row.cancellation_dropouts += n;
    }

    return [...merged.values()];
  },

  /**
   * The hand-entered Total Appts / Occupancy / NC for one month, all weeks.
   *
   * Not filtered by clinic: SOP steps 8 and 16 both read these off Nookal with
   * "Location — All Location", so they are practice-wide per practitioner and
   * there is no per-clinic figure to filter to.
   */
  async weekInputsFor(year: number, month: number): Promise<WeekInputRow[]> {
    const { rows } = await query<{
      clinician_id:  string;
      year:          number;
      month:         number;
      week_num:      number;
      total_appts:   number | null;
      occupancy_pct: string | null;   // NUMERIC comes back as text
      new_cases:     number | null;
      cancelled_count: number | null;
      synced_at:     Date | null;
      occupancy_source:            'nookal' | 'manual' | 'nookal_report' | 'nookal_api' | null;
      occupancy_booked_minutes:    number | null;
      occupancy_available_minutes: number | null;
      occupancy_blocked_minutes:   number | null;
      occupancy_scheduled_minutes: number | null;
    }>(
      `SELECT clinician_id, year, month, week_num, total_appts, occupancy_pct,
              new_cases, cancelled_count, synced_at,
              occupancy_source, occupancy_booked_minutes,
              occupancy_available_minutes, occupancy_blocked_minutes,
              occupancy_scheduled_minutes
         FROM practitioner_week_inputs
        WHERE year = $1 AND month = $2`,
      [year, month]
    );
    return rows.map((r) => ({
      clinician_id:  r.clinician_id,
      year:          Number(r.year),
      month:         Number(r.month),
      week_num:      Number(r.week_num),
      total_appts:   r.total_appts === null ? null : Number(r.total_appts),
      occupancy_pct: r.occupancy_pct === null ? null : Number(r.occupancy_pct),
      new_cases:     r.new_cases === null ? null : Number(r.new_cases),
      cancelled_count: r.cancelled_count === null ? null : Number(r.cancelled_count),
      synced_at:     r.synced_at ? r.synced_at.toISOString() : null,
      occupancy_source:            r.occupancy_source,
      occupancy_booked_minutes:    r.occupancy_booked_minutes    === null ? null : Number(r.occupancy_booked_minutes),
      occupancy_available_minutes: r.occupancy_available_minutes === null ? null : Number(r.occupancy_available_minutes),
      occupancy_blocked_minutes:   r.occupancy_blocked_minutes   === null ? null : Number(r.occupancy_blocked_minutes),
      occupancy_scheduled_minutes: r.occupancy_scheduled_minutes === null ? null : Number(r.occupancy_scheduled_minutes),
    }));
  },

  /**
   * Upsert one practitioner-week. Keyed on the unique index so re-entering a
   * week corrects it in place — a second row would be silently double-counted.
   *
   * All three values are overwritten, including with NULL, so clearing a
   * mistyped figure is possible. A row where all three are null is kept rather
   * than deleted: it records that someone looked and left it blank.
   *
   * Occupancy carries ownership with it (migration 029). The form posts all
   * three figures on every save, including an occupancy the sync filled in and
   * nobody touched — so marking every save 'manual' would quietly freeze that
   * week against all future syncs. Only a value that DIFFERS from what is stored
   * is treated as a person's own; an unchanged one keeps whatever source and
   * minutes it already had. Clearing it hands the week back to the sync.
   */
  async upsertWeekInput(input: UpsertWeekInput): Promise<void> {
    await query(
      `INSERT INTO practitioner_week_inputs
         (clinician_id, year, month, week_num, total_appts, occupancy_pct, new_cases,
          entered_by, occupancy_source)
       VALUES ($1,$2,$3,$4,$5,$6::numeric,$7,$8,
               CASE WHEN $6::numeric IS NULL THEN NULL ELSE 'manual' END)
       ON CONFLICT (clinician_id, year, month, week_num) DO UPDATE
          SET total_appts   = EXCLUDED.total_appts,
              occupancy_pct = EXCLUDED.occupancy_pct,
              new_cases     = EXCLUDED.new_cases,

              occupancy_source = CASE
                WHEN EXCLUDED.occupancy_pct IS NULL THEN NULL
                WHEN EXCLUDED.occupancy_pct IS NOT DISTINCT FROM practitioner_week_inputs.occupancy_pct
                  THEN practitioner_week_inputs.occupancy_source
                ELSE 'manual' END,

              -- The stored minutes explain the stored percentage. Once a person
              -- overrides the percentage they no longer explain anything, so
              -- they go rather than sit there contradicting it.
              occupancy_booked_minutes = CASE
                WHEN EXCLUDED.occupancy_pct IS NOT DISTINCT FROM practitioner_week_inputs.occupancy_pct
                  THEN practitioner_week_inputs.occupancy_booked_minutes ELSE NULL END,
              occupancy_available_minutes = CASE
                WHEN EXCLUDED.occupancy_pct IS NOT DISTINCT FROM practitioner_week_inputs.occupancy_pct
                  THEN practitioner_week_inputs.occupancy_available_minutes ELSE NULL END,
              occupancy_blocked_minutes = CASE
                WHEN EXCLUDED.occupancy_pct IS NOT DISTINCT FROM practitioner_week_inputs.occupancy_pct
                  THEN practitioner_week_inputs.occupancy_blocked_minutes ELSE NULL END,
              occupancy_scheduled_minutes = CASE
                WHEN EXCLUDED.occupancy_pct IS NOT DISTINCT FROM practitioner_week_inputs.occupancy_pct
                  THEN practitioner_week_inputs.occupancy_scheduled_minutes ELSE NULL END,
              occupancy_synced_at = CASE
                WHEN EXCLUDED.occupancy_pct IS NOT DISTINCT FROM practitioner_week_inputs.occupancy_pct
                  THEN practitioner_week_inputs.occupancy_synced_at ELSE NULL END,
              occupancy_measured_days_after = CASE
                WHEN EXCLUDED.occupancy_pct IS NOT DISTINCT FROM practitioner_week_inputs.occupancy_pct
                  THEN practitioner_week_inputs.occupancy_measured_days_after ELSE NULL END,

              updated_at    = NOW(),
              updated_by    = EXCLUDED.entered_by`,
      [
        input.clinician_id, input.year, input.month, input.week_num,
        input.total_appts, input.occupancy_pct, input.new_cases, input.entered_by,
      ]
    );
  },

  /**
   * Clinicians who should appear as rows even in a week where they logged
   * nothing — otherwise a physio with a blank week silently vanishes from the
   * board instead of showing an empty row worth asking about.
   *
   * show_in_picker is honoured so ex-physios stay out (migration 018), and
   * also_clinician lets the super-admin account appear (migration 021).
   */
  async activeClinicians(clinicId: string | null): Promise<
    { id: string; full_name: string | null; clinic_id: string | null }[]
  > {
    const { rows } = await query<{ id: string; full_name: string | null; clinic_id: string | null }>(
      `SELECT id, full_name, clinic_id
         FROM users
        WHERE is_active IS TRUE
          AND show_in_picker IS TRUE
          AND (role = 'CLINICIAN' OR also_clinician IS TRUE)
          AND ($1::text IS NULL OR clinic_id = $1)
        ORDER BY full_name NULLS LAST, id`,
      [clinicId]
    );
    return rows;
  },
};
