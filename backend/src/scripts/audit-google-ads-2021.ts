/**
 * READ-ONLY diagnostic: why the Google Ads UI's all-time Cost tile reads LOWER
 * than our DB. Lists every campaign with spend, its status, and its yearly split
 * — the Campaigns table hides removed campaigns by default, so their spend is
 * missing from the UI but present via the API. Writes nothing.
 *   npx ts-node-dev --transpile-only src/scripts/audit-google-ads-2021.ts
 */
import { GoogleAdsApi } from 'google-ads-api';
import { env } from '../config/env';

(async () => {
  try {
    const client = new GoogleAdsApi({
      client_id:       env.GOOGLE_ADS_CLIENT_ID!,
      client_secret:   env.GOOGLE_ADS_CLIENT_SECRET!,
      developer_token: env.GOOGLE_ADS_DEVELOPER_TOKEN!,
    });
    const customer = client.Customer({
      customer_id:       env.GOOGLE_ADS_CUSTOMER_ID!,
      refresh_token:     env.GOOGLE_ADS_REFRESH_TOKEN!,
      login_customer_id: env.GOOGLE_ADS_MANAGER_ID,
    });

    const rows = await customer.query(`
      SELECT campaign.name, campaign.status, metrics.cost_micros, segments.date
      FROM campaign
      WHERE segments.date BETWEEN '2021-01-01' AND '${new Date().toISOString().slice(0, 10)}'
        AND metrics.cost_micros > 0
    `);

    type Agg = { status: string; total: number; years: Map<string, number> };
    const byCampaign = new Map<string, Agg>();

    for (const r of rows as any[]) {
      const name   = r.campaign.name as string;
      const status = String(r.campaign.status);
      const amt    = Number(r.metrics.cost_micros ?? 0) / 1_000_000;
      const year   = (r.segments.date as string).slice(0, 4);

      let a = byCampaign.get(name);
      if (!a) { a = { status, total: 0, years: new Map() }; byCampaign.set(name, a); }
      a.total += amt;
      a.years.set(year, (a.years.get(year) ?? 0) + amt);
    }

    let grand = 0, removed = 0;
    console.log('\nCampaign                                   Status      Total       Years');
    console.log('-'.repeat(92));
    for (const [name, a] of [...byCampaign.entries()].sort((x, y) => y[1].total - x[1].total)) {
      const years = [...a.years.entries()].sort()
        .map(([y, v]) => `${y}:$${v.toFixed(2)}`).join('  ');
      console.log(
        `${name.slice(0, 40).padEnd(42)} ${a.status.padEnd(11)} $${a.total.toFixed(2).padStart(10)}  ${years}`
      );
      grand += a.total;
      // CampaignStatus enum: 2 = ENABLED, 3 = PAUSED, 4 = REMOVED. Google's
      // Campaigns table hides REMOVED by default (the "2 filters" chip).
      if (a.status === 'REMOVED' || a.status === '4') removed += a.total;
    }

    console.log('-'.repeat(92));
    console.log(`  API all-time total (every status):      A$${grand.toFixed(2)}`);
    console.log(`  ...of which sits in REMOVED campaigns:  A$${removed.toFixed(2)}`);
    console.log(`  What the UI's default view would show:  A$${(grand - removed).toFixed(2)}`);
  } catch (e: any) {
    console.error('FAILED:', e?.message);
    if (e?.errors) console.error(JSON.stringify(e.errors, null, 2));
  } finally {
    process.exit(0);
  }
})();
