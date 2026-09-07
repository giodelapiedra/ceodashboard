import { SheetWeekNum, WeekNum, WeekRange } from '../types';

/** A Mon-Sun column matching the CEO sheet's own numbering. */
export type SheetWeekRange = WeekRange & { weekNum: SheetWeekNum };

/**
 * Build 4 Monday-anchored 7-day weeks for a calendar month, plus a Remainder
 * range for the tail, to MATCH the Practitioner Stats Google Sheet exactly.
 *
 * The sheet's convention (Sam, 2026-09-07, correcting the 2026-07-20 reading):
 *   - A week runs Monday -> Sunday.
 *   - Week 1 is the first Mon-Sun week that BELONGS to the month, and it may
 *     start in the previous month:
 *       Sep 2026 (1st = Tue) -> W1 [31/8-6/9], [7-13], [14-20], [21-27], Rem [28-30]
 *       Aug 2026 (1st = Sat) -> W1 [3-9],      [10-16], [17-23], [24-30], Rem [31]
 *     Sam's words: "ang lumabas sa kanya 31/8 example Week 1 - 31-6/9 una week
 *     ng September ganon kada week".
 *   - "Belongs to the month" = the Mon-Sun block holds at least 4 of the
 *     month's days, i.e. the block containing the 4th. August 2026 opens on a
 *     Saturday, so Sat 1 + Sun 2 sit in the Jul 27-Aug 2 block, only 2 days of
 *     August, and Cath starts August on the 3rd; September's Aug 31 block holds
 *     6 days of September, so she pulls Aug 31 in. This rule reproduces every
 *     Mon-Sun tab she has built: see verifySheetGridRule below.
 *   - Weeks 2-4 follow consecutively (7 days each), capped at the month end.
 *   - Remainder = whatever is left after Week 4's Sunday, up to the last day.
 *
 * Only Week 1 may reach back into the previous month; nothing reaches forward,
 * so a month's last days always land in that month's own Remainder.
 *
 * Until 2026-09-07 Week 1 started on the first Monday ON/AFTER the 1st, which
 * left the days before it in no column at all: for Sep 2026 that hid Sep 1-6
 * from every practitioner-stats view.
 *
 * The CEO dashboard does NOT use this function. It uses getDashboardRanges()
 * below, which numbers differently on purpose; see there.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** Sentinel used for a column that has no real days this month. */
const EMPTY_RANGE = { dateFrom: '9999-12-31', dateTo: '9999-12-31' };

// First Monday on/after the 1st of the month. `month` is 1-indexed; JS Date
// is 0-indexed. Always within days 1..7. getDay() === 1 is Monday.
function firstMondayOf(year: number, month: number): number {
  for (let d = 1; d <= 7; d++) {
    if (new Date(year, month - 1, d).getDay() === 1) return d;
  }
  return 1; // unreachable
}

/**
 * The Monday that opens the sheet's Week 1: the Monday of the Mon-Sun block
 * holding the 4th of the month. A real Date, because it can fall in the
 * PREVIOUS month (Sep 2026 -> Mon 31 Aug).
 *
 * Why the 4th: a Mon-Sun block contains the 4th exactly when it holds 4 or more
 * of that month's days, which is the rule Cath's own tabs follow. See the
 * getWeekRanges doc block above.
 */
function week1MondayOf(year: number, month: number): Date {
  const d   = new Date(year, month - 1, 4);
  const dow = d.getDay();                        // 0 = Sunday, 1 = Monday
  const backToMonday = dow === 0 ? 6 : dow - 1;  // Sunday is 6 days past Monday
  d.setDate(d.getDate() - backToMonday);
  return d;
}

/** `YYYY-MM-DD` for a Date, from local components (never toISOString). */
function isoOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `d` shifted by `n` days, as a new Date. */
function plusDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

