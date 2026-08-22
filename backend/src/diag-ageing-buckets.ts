/**
 * Our 61–90 bucket is LOWER than Nookal's ($758.22 vs $784.00) while every
 * other bucket is higher. A pure "we include extra invoices" story cannot do
 * that — so Nookal must age invoices from a different date field and/or with
 * different bucket boundaries.
 *
 * Try each candidate age basis × boundary convention and score against
 * Nookal's published buckets.
 *
 * Run: npx ts-node-dev --transpile-only src/diag-ageing-buckets.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const CACHE_FILE = path.join(
  'C:/Users/GIO/AppData/Local/Temp/claude/D--New-folder--7--PhysioWard-v2/79c8cdd5-9406-4ada-9fd2-d25aced87431/scratchpad',
  'ageing-cache.json'
);

const NK = { d0_30: 5306.99, d31_60: 1424.32, d61_90: 784.00, d90p: 4691.52 };
const NK_TOTAL = 12206.83;

const money = (n: number) =>
  '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Calendar date in Sydney, as YYYY-MM-DD. */
function sydDate(d: Date): string | null {
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(d);
}
/** Whole days between two YYYY-MM-DD strings. */
function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.UTC(+fromISO.slice(0, 4), +fromISO.slice(5, 7) - 1, +fromISO.slice(8, 10));
  const b = Date.UTC(+toISO.slice(0, 4), +toISO.slice(5, 7) - 1, +toISO.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  const all: any[] = cache.invoices;
  const today = sydDate(new Date())!;

  const clean = all.filter((i) => {
    const bal = i.Balance ?? 0, tot = i.Total ?? 0, pmt = i.TotalPayments ?? 0;
    return i.clientID > 0 && bal > 0 && tot > 0 && bal <= tot && pmt < tot;
  });
  console.log(`clean set: ${clean.length} invoices, ${money(clean.reduce((s, i) => s + i.Balance, 0))}`);
  console.log(`nookal:    111 invoices, ${money(NK_TOTAL)}\n`);

  // How many invoices even have an ApptDate?
  const withAppt = clean.filter((i) => !!i.ApptDate && !isNaN(new Date(i.ApptDate).getTime()));
  console.log(`invoices with a usable ApptDate: ${withAppt.length}/${clean.length}`);

  // Also: earliest non-void entry date is another plausible "service date".
  const entryDate = (i: any): string | null => {
    const ds = (i.entries ?? [])
      .filter((e: any) => !e.void && e.date)
      .map((e: any) => sydDate(new Date(e.date)))
      .filter(Boolean) as string[];
    return ds.length ? ds.sort()[0] : null;
  };
  const withEntry = clean.filter((i) => !!entryDate(i));
  console.log(`invoices with a usable entry date:  ${withEntry.length}/${clean.length}\n`);

  const bases: Array<[string, (i: any) => string | null]> = [
    ['dateCreated',            (i) => sydDate(new Date(i.dateCreated))],
    ['ApptDate',               (i) => (i.ApptDate ? sydDate(new Date(i.ApptDate)) : null)],
    ['ApptDate else created',  (i) => (i.ApptDate ? sydDate(new Date(i.ApptDate)) : sydDate(new Date(i.dateCreated)))],
    ['earliest entry date',    (i) => entryDate(i)],
    ['entry date else created',(i) => entryDate(i) ?? sydDate(new Date(i.dateCreated))],
    ['lastModified',           (i) => (i.lastModified ? sydDate(new Date(i.lastModified)) : null)],
  ];

  // Boundary conventions: where does each bucket end?
  const bounds: Array<[string, [number, number, number]]> = [
    ['30/60/90 inclusive', [30, 60, 90]],
    ['29/59/89',           [29, 59, 89]],
    ['31/61/91',           [31, 61, 91]],
  ];

  interface Row { basis: string; bound: string; b: any; total: number; err: number; n: number }
  const rows: Row[] = [];

  for (const [basisName, basisOf] of bases) {
    for (const [boundName, [b1, b2, b3]] of bounds) {
      const b = { d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0 };
      let n = 0;
      for (const i of clean) {
        const iso = basisOf(i);
        if (!iso) continue;
        n++;
        const age = daysBetween(iso, today);
        const bal = i.Balance ?? 0;
        if (age <= b1) b.d0_30 += bal;
        else if (age <= b2) b.d31_60 += bal;
        else if (age <= b3) b.d61_90 += bal;
        else b.d90p += bal;
      }
      const total = b.d0_30 + b.d31_60 + b.d61_90 + b.d90p;
      // Score on bucket SHAPE (share of total), so the count mismatch doesn't
      // swamp the comparison — we want to know if the ageing basis lines up.
      const err =
        Math.abs(b.d0_30 / total - NK.d0_30 / NK_TOTAL) +
        Math.abs(b.d31_60 / total - NK.d31_60 / NK_TOTAL) +
        Math.abs(b.d61_90 / total - NK.d61_90 / NK_TOTAL) +
        Math.abs(b.d90p / total - NK.d90p / NK_TOTAL);
      rows.push({ basis: basisName, bound: boundName, b, total, err, n });
    }
  }

  rows.sort((a, b) => a.err - b.err);
  console.log('Ranked by how closely the bucket SHAPE matches Nookal (lower = better):\n');
  console.log(`${'basis'.padEnd(24)} ${'bounds'.padEnd(20)} ${'0-30'.padStart(11)} ${'31-60'.padStart(11)} ${'61-90'.padStart(11)} ${'90+'.padStart(11)}  shapeErr`);
  console.log('-'.repeat(104));
  console.log(`${'NOOKAL'.padEnd(24)} ${''.padEnd(20)} ${money(NK.d0_30).padStart(11)} ${money(NK.d31_60).padStart(11)} ${money(NK.d61_90).padStart(11)} ${money(NK.d90p).padStart(11)}`);
  console.log(`${''.padEnd(24)} ${'(share of total)'.padEnd(20)} ${(NK.d0_30 / NK_TOTAL * 100).toFixed(1).padStart(10)}% ${(NK.d31_60 / NK_TOTAL * 100).toFixed(1).padStart(10)}% ${(NK.d61_90 / NK_TOTAL * 100).toFixed(1).padStart(10)}% ${(NK.d90p / NK_TOTAL * 100).toFixed(1).padStart(10)}%`);
  console.log('-'.repeat(104));
  for (const r of rows) {
    console.log(
      `${r.basis.padEnd(24)} ${r.bound.padEnd(20)} ${money(r.b.d0_30).padStart(11)} ${money(r.b.d31_60).padStart(11)} ${money(r.b.d61_90).padStart(11)} ${money(r.b.d90p).padStart(11)}  ${r.err.toFixed(3)}  (n=${r.n})`
    );
  }

  // Does any basis put exactly Nookal's $784.00 in 61–90?
  console.log('\nAny basis/bound landing on Nookal\'s exact 61–90 figure ($784.00)?');
  const hits = rows.filter((r) => Math.abs(r.b.d61_90 - NK.d61_90) < 0.01);
  console.log(hits.length ? hits.map((r) => `  ${r.basis} / ${r.bound}`).join('\n') : '  none');
  console.log('');
}

main();
