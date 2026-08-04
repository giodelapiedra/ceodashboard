import { WeekRange } from '../types';

/**
 * Build 4 Monday-anchored 7-day weeks for a calendar month, plus a Remainder
 * range for the tail, to MATCH the CEO scorecard Google Sheet exactly.
 *
 * The sheet's convention (confirmed by Sam, 2026-07-20):
 *   - A week runs Monday -> Sunday.
 *   - Week 1 starts on the FIRST Monday on/after the 1st of the month.
 *       May 2026 (1st = Fri) -> Week 1 [4-10], [11-17], [18-24], [25-31]
 *       Mar 2026 (1st = Sun) -> Week 1 [2-8],  [9-15],  [16-22], [23-29]
 *   - Weeks 2-4 follow consecutively (7 days each), capped at the month end.
 *   - Remainder = whatever's left after Week 4's Sunday, up to the last day
 *       (Mar 2026 -> [30-31]; May 2026 -> empty, month ends on a Sunday).
 *   - The few days BEFORE the first Monday (e.g. May 1-3) belong to the
 *       previous month's grid and are NOT counted here. Because of this,
 *       getMonthRange() also starts on the first Monday, so the Monthly
 *       Actual equals the sum of the weekly columns — same as the sheet.
 *
 * (Previously these were fixed day-of-month blocks — days 1-7, 8-14, ... —
 * which drifted up to 6 days off the sheet's Mon-Sun columns.)
 */

const pad = (n: number) => String(n).padStart(2, '0');

// First Monday on/after the 1st of the month. `month` is 1-indexed; JS Date
// is 0-indexed. Always within days 1..7. getDay() === 1 is Monday.
function firstMondayOf(year: number, month: number): number {
  for (let d = 1; d <= 7; d++) {
    if (new Date(year, month - 1, d).getDay() === 1) return d;
  }
  return 1; // unreachable
}

export function getWeekRanges(year: number, month: number): WeekRange[] {
  const lastDay  = new Date(year, month, 0).getDate();
  const monthStr = `${year}-${pad(month)}`;
  const dateOf   = (d: number) => `${monthStr}-${pad(d)}`;
  const firstMon = firstMondayOf(year, month);

  const weeks: WeekRange[] = [];
  for (let i = 0; i < 4; i++) {
    const start = firstMon + i * 7;
    const end   = Math.min(start + 6, lastDay);
    weeks.push({
      weekNum:  (i + 1) as 1 | 2 | 3 | 4,
      label:    `Week ${i + 1} [${start}-${end}]`,
      dateFrom: dateOf(start),
      dateTo:   dateOf(end),
    });
  }

  const remStart = firstMon + 28;
  const remainder: WeekRange = remStart <= lastDay
    ? {
        weekNum:  'remainder',
        label:    `Remainder [${remStart}-${lastDay}]`,
        dateFrom: dateOf(remStart),
        dateTo:   dateOf(lastDay),
      }
    : {
        // Month ends on/before Week 4's Sunday — nothing left over.
        weekNum:  'remainder',
        label:    'Remainder [—]',
        dateFrom: '9999-12-31',
        dateTo:   '9999-12-31',
      };

  return [...weeks, remainder];
}

export function getMonthRange(year: number, month: number) {
  const lastDay  = new Date(year, month, 0).getDate();
  const firstMon = firstMondayOf(year, month);
  return {
    // Starts on the first Monday (not the 1st) so the Monthly Actual equals
    // the sum of the Mon-Sun weekly columns, matching the CEO sheet.
    dateFrom: `${year}-${pad(month)}-${pad(firstMon)}`,
    dateTo:   `${year}-${pad(month)}-${pad(lastDay)}`,
  };
}
