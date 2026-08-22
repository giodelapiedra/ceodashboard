/**
 * Guard against a date landing in a patient-name column.
 *
 * Why this exists: ad lead 738 was imported from the Brookvale sheet with
 * patient_name = "Aug 11, 2026" (a stray date typed into the name cell). The
 * row looked fine everywhere — it was booked, correctly bucketed to Meta — but
 * it could never match a Nookal patient, so it silently contributed $0 to the
 * Leads Paid vs Spend card. Nothing rejected it on the way in.
 *
 * Deliberately narrow: it must never reject a real person. Names like
 * "April Smith", "June Cruz" or "May Tan" are common, so a month word alone is
 * NOT enough — a day number has to be there too.
 */

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';

/** "2026-08-11" · "11/08/2026" · "8.11.26" — separators and digits only. */
const NUMERIC_DATE = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/;

/** "Aug 11, 2026" · "August 11" · "Sept 3rd 2026" */
const MONTH_FIRST = new RegExp(
  `^(?:${MONTHS})[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?(?:\\s+\\d{2,4})?$`
);

/** "11 Aug 2026" · "3rd September" */
const DAY_FIRST = new RegExp(
  `^\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})[a-z]*\\.?,?(?:\\s+\\d{2,4})?$`
);

/** True when the string reads as a calendar date rather than a person. */
export function looksLikeDate(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  if (!s) return false;
  return NUMERIC_DATE.test(s) || MONTH_FIRST.test(s) || DAY_FIRST.test(s);
}

/**
 * Null when the name is usable, otherwise the reason it is not. Returning the
 * reason (instead of a bare boolean) lets the importer log WHICH row it
 * skipped and why, and lets the API surface it to the encoder verbatim.
 */
export function patientNameProblem(raw: string): string | null {
  const s = raw.trim();
  if (!s) return 'Patient name is required';
  if (looksLikeDate(s)) return `"${s}" is a date, not a patient name`;
  // A name with no letters at all ("12345", "---") is never a person either.
  if (!/\p{L}/u.test(s)) return `"${s}" has no letters — that is not a name`;
  return null;
}
