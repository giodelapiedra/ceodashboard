/**
 * READ-ONLY diagnostic: pull Google Ads spend all the way back to 2021 and
 * print the per-year totals, so we can see how much sits OUTSIDE the window
 * the "Sync Google Ads" button uses (Jan 1 of the current year → today).
 * Writes nothing to the DB.
 *   npx ts-node-dev --transpile-only src/scripts/audit-google-ads-alltime.ts
 */
import { fetchGoogleAdsSpend } from '../services/google-ads.service';

const FROM = '2021-01-01';
const TO   = new Date().toISOString().slice(0, 10);

(async () => {
  try {
    const rows = await fetchGoogleAdsSpend(FROM, TO);

    const byYear = new Map<string, number>();
    let grand = 0;
    for (const r of rows) {
      const y = r.spend_date.slice(0, 4);
      byYear.set(y, (byYear.get(y) ?? 0) + r.amount);
      grand += r.amount;
    }

    console.log(`\nGoogle Ads spend ${FROM} → ${TO}  (${rows.length} campaign-day rows)`);
    for (const y of [...byYear.keys()].sort()) {
      console.log(`  ${y}: A$${byYear.get(y)!.toFixed(2)}`);
    }
    console.log(`  ALL TIME: A$${grand.toFixed(2)}`);

    const thisYear = new Date().getFullYear().toString();
    const inWindow = byYear.get(thisYear) ?? 0;
    console.log(`\n  Synced by the button (${thisYear} only): A$${inWindow.toFixed(2)}`);
    console.log(`  MISSING (before ${thisYear}-01-01):        A$${(grand - inWindow).toFixed(2)}`);

    const dates = rows.map(r => r.spend_date).sort();
    console.log(`\n  First spend day: ${dates[0]}   Last spend day: ${dates[dates.length - 1]}`);
  } catch (e: any) {
    console.error('FAILED:', e?.message);
    if (e?.errors) console.error(JSON.stringify(e.errors, null, 2));
  } finally {
    process.exit(0);
  }
})();