export function getWeekRanges(year: number, month: number): SheetWeekRange[] {
  const lastDay  = new Date(year, month, 0).getDate();
  const monthEnd = `${year}-${pad(month)}-${pad(lastDay)}`;
  const week1Mon = week1MondayOf(year, month);

  /** Labels a span the way the sheet does: `[3-9]`, `[31-6]`, `[31]`. */
  const label = (name: string, from: string, to: string): string => {
    const a = Number(from.slice(8));
    const b = Number(to.slice(8));
    return `${name} [${a === b ? a : `${a}-${b}`}]`;
  };

  const weeks: SheetWeekRange[] = [];
  for (let i = 0; i < 4; i++) {
    const from  = isoOf(plusDays(week1Mon, i * 7));
    // Clamped at the month end: only Week 1 reaches into the previous month,
    // nothing reaches into the next one.
    const rawTo = isoOf(plusDays(week1Mon, i * 7 + 6));
    const to    = rawTo > monthEnd ? monthEnd : rawTo;
    weeks.push({
      weekNum:  (i + 1) as 1 | 2 | 3 | 4,
      label:    label(`Week ${i + 1}`, from, to),
      dateFrom: from,
      dateTo:   to,
    });
  }

  const remFrom = isoOf(plusDays(week1Mon, 28));
  const remainder: SheetWeekRange = remFrom <= monthEnd
    ? {
        weekNum:  'remainder',
        label:    label('Remainder', remFrom, monthEnd),
        dateFrom: remFrom,
        dateTo:   monthEnd,
      }
    : {
        // Month ends on/before Week 4's Sunday: nothing left over.
        weekNum:  'remainder',
        label:    'Remainder [—]',
        ...EMPTY_RANGE,
      };

  return [...weeks, remainder];
}

/**
 * Checks the computed Week 1 against every tab Cath has actually built
 * (SHEET_GRID below), so the rule above is asserted rather than claimed.
 *
 * Her Mon-Fri tabs (Jun 2025 - Apr 2026) are included: those columns end on a
 * Friday, so only their START is comparable, and the start is what is compared.
 * `expectedMismatch` marks the tabs where she deliberately did something else
 * (May and Jul 2025 start Week 1 on the 1st, and Oct 2025 / Jan 2026 / Apr 2026
 * park the pre-first-Monday days in the Remainder column instead).
 */
export function verifySheetGridRule(): { ym: string; sheet: string; computed: string; ok: boolean }[] {
  const out: { ym: string; sheet: string; computed: string; ok: boolean }[] = [];
  for (const [ym, cols] of Object.entries(SHEET_GRID)) {
    const first = cols[0];
    if (!first) continue;
    const year  = Number(ym.slice(0, 4));
    const month = Number(ym.slice(5, 7));
    const computed = isoOf(week1MondayOf(year, month));
    out.push({ ym, sheet: first[0], computed, ok: first[0] === computed });
  }
  return out;
}

/**
 * Cath's OWN column ranges, transcribed from the Brookvale CEO Dashboard sheet
 * (`1_ES9l4R5jC1HUgrvYJNlr3QDJmzzOcQFn1rcLIEnLhM`) on 2026-08-06. Sam's
 * instruction: *"i adjust base dun sa nagawa na niyang month sa spreadsheet"* —
 * for a month she has already built, use her ranges verbatim so the dashboard and
 * her sheet tie out column for column.
 *
 * 17 tabs, Feb 2025 - Jun 2026. Each tab was dated by matching its Week 1 start
 * against the calendar (every one lands on that month's first Monday, or the 1st,
 * or a deliberate span into the previous month) — all 17 fit, so the dating is
 * certain. Three further header rows in the file belong to the ORIGINAL TEMPLATE
 * the sheet was copied from (a different business — Wendy/Rex, $1.9M revenue) and
 * are excluded.
 *
 * Her formats are not consistent, and that is the point of transcribing rather
 * than computing: Mon-Sun in Feb/Mar/Apr/Sep 2025 and May/Jun 2026, Mon-Fri from
 * Jun 2025 to Apr 2026, Week 1 starting on the 1st in May and Jul 2025.
 *
 * Two of her own errors are preserved as-is, because matching her is the point:
 *   - Apr 2025 Week 1 is `[31-6]` = Mar 31 -> Apr 6, so **Mar 31 2025 is counted
 *     twice** across the two months (March's Remainder also holds it).
 *   - Aug 1 2025 and May 1 2026 (both Fridays) are in NO column of her grid, so
 *     they are in none of ours either. They remain inside the Monthly Actual.
 * One obvious typo IS corrected: her Sep 2025 Remainder reads `[29-31]` but
 * September has 30 days, so it is clamped to Sep 29-30.
 *
 * `null` = a column she left blank (or filled with a `[#-#]` placeholder).
 */
