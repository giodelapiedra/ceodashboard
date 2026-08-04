/**
 * Check if Nookal "passes" (multi-session packages) account for the missing $1,341.
 * Also tries credits with lastModifiedDate filter.
 * Run: npx ts-node-dev --transpile-only src/diag-passes.ts
 */
import { nookalV3 } from './services/nookal-v3/client';
import { CLINICS } from './types';

const PASSES_QUERY = `
  query Passes($locationIDs: [Int], $page: Int!, $pageLength: Int!) {
    passes(locationIDs: $locationIDs, page: $page, pageLength: $pageLength) {
      passID
      clientID
      locationID
      name
      amount
      dateAdded
      dateExpiry
      active
      used
      remaining
    }
  }
`;

const CREDITS_LASTMOD_QUERY = `
  query CreditsLastMod($lastModifiedDateFrom: String!, $lastModifiedDateTo: String!, $page: Int!, $pageLength: Int!) {
    credits(
      lastModifiedDateFrom: $lastModifiedDateFrom,
      lastModifiedDateTo: $lastModifiedDateTo,
      page: $page,
      pageLength: $pageLength
    ) {
      creditID
      locationID
      clientID
      method
      amount
      invoiceID
      date
      void
      fromAdjustment
    }
  }
`;

const pad = (n: number) => String(n).padStart(2, '0');
const MONTH_NUM: Record<string, number> = {
  Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12,
};
function dayISO(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{4})/);
  if (!m) return null;
  const mon = MONTH_NUM[m[1]];
  return mon ? `${m[3]}-${pad(mon)}-${m[2].padStart(2, '0')}` : null;
}
const PAGE = 200;

async function paginate<T>(fetchPage: (p: number) => Promise<T[]>): Promise<T[]> {
  const all: T[] = [];
  for (let p = 1; p <= 100; p++) {
    const rows = await fetchPage(p);
    if (!rows?.length) break;
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

async function main() {
  const locIDs = CLINICS.map((c) => c.v3LocationId);
  const knownIds = new Map(CLINICS.map((c) => [c.v3LocationId, c.name]));

  // ── 1. Passes ─────────────────────────────────────────────────────────────
  console.log('\n=== PASSES (multi-session packages) ===');
  try {
    const passes: any[] = await paginate((p) =>
      nookalV3.query<any>(PASSES_QUERY, { locationIDs: locIDs, page: p, pageLength: PAGE })
        .then((d: any) => d.passes ?? [])
    );

    // Filter for passes added in June 2026
    const juneAdded = passes.filter((p) => {
      const d = dayISO(p.dateAdded);
      return !!d && d >= '2026-06-01' && d <= '2026-06-30';
    });

    console.log(`Total passes across all locations: ${passes.length}`);
    console.log(`Passes added in June 2026: ${juneAdded.length}`);

    const byLoc = new Map<number, number>();
    for (const p of juneAdded) byLoc.set(p.locationID, (byLoc.get(p.locationID) ?? 0) + (p.amount ?? 0));
    let grand = 0;
    for (const [loc, total] of [...byLoc.entries()]) {
      console.log(`  ${(knownIds.get(loc) ?? `unknown(${loc})`).padEnd(12)} $${total.toFixed(2)}`);
      grand += total;
    }
    console.log(`  TOTAL: $${grand.toFixed(2)}`);

    if (juneAdded.length > 0 && juneAdded.length <= 10) {
      console.log('\nSample pass records:');
      for (const p of juneAdded.slice(0, 5)) console.log(' ', JSON.stringify(p));
    }
  } catch (e: any) {
    console.log('passes query failed:', e.message);
  }

  // ── 2. Credits via lastModifiedDate filter ─────────────────────────────────
  console.log('\n=== CREDITS via lastModifiedDate (Jun 2026) ===');
  try {
    const credits: any[] = await paginate((p) =>
      nookalV3.query<any>(CREDITS_LASTMOD_QUERY, {
        lastModifiedDateFrom: '2026-06-01',
        lastModifiedDateTo:   '2026-06-30',
        page: p, pageLength: PAGE,
      }).then((d: any) => d.credits ?? [])
    );

    const juneDisplay = credits.filter((c) => {
      if (c.void) return false;
      if ((c.amount ?? 0) <= 0) return false;
      const d = dayISO(c.date);
      return !!d && d >= '2026-06-01' && d <= '2026-06-30';
    });

    console.log(`Credits with lastModifiedDate in Jun: ${credits.length}`);
    console.log(`Of those, with display date in Jun: ${juneDisplay.length}`);
    const byLoc2 = new Map<number, number>();
    for (const c of juneDisplay) byLoc2.set(c.locationID, (byLoc2.get(c.locationID) ?? 0) + (c.amount ?? 0));
    let grand2 = 0;
    for (const [loc, total] of [...byLoc2.entries()]) {
      console.log(`  ${(knownIds.get(loc) ?? `unknown(${loc})`).padEnd(12)} $${total.toFixed(2)}`);
      grand2 += total;
    }
    console.log(`  TOTAL: $${grand2.toFixed(2)} (Nookal target $50,390.67)`);

    // Show credits found via lastModified but NOT via dateFrom/dateTo
    const byDateRange = new Set<number>(); // placeholder — compare manually
    const extraCredits = credits.filter((c) => {
      if (c.void || (c.amount ?? 0) <= 0) return false;
      const d = dayISO(c.date);
      return !!d && d >= '2026-06-01' && d <= '2026-06-30';
    });
    console.log(`\nExtra credits potentially: check if $${(grand2 - 49049.67).toFixed(2)} above our current $49049.67`);
  } catch (e: any) {
    console.log('credits lastModified query failed:', e.message);
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
