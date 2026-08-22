/**
 * Brute-force the exclusion rule behind Nookal's Ageing Debts total.
 *
 * Nookal UI (10-year window, All Locations):  111 invoices — $12,206.83
 * Our current rule:                           221 invoices — $21,370.17
 *
 * Nookal's `contacts` endpoint is not accessible to our API key, so we cannot
 * reconcile payer-by-payer. Instead: define candidate exclusion predicates and
 * search every combination for one that reproduces Nookal's invoice count and
 * dollar total exactly.
 *
 * Reads <scratchpad>/ageing-cache.json (built by diag-ageing-cache.ts).
 * Run: npx ts-node-dev --transpile-only src/diag-ageing-search.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const CACHE_FILE = path.join(
  'C:/Users/GIO/AppData/Local/Temp/claude/D--New-folder--7--PhysioWard-v2/79c8cdd5-9406-4ada-9fd2-d25aced87431/scratchpad',
  'ageing-cache.json'
);

const TARGET_N = 111;
const TARGET_AMT = 12206.83;
// Nookal's per-bucket figures, for a second opinion on any candidate.
const TARGET_BUCKETS = { d0_30: 5306.99, d31_60: 1424.32, d61_90: 784.00, d90p: 4691.52 };

const money = (n: number) =>
  '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Inv {
  invoiceID: number;
  invoiceNumber: string | null;
  clientID: number;
  caseID: number | null;
  locationID: number;
  practitionerID: number | null;
  Total: number;
  TotalPayments: number;
  Balance: number;
  dateCreated: string;
  isThirdPartyInvoice: number;
  credits: Array<{ amount: number; void: number }> | null;
  adjustments: Array<{ amount: number; void: number }> | null;
  refunds: Array<{ amount: number; void: number }> | null;
  entries: Array<{ itemType: string | null; total: number; void: number }> | null;
}

const isStock = (t: string | null) => /stock|product|inventor/i.test(t ?? '');
const sumArr = (a: Array<{ amount: number; void: number }> | null) =>
  (a ?? []).filter((x) => !x.void).reduce((s, x) => s + (x.amount ?? 0), 0);

function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  const all: Inv[] = cache.invoices;
  const clients = new Map<number, any>((cache.clients ?? []).map((c: any) => [c.clientID, c]));
  const staff = new Map<number, any>((cache.staff ?? []).map((s: any) => [s.staffID, s]));
  const now = Date.now();

  const ageDays = (i: Inv) => {
    const d = new Date(i.dateCreated);
    return isNaN(d.getTime()) ? -1 : Math.floor((now - d.getTime()) / 86_400_000);
  };

  // Baseline: the service's current "clean" rule.
  const clean = all.filter((i) => {
    const bal = i.Balance ?? 0, tot = i.Total ?? 0, pmt = i.TotalPayments ?? 0;
    return i.clientID > 0 && bal > 0 && tot > 0 && bal <= tot && pmt < tot;
  });

  console.log('='.repeat(76));
  console.log(`TARGET  ${TARGET_N} invoices  ${money(TARGET_AMT)}`);
  console.log(`ours    ${clean.length} invoices  ${money(clean.reduce((s, i) => s + i.Balance, 0))}`);
  console.log('='.repeat(76));

  // ── Descriptive: how many invoices does each predicate hit? ──
  const preds: Array<[string, (i: Inv) => boolean]> = [
    ['hasStockEntry',      (i) => (i.entries ?? []).some((e) => isStock(e.itemType))],
    ['noPractitioner',     (i) => !i.practitionerID],
    ['noCase',             (i) => !i.caseID],
    ['privateInvoice',     (i) => i.isThirdPartyInvoice === 0],
    ['partlyPaid',         (i) => (i.TotalPayments ?? 0) > 0],
    ['clientInactive',     (i) => (clients.get(i.clientID)?.active ?? 1) != 1],
    ['clientDeceased',     (i) => !!clients.get(i.clientID)?.deceased],
    ['providerInactive',   (i) => (staff.get(i.practitionerID ?? -1)?.status ?? 1) == 0],
    ['hasAdjustment',      (i) => sumArr(i.adjustments) > 0],
    ['hasCredit',          (i) => sumArr(i.credits) > 0],
    ['hasRefund',          (i) => sumArr(i.refunds) > 0],
    ['noInvoiceNumber',    (i) => !i.invoiceNumber?.trim()],
  ];

  console.log('\nPredicate hit counts on our 221 clean invoices:');
  for (const [name, p] of preds) {
    const hit = clean.filter(p);
    console.log(
      `  ${name.padEnd(18)} ${String(hit.length).padStart(4)} inv  ${money(hit.reduce((s, i) => s + i.Balance, 0)).padStart(12)}` +
      `   → keeping the rest: ${String(clean.length - hit.length).padStart(4)} inv  ${money(clean.filter((i) => !p(i)).reduce((s, i) => s + i.Balance, 0))}`
    );
  }

  // ── Amount modes: different definitions of "outstanding" ─────
  const modes: Array<[string, (i: Inv) => number]> = [
    ['Balance',                    (i) => i.Balance ?? 0],
    ['Total - Payments',           (i) => Math.max(0, (i.Total ?? 0) - (i.TotalPayments ?? 0))],
    ['nonVoidEntries - Payments',  (i) => Math.max(0, (i.entries ?? []).filter((e) => !e.void).reduce((s, e) => s + (e.total ?? 0), 0) - (i.TotalPayments ?? 0))],
    ['nonStockEntries - Payments', (i) => Math.max(0, (i.entries ?? []).filter((e) => !e.void && !isStock(e.itemType)).reduce((s, e) => s + (e.total ?? 0), 0) - (i.TotalPayments ?? 0))],
    ['Balance - credits',          (i) => Math.max(0, (i.Balance ?? 0) - sumArr(i.credits))],
    ['Balance - adjustments',      (i) => Math.max(0, (i.Balance ?? 0) - sumArr(i.adjustments))],
  ];

  // ── Combination search over exclusion predicates ─────────────
  console.log('\n' + '='.repeat(76));
  console.log('COMBINATION SEARCH  (exclude any subset of predicates × amount mode)');
  console.log('='.repeat(76));

  interface Hit { modeName: string; excluded: string[]; n: number; amt: number; }
  const exact: Hit[] = [];
  const countOnly: Hit[] = [];
  const nearest: Hit[] = [];

  const K = preds.length;
  for (const [modeName, amountOf] of modes) {
    for (let mask = 0; mask < (1 << K); mask++) {
      const active = preds.filter((_, idx) => mask & (1 << idx));
      const kept = clean.filter((i) => !active.some(([, p]) => p(i)) && amountOf(i) > 0);
      const amt = kept.reduce((s, i) => s + amountOf(i), 0);
      const rec: Hit = { modeName, excluded: active.map(([n]) => n), n: kept.length, amt };

      const amtOk = Math.abs(amt - TARGET_AMT) < 0.01;
      const nOk = kept.length === TARGET_N;
      if (amtOk && nOk) exact.push(rec);
      else if (amtOk || nOk) countOnly.push(rec);
      nearest.push(rec);
    }
  }

  if (exact.length) {
    console.log(`\n*** ${exact.length} EXACT MATCH(ES) — count AND amount ***`);
    for (const h of exact.slice(0, 10)) {
      console.log(`  mode=${h.modeName}  exclude: ${h.excluded.join(' + ') || '(nothing)'}`);
    }
  } else {
    console.log('\nNo combination reproduces both the count and the amount.');
  }

  if (countOnly.length) {
    console.log(`\n${countOnly.length} partial match(es) — count OR amount, showing best 15:`);
    const seen = new Set<string>();
    for (const h of countOnly.slice(0, 400)) {
      const key = `${h.modeName}|${h.n}|${h.amt.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > 15) break;
      const tag = h.n === TARGET_N ? 'COUNT✓' : 'AMOUNT✓';
      console.log(`  ${tag}  ${String(h.n).padStart(4)} inv ${money(h.amt).padStart(12)}  mode=${h.modeName}  exclude: ${h.excluded.join(' + ') || '(nothing)'}`);
    }
  }

  console.log('\nClosest 12 by dollar distance:');
  nearest.sort((a, b) => Math.abs(a.amt - TARGET_AMT) - Math.abs(b.amt - TARGET_AMT));
  for (const h of nearest.slice(0, 12)) {
    console.log(
      `  ${String(h.n).padStart(4)} inv ${money(h.amt).padStart(12)}  off by ${money(h.amt - TARGET_AMT).padStart(11)}  mode=${h.modeName.padEnd(26)} exclude: ${h.excluded.join(' + ') || '(nothing)'}`
    );
  }

  // ── Bucket comparison for the raw clean set ──────────────────
  const buckets = { d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0 };
  for (const i of clean) {
    const a = ageDays(i), b = i.Balance;
    if (a <= 30) buckets.d0_30 += b;
    else if (a <= 60) buckets.d31_60 += b;
    else if (a <= 90) buckets.d61_90 += b;
    else buckets.d90p += b;
  }
  console.log('\n' + '='.repeat(76));
  console.log('BUCKETS — ours vs Nookal');
  console.log('='.repeat(76));
  for (const k of ['d0_30', 'd31_60', 'd61_90', 'd90p'] as const) {
    const o = buckets[k], t = TARGET_BUCKETS[k];
    console.log(`  ${k.padEnd(8)} ours ${money(o).padStart(12)}   nookal ${money(t).padStart(12)}   diff ${money(o - t).padStart(12)}`);
  }

  // ── Age distribution sanity: are there invoices dated in the future? ──
  const future = clean.filter((i) => ageDays(i) < 0);
  if (future.length) console.log(`\n${future.length} invoices dated in the FUTURE (age < 0), ${money(future.reduce((s, i) => s + i.Balance, 0))}`);

  // ── Biggest single balances — worth eyeballing against the UI ──
  console.log('\nTop 15 balances in our set (eyeball these against Nookal):');
  for (const i of [...clean].sort((a, b) => b.Balance - a.Balance).slice(0, 15)) {
    const c = clients.get(i.clientID);
    const nm = c ? `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() : `client#${i.clientID}`;
    const types = [...new Set((i.entries ?? []).map((e) => e.itemType))].join('/');
    console.log(
      `  inv ${String(i.invoiceID).padEnd(7)} ${money(i.Balance).padStart(10)} of ${money(i.Total).padStart(10)}` +
      ` paid ${money(i.TotalPayments).padStart(9)}  age ${String(ageDays(i)).padStart(5)}d  3P=${i.isThirdPartyInvoice}` +
      `  ${types.padEnd(18)} ${nm}`
    );
  }
  console.log('');
}

main();
