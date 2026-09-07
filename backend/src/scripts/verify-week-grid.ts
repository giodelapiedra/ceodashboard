/**
 * Asserts the Practitioner Stats week grid: Week 1 = the first Mon-Sun week
 * that belongs to the month (the block holding the 4th), per Sam 2026-09-07.
 *
 * Compares against every Week 1 start Cath actually typed (SHEET_GRID) and
 * prints the computed grid for the months in play.
 */
import { getWeekRanges, verifySheetGridRule } from '../services/week.calculator';

const DELIBERATE: Record<string, string> = {
  '2025-05': 'she started Week 1 on the 1st (Thu)',
  '2025-07': 'she started Week 1 on the 1st (Tue)',
  '2025-10': 'pre-first-Monday days parked in her Remainder column',
  '2026-01': 'pre-first-Monday days parked in her Remainder column',
  '2026-04': 'pre-first-Monday days parked in her Remainder column',
};

let fails = 0;
console.log('tab      sheet W1     computed W1   verdict');
for (const r of verifySheetGridRule()) {
  const note = r.ok ? 'match' : (DELIBERATE[r.ym] ? `differs (known: ${DELIBERATE[r.ym]})` : 'MISMATCH');
  if (!r.ok && !DELIBERATE[r.ym]) fails++;
  console.log(`${r.ym}  ${r.sheet}   ${r.computed}   ${note}`);
}

console.log('\ncomputed grid:');
for (const [y, m] of [[2026,7],[2026,8],[2026,9],[2026,10],[2026,11],[2026,12]] as const) {
  console.log(`${y}-${String(m).padStart(2,'0')}  ` +
    getWeekRanges(y, m).map(w => `${w.label}=${w.dateFrom}..${w.dateTo}`).join('  '));
}

console.log(fails === 0 ? '\nOK: every tab that is not a known deliberate exception matches.' : `\nFAILED: ${fails} unexplained mismatch(es).`);
process.exit(fails === 0 ? 0 : 1);
