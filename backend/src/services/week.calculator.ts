import { WeekRange } from '../types';

/**
 * Build 4 fixed 7-day blocks (days 1-7, 8-14, 15-21, 22-28) for a calendar
 * month, plus a Remainder range covering whatever's left at the tail
 * (days 29..lastDay). Every day 1..lastDay lands in exactly one bucket, so
 * the weekly columns always sum to the Monthly Actual — no day is ever
 * silently dropped, and every week is always exactly 7 days so week-over-
 * week comparisons stay apples-to-apples.
 *
 * This intentionally does NOT align to Monday — a Monday-anchored version
 * was tried, but it makes Week 4 balloon to 9-13 days in some months (to
 * absorb the tail) and Remainder go empty in others (whenever the month
 * starts on a Monday), which reads as "broken" even though the totals
 * reconcile. Fixed day-of-month blocks avoid both problems entirely.
 */

const pad = (n: number) => String(n).padStart(2, '0');

export function getWeekRanges(year: number, month: number): WeekRange[] {
  const lastDay  = new Date(year, month, 0).getDate();
  const monthStr = `${year}-${pad(month)}`;
  const dateOf   = (d: number) => `${monthStr}-${pad(d)}`;

  const weeks: WeekRange[] = [];
  for (let i = 0; i < 4; i++) {
    const start = i * 7 + 1;
    const end   = Math.min(start + 6, lastDay);
    weeks.push({
      weekNum:  (i + 1) as 1 | 2 | 3 | 4,
      label:    `Week ${i + 1} [${start}-${end}]`,
      dateFrom: dateOf(start),
      dateTo:   dateOf(end),
    });
  }

  const remainder: WeekRange = lastDay > 28
    ? {
        weekNum:  'remainder',
        label:    `Remainder [29-${lastDay}]`,
        dateFrom: dateOf(29),
        dateTo:   dateOf(lastDay),
      }
    : {
        // 28-day February — the 4 weeks already cover the whole month.
        weekNum:  'remainder',
        label:    'Remainder [—]',
        dateFrom: '9999-12-31',
        dateTo:   '9999-12-31',
      };

  return [...weeks, remainder];
}

export function getMonthRange(year: number, month: number) {
  const lastDay = new Date(year, month, 0).getDate();
  return {
    dateFrom: `${year}-${pad(month)}-01`,
    dateTo:   `${year}-${pad(month)}-${pad(lastDay)}`,
  };
}
