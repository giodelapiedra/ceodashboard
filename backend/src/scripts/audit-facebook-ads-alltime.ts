/**
 * READ-ONLY diagnostic: pull Facebook/Meta ad spend as far back as the Insights
 * API allows (37-month lookback) and print per-year totals, so we can see how
 * much sits OUTSIDE the window the "Sync Facebook Ads" button uses.
 * Writes nothing to the DB.
 *   npx ts-node-dev --transpile-only src/scripts/audit-facebook-ads-alltime.ts
 */
import { fetchFacebookAdsSpend } from '../services/facebook-ads.service';

// Meta rejects a start date more than 37 months back — same floor the sync
// button uses (36 months, one month of head-room).
const floor = new Date();
floor.setMonth(floor.getMonth() - 36);
const FROM = floor.toISOString().slice(0, 10);
const TO   = new Date().toISOString().slice(0, 10);

(async () => {
  try {
    const rows = await fetchFacebookAdsSpend(FROM, TO);

    const byYear = new Map<string, number>();
    let grand = 0;
    for (const r of rows) {
      const y = r.spend_date.slice(0, 4);
      byYear.set(y, (byYear.get(y) ?? 0) + r.amount);
      grand += r.amount;
    }

    console.log(`\nFacebook Ads spend ${FROM} → ${TO}  (${rows.length} campaign-day rows)`);
    for (const y of [...byYear.keys()].sort()) {
      console.log(`  ${y}: A$${byYear.get(y)!.toFixed(2)}`);
    }
    console.log(`  TOTAL (37-month window): A$${grand.toFixed(2)}`);

    const thisYear = new Date().getFullYear().toString();
    const inWindow = byYear.get(thisYear) ?? 0;
    console.log(`\n  Old button window (${thisYear} only): A$${inWindow.toFixed(2)}`);
    console.log(`  MISSING (before ${thisYear}-01-01):    A$${(grand - inWindow).toFixed(2)}`);

    if (rows.length) {
      const dates = rows.map(r => r.spend_date).sort();
      console.log(`\n  First spend day: ${dates[0]}   Last spend day: ${dates[dates.length - 1]}`);
    }
  } catch (e: any) {
    console.error('FAILED:', e?.message);
    if (e?.details) console.error(JSON.stringify(e.details, null, 2));
  } finally {
    process.exit(0);
  }
})();