const SHEET_GRID: Record<string, ([string, string] | null)[]> = {
  '2025-02': [["2025-02-03", "2025-02-09"], ["2025-02-10", "2025-02-16"], ["2025-02-17", "2025-02-23"], ["2025-02-24", "2025-02-28"], null],
  '2025-03': [["2025-03-03", "2025-03-09"], ["2025-03-10", "2025-03-16"], ["2025-03-17", "2025-03-23"], ["2025-03-24", "2025-03-30"], ["2025-03-31", "2025-03-31"]],
  '2025-04': [["2025-03-31", "2025-04-06"], ["2025-04-07", "2025-04-13"], ["2025-04-14", "2025-04-20"], ["2025-04-21", "2025-04-27"], ["2025-04-28", "2025-04-30"]],
  '2025-05': [["2025-05-01", "2025-05-04"], ["2025-05-05", "2025-05-11"], ["2025-05-12", "2025-05-18"], ["2025-05-19", "2025-05-25"], ["2025-05-26", "2025-05-31"]],
  '2025-06': [["2025-06-02", "2025-06-06"], ["2025-06-09", "2025-06-13"], ["2025-06-16", "2025-06-20"], ["2025-06-23", "2025-06-27"], ["2025-06-30", "2025-06-30"]],
  '2025-07': [["2025-07-01", "2025-07-04"], ["2025-07-07", "2025-07-11"], ["2025-07-14", "2025-07-18"], ["2025-07-21", "2025-07-25"], ["2025-07-28", "2025-07-31"]],
  '2025-08': [["2025-08-04", "2025-08-08"], ["2025-08-11", "2025-08-15"], ["2025-08-18", "2025-08-22"], ["2025-08-25", "2025-08-29"], null],
  '2025-09': [["2025-09-01", "2025-09-07"], ["2025-09-08", "2025-09-14"], ["2025-09-15", "2025-09-21"], ["2025-09-22", "2025-09-28"], ["2025-09-29", "2025-09-30"]],
  '2025-10': [["2025-10-06", "2025-10-10"], ["2025-10-13", "2025-10-17"], ["2025-10-20", "2025-10-24"], ["2025-10-27", "2025-10-31"], ["2025-10-01", "2025-10-03"]],
  '2025-11': [["2025-11-03", "2025-11-07"], ["2025-11-10", "2025-11-14"], ["2025-11-17", "2025-11-21"], ["2025-11-24", "2025-11-28"], null],
  '2025-12': [["2025-12-01", "2025-12-05"], ["2025-12-08", "2025-12-12"], ["2025-12-15", "2025-12-19"], ["2025-12-22", "2025-12-26"], ["2025-12-29", "2025-12-31"]],
  '2026-01': [["2026-01-05", "2026-01-09"], ["2026-01-12", "2026-01-16"], ["2026-01-19", "2026-01-23"], ["2026-01-26", "2026-01-30"], ["2026-01-01", "2026-01-02"]],
  '2026-02': [["2026-02-02", "2026-02-06"], ["2026-02-09", "2026-02-13"], ["2026-02-16", "2026-02-20"], ["2026-02-23", "2026-02-27"], null],
  '2026-03': [["2026-03-02", "2026-03-06"], ["2026-03-09", "2026-03-13"], ["2026-03-16", "2026-03-20"], ["2026-03-23", "2026-03-27"], ["2026-03-30", "2026-03-31"]],
  '2026-04': [["2026-04-06", "2026-04-10"], ["2026-04-13", "2026-04-17"], ["2026-04-20", "2026-04-24"], ["2026-04-27", "2026-04-30"], ["2026-04-01", "2026-04-03"]],
  '2026-05': [["2026-05-04", "2026-05-10"], ["2026-05-11", "2026-05-17"], ["2026-05-18", "2026-05-24"], ["2026-05-25", "2026-05-31"], null],
  '2026-06': [["2026-06-01", "2026-06-07"], ["2026-06-08", "2026-06-14"], ["2026-06-15", "2026-06-21"], ["2026-06-22", "2026-06-28"], ["2026-06-29", "2026-06-30"]],
};

/** Renders a transcribed span the way the sheet labels it, e.g. `[3-9]`, `[31-6]`, `[31]`. */
function sheetLabel(name: string, span: [string, string] | null): string {
  if (!span) return `${name} [—]`;
  const a = Number(span[0].slice(8));
  const b = Number(span[1].slice(8));
  return `${name} [${a === b ? a : `${a}-${b}`}]`;
}

