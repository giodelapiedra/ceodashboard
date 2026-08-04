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
 * Statuses that leave the patient with no future booking. 'Re-scheduled' is
 * deliberately absent — see CancellationDayRow.churns.
 */
const CHURN_STATUSES = [
  'Cancelled - not rescheduled',
  'No Future Bookings',
  'Completed Treatment Plan',
];

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
    // An entry with no recorded cancelled dates falls back to date_logged, so a
    // sparsely-filled row still registers as one event rather than vanishing.
    const EFFECTIVE_DATES = `
      CASE WHEN cardinality(d.appointment_cancelled_dates) > 0
           THEN d.appointment_cancelled_dates
           ELSE ARRAY[d.date_logged] END
    `;

    const [events, churns] = await Promise.all([
      query<{ clinician_id: string; clinic_id: string; day: Date; n: string }>(
        `SELECT d.clinician_id, d.clinic_id, cd::date AS day, COUNT(*)::bigint AS n
           FROM patient_dropouts d
           CROSS JOIN LATERAL unnest(${EFFECTIVE_DATES}) AS cd
          WHERE cd >= $1::date
            AND cd <= $2::date
            AND ($3::text IS NULL OR d.clinic_id = $3)
          GROUP BY d.clinician_id, d.clinic_id, cd::date`,
        [dateFrom, dateTo, clinicId]
      ),
      query<{ clinician_id: string; clinic_id: string; day: Date; n: string }>(
        `SELECT d.clinician_id, d.clinic_id, last_cd::date AS day, COUNT(*)::bigint AS n
           FROM patient_dropouts d
           CROSS JOIN LATERAL (
             SELECT MAX(cd) AS last_cd FROM unnest(${EFFECTIVE_DATES}) AS cd
           ) AS agg
          WHERE d.status = ANY($4::text[])
            AND agg.last_cd >= $1::date
            AND agg.last_cd <= $2::date
            AND ($3::text IS NULL OR d.clinic_id = $3)
          GROUP BY d.clinician_id, d.clinic_id, last_cd::date`,
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
        });
      }
      return row;
    };

    for (const r of events.rows) {
      slot(r.clinician_id, r.clinic_id, isoDay(r.day)).cancellations += Number(r.n);
    }
    for (const r of churns.rows) {
      slot(r.clinician_id, r.clinic_id, isoDay(r.day)).churns += Number(r.n);
    }

    return [...merged.values()];
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
