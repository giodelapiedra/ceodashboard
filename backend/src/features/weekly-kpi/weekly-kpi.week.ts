/**
 * Week keying for Team Performance KPI Reporting.
 *
 * Deliberately NOT week.calculator.ts. That module builds the CEO dashboard /
 * scorecard grid: Week 1-4 plus a Remainder column, bounded inside a calendar
 * month, and for months Cath already built by hand it uses her transcribed
 * ranges verbatim (some Mon-Fri, some Mon-Sun, some starting on the 1st). That
 * is correct for tying out with her spreadsheet and wrong for this feature:
 *
 *   - This form has a Monday half and a Friday half. A "Remainder [30-31]"
 *     column has neither.
 *   - A physio's week does not stop at a month boundary. Splitting one working
 *     week across two rows would break the spec's one-row-per-person-per-week
 *     rule, which is the match key the Friday submit relies on.
 *
 * So a KPI week here is the plain ISO week: Monday through Sunday, no month
 * boundary, no special cases. See docs/WEEK_GRID_2026-08-06.md before changing.
 */

/** Local-date ISO string (YYYY-MM-DD). Never toISOString() — that is UTC, and
 *  east of UTC it silently reports yesterday for anything before ~10am. */
function localISO(d: Date): string {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** Parse YYYY-MM-DD as a LOCAL date. Midday avoids any DST edge shifting the
 *  day; we only ever read the date parts back out. */
function parseISO(iso: string): Date {
  return new Date(`${iso}T12:00:00`);
}

/** The Monday of the ISO week containing `iso`. Sunday belongs to the week that
 *  is ending, not the one about to start — so Sunday maps back six days. */
export function mondayOf(iso: string): string {
  const d   = parseISO(iso);
  const dow = d.getDay();               // 0 = Sunday … 6 = Saturday
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  return localISO(d);
}

/** The timezone the clinics actually work in.
 *
 *  The prod server runs UTC (Etc/UTC), so `new Date().getDay()` there is UTC.
 *  On a Monday morning in Sydney it is still Sunday in UTC, and a Monday half
 *  submitted at 9am AEST was being keyed to the PREVIOUS week — the Friday
 *  half then looked for the real current week, found nothing, and refused with
 *  "Fill in the Monday half first". Seen on prod 2026-09-07. Every date this
 *  module reports is therefore read in clinic time, never in server time. */
const CLINIC_TZ = "Australia/Sydney";

/** Today, in clinic time. `en-CA` formats as YYYY-MM-DD. */
export function todayISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/** The Monday of the week we are in right now — the week a submission lands on. */
export function currentWeekStart(): string {
  return mondayOf(todayISO());
}

export function addDays(iso: string, n: number): string {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return localISO(d);
}

/** Sunday of the week starting at `monday`. The week's last day, and so the
 *  cutoff for "can this week still be edited". */
export function weekEnd(monday: string): string {
  return addDays(monday, 6);
}

/** True when `monday` is the current week's Monday. Past weeks are frozen: Sam
 *  reviews the tracker, and a row he has already read must not change under him. */
export function isCurrentWeek(monday: string): boolean {
  return monday === currentWeekStart();
}

/** 1 = Monday … 7 = Sunday, for today. Drives which half of the form the
 *  physio lands on — advisory only, never a hard gate (see the service). */
export function isoDayOfWeek(): number {
  // Via todayISO so the day-of-week is the clinic's day, not the server's.
  const dow = parseISO(todayISO()).getDay();
  return dow === 0 ? 7 : dow;
}