/**
 * The CEO dashboard's columns.
 *
 * For any month Cath has already built in the sheet, her ranges are used verbatim
 * (see SHEET_GRID). For every other month — Jul 2026 onward, and anything before
 * Feb 2025 — they are computed:
 *
 *   - Columns run **Monday..Sunday**.
 *   - Week 1 starts on the **1st**, unless the 1st is a Saturday or Sunday, in
 *     which case it waits for the first Monday. A short Week 1 is fine and has
 *     precedent in her own sheet: May 2025 reads `Week 1 [1-4]` = Thu 1 -> Sun 4.
 *   - Weeks 2-4 follow, then whatever is left becomes the Remainder (never more
 *     than 7 days); `[—]` when nothing is left.
 *
 *   Jul 2026 (1st = Wed) -> W1[1-5]  W2[6-12]  W3[13-19] W4[20-26] Rem[27-31]
 *   Aug 2026 (1st = Sat) -> W1[3-9]  W2[10-16] W3[17-23] W4[24-30] Rem[31]
 *   Sep 2026 (1st = Tue) -> W1[1-6]  W2[7-13]  W3[14-20] W4[21-27] Rem[28-30]
 *
 * Always 5 columns. In a computed month every weekday lands in exactly one of
 * them; the only days left out are a Saturday/Sunday that opens the month, which
 * cost nothing (the clinics take no money at weekends — measured). Transcribed
 * months inherit whatever gaps Cath's grid has.
 *
 * Either way the Monthly Actual is fetched over the real calendar month, so it is
 * always complete even when a column leaves a day out.
 *
 * getWeekRanges() above is untouched (sheet numbering, Week 1 = first Monday) and
 * still backs practitioner-stats and the weekly Teams notifier.
 */
export function getDashboardRanges(year: number, month: number): WeekRange[] {
  const transcribed = SHEET_GRID[`${year}-${pad(month)}`];
  if (transcribed) {
    return transcribed.map((span, i) => {
      const name = i < 4 ? `Week ${i + 1}` : 'Remainder';
      const weekNum: WeekNum = i < 4 ? ((i + 1) as 1 | 2 | 3 | 4) : 'remainder';
      return span
        ? { weekNum, label: sheetLabel(name, span), dateFrom: span[0], dateTo: span[1] }
        : { weekNum, label: sheetLabel(name, null), ...EMPTY_RANGE };
    });
  }
  return computedRanges(year, month);
}

function computedRanges(year: number, month: number): WeekRange[] {
  const lastDay  = new Date(year, month, 0).getDate();
  const monthStr = `${year}-${pad(month)}`;
  const dateOf   = (d: number) => `${monthStr}-${pad(d)}`;

  // getDay(): 0 = Sunday, 6 = Saturday. A month opening on the weekend waits for
  // the first Monday; otherwise Week 1 opens on the 1st.
  const dow1  = new Date(year, month - 1, 1).getDay();
  let   start = dow1 === 0 || dow1 === 6 ? firstMondayOf(year, month) : 1;

  /** The Sunday closing the Mon-Sun block that `day` sits in. */
  const sundayOf = (day: number): number => {
    const dow = new Date(year, month - 1, day).getDay(); // 0 = Sunday
    return day + (dow === 0 ? 0 : 7 - dow);
  };

  const cols: WeekRange[] = [];
  for (let i = 0; i < 4; i++) {
    const end = Math.min(sundayOf(start), lastDay);
    cols.push({
      weekNum:  (i + 1) as 1 | 2 | 3 | 4,
      label:    `Week ${i + 1} [${start === end ? start : `${start}-${end}`}]`,
      dateFrom: dateOf(start),
      dateTo:   dateOf(end),
    });
    start = end + 1; // Sunday -> the following Monday
  }

  // Whatever is left after Week 4 — at most one more Mon-Sun block.
  if (start <= lastDay) {
    const end = Math.min(sundayOf(start), lastDay);
    cols.push({
      weekNum:  'remainder',
      label:    `Remainder [${start === end ? start : `${start}-${end}`}]`,
      dateFrom: dateOf(start),
      dateTo:   dateOf(end),
    });
  } else {
    cols.push({ weekNum: 'remainder', label: 'Remainder [—]', ...EMPTY_RANGE });
  }

  return cols;
}

export function getMonthRange(year: number, month: number) {
  const lastDay = new Date(year, month, 0).getDate();
  return {
    // The WHOLE calendar month — including any weekend day the columns leave
    // out, so no takings are lost from the Monthly Actual. This used to start on
    // the first Monday, which silently dropped the pre-first-Monday days from
    // every monthly total.
    dateFrom: `${year}-${pad(month)}-01`,
    dateTo:   `${year}-${pad(month)}-${pad(lastDay)}`,
  };
}
