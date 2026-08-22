/**
 * Reconcile our Ageing Debts figure against Nookal's Ageing Debts report.
 *
 * Nookal UI (Date 11/08/2016–11/08/2026, All Locations, 30/31 Providers,
 * All Private & 164 Third-Party, 183/187 Services, No Inventory):
 *   111 invoices — $12,206.83
 *
 * Ours (ageing-debts.service.ts, same window):
 *   221 invoices — $21,370.17
 *
 * Nookal groups by PAYER ("Type" column), so we group the same way and diff
 * row by row. Whatever pattern shows up in the payers where we are HIGHER is
 * the exclusion rule we're missing.
 *
 * Run: npx ts-node-dev --transpile-only src/diag-ageing-vs-nookal.ts
 */
import { nookalV3 } from './services/nookal-v3/client';
import {
  INVOICES_BY_DATE_BALANCE_QUERY,
  InvoicesByDateBalanceResult,
  V3InvoiceBalance,
  PAGE_LENGTH,
} from './services/nookal-v3/queries';

// ── Nookal's report, transcribed from the UI ─────────────────────
// Note: "icare GIO" and "NRMA CTP" each appear as TWO rows (duplicate payer
// records in Nookal); merged here since we group by name.
const NOOKAL: Array<[string, number, number]> = [
  // [payer, invoices, amount]
  ['Plan Partners Pty Ltd',            10, 1370.00],
  ['QBE Work Cover',                   13, 1360.50],
  ['Qantas Airways',                    9, 1025.70],
  ['bodycare',                          8,  924.00],
  ['NDIS',                              5,  830.97],
  ['WorkCoverAllianz',                  8,  785.20],
  ['BUPA ADF',                          7,  600.04],
  ['icare Allianz',                     6,  568.10],
  ['Allianz',                           3,  478.40],
  ['[Private]',                         3,  447.00],
  ['WorkCoverEML',                      5,  425.10],
  ['icare Insurance EML',               3,  398.70],
  ['youi CTP',                          3,  302.70],
  ['SunCorp CTP',                       2,  250.30],
  ['DVA',                               4,  231.62],
  ['NRMA CTP',                          3,  238.40],  // 2 rows merged: 234.00 + 4.40
  ['icare GIO',                         2,  250.30],  // 2 rows merged: 149.40 + 100.90
  ['Glascott',                          1,  218.50],
  ['NRMA CTP Insurance',                2,  201.80],
  ["GIO Worker's Compensation",         2,  201.80],
  ['EML',                               2,  201.80],
  ['icare',                             2,  201.80],
  ['Northern Beaches Council',          1,  100.90],
  ['QBE CTP',                           1,  100.90],
  ['Hospitality Industry Insurance',    1,  100.90],
  ['Workcover QLD',                     1,  100.90],
  ['icare EML',                         1,   96.50],
  ['icare Gallagher Bassett',           1,   96.50],
  ['Virgin Australia',                  1,   96.50],
  ['private',                           1,    1.00],
];
const NOOKAL_TOTAL_INV = 111;
const NOOKAL_TOTAL_AMT = 12206.83;

// ── Rich invoice query: everything that could reduce Balance ─────
const RICH_QUERY = /* GraphQL */ `
  query RichInvoices($invoiceIDs: [Int], $void: Int, $page: Int!, $pageLength: Int!) {
    invoices(invoiceIDs: $invoiceIDs, void: $void, page: $page, pageLength: $pageLength) {
      invoiceID
      invoiceNumber
      clientID
      caseID
      locationID
      practitionerID
      Total
      TotalPayments
      Balance
      dateCreated
      isThirdPartyInvoice
      void
      thirdParty { thirdPartyID name status type expiryDate }
      credits     { creditID amount void }
      adjustments { adjustmentID amount void }
      refunds     { refundID amount void isCreditRefund }
      entries     { entryID itemType name category total void ItemID }
    }
  }
`;

interface RichInvoice {
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
  void: number;
  thirdParty: Array<{ thirdPartyID: number; name: string | null; status: number | null; type: string | null; expiryDate: string | null }> | null;
  credits: Array<{ creditID: number; amount: number; void: number }> | null;
  adjustments: Array<{ adjustmentID: number; amount: number; void: number }> | null;
  refunds: Array<{ refundID: number; amount: number; void: number; isCreditRefund: number }> | null;
  entries: Array<{ entryID: number; itemType: string | null; name: string | null; category: string | null; total: number; void: number; ItemID: number | null }> | null;
}

const BATCH = 8;
const money = (n: number) =>
  '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function todayAEST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
}

function isClean(i: { clientID: number; Balance: number; Total: number; TotalPayments: number }): boolean {
  const bal = i.Balance ?? 0, tot = i.Total ?? 0, pmt = i.TotalPayments ?? 0;
  return i.clientID > 0 && bal > 0 && tot > 0 && bal <= tot && pmt < tot;
}

async function fetchLight(dateFrom: string, dateTo: string): Promise<V3InvoiceBalance[]> {
  const all: V3InvoiceBalance[] = [];
  let batchStart = 1;
  for (let round = 0; round < 200; round++) {
    const pages = Array.from({ length: BATCH }, (_, i) => batchStart + i);
    const results = await Promise.all(
      pages.map((p) =>
        nookalV3.query<InvoicesByDateBalanceResult>(INVOICES_BY_DATE_BALANCE_QUERY, {
          dateFrom, dateTo, void: 0, page: p, pageLength: PAGE_LENGTH,
        }).then((r) => r.invoices ?? [])
      )
    );
    let done = false;
    for (const rows of results) {
      if (!rows.length) { done = true; break; }
      all.push(...rows);
      if (rows.length < PAGE_LENGTH) { done = true; break; }
    }
    if (done) break;
    batchStart += BATCH;
    process.stdout.write(`\r  … ${all.length}`);
  }
  process.stdout.write(`\r  … ${all.length} invoices\n`);
  return all;
}

async function fetchRich(ids: number[]): Promise<RichInvoice[]> {
  const out: RichInvoice[] = [];
  const CHUNK = 40;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const r = await nookalV3.query<{ invoices: RichInvoice[] }>(RICH_QUERY, {
      invoiceIDs: slice, void: 0, page: 1, pageLength: PAGE_LENGTH,
    });
    out.push(...(r.invoices ?? []));
    process.stdout.write(`\r  … ${out.length}/${ids.length}`);
  }
  process.stdout.write(`\r  … ${out.length}/${ids.length} detailed\n`);
  return out;
}

const payerOf = (i: RichInvoice): string => {
  const tp = (i.thirdParty ?? []).find((t) => t.name && t.name.trim());
  return tp?.name?.trim() ?? '[Private]';
};

const sumArr = (a: Array<{ amount: number; void: number }> | null, includeVoid = false) =>
  (a ?? []).filter((x) => includeVoid || !x.void).reduce((s, x) => s + (x.amount ?? 0), 0);

async function main() {
  const today = todayAEST();
  const [y, m, d] = today.split('-');
  const from = `${Number(y) - 10}-${m}-${d}`;

  console.log('='.repeat(78));
  console.log(`RECONCILE AGEING vs NOOKAL   window ${from} → ${today}`);
  console.log(`Nookal report: ${NOOKAL_TOTAL_INV} invoices, ${money(NOOKAL_TOTAL_AMT)}`);
  console.log('='.repeat(78));

  console.log('\nPass 1 — light pull to find invoices with a balance …');
  const light = await fetchLight(from, today);
  const cutoff = new Date(`${from}T00:00:00+10:00`).getTime();
  const pool = light.filter((i) => {
    const dt = new Date(i.dateCreated);
    return !isNaN(dt.getTime()) && dt.getTime() >= cutoff;
  });
  const candidates = pool.filter((i) => (i.Balance ?? 0) > 0);
  console.log(`  ${pool.length} in window, ${candidates.length} with Balance > 0`);

  console.log('\nPass 2 — full detail for those invoices …');
  const rich = await fetchRich(candidates.map((i) => i.invoiceID));

  const clean = rich.filter(isClean);
  const ourTotal = clean.reduce((s, i) => s + i.Balance, 0);
  console.log(`\nOur clean set: ${clean.length} invoices, ${money(ourTotal)}`);
  console.log(`Gap vs Nookal: ${clean.length - NOOKAL_TOTAL_INV} invoices, ${money(ourTotal - NOOKAL_TOTAL_AMT)}`);

  // ── Per-payer diff ────────────────────────────────────────────
  const expected = new Map(NOOKAL.map(([n, c, a]) => [n.toLowerCase(), { c, a }]));
  const byPayer = new Map<string, RichInvoice[]>();
  for (const i of clean) {
    const p = payerOf(i);
    if (!byPayer.has(p)) byPayer.set(p, []);
    byPayer.get(p)!.push(i);
  }

  console.log('\n' + '='.repeat(78));
  console.log('PER-PAYER DIFF   (ours vs Nookal)');
  console.log('='.repeat(78));
  console.log(
    `${'Payer'.padEnd(32)} ${'ourN'.padStart(5)} ${'nkN'.padStart(4)} ${'our $'.padStart(12)} ${'nookal $'.padStart(12)} ${'diff $'.padStart(12)}`
  );
  console.log('-'.repeat(78));

  const rows = [...byPayer.entries()].sort(
    (a, b) => b[1].reduce((s, i) => s + i.Balance, 0) - a[1].reduce((s, i) => s + i.Balance, 0)
  );

  let matchedPayers = 0;
  const suspects: RichInvoice[] = [];

  for (const [payer, invs] of rows) {
    const ourAmt = invs.reduce((s, i) => s + i.Balance, 0);
    const exp = expected.get(payer.toLowerCase());
    const nkN = exp?.c ?? 0;
    const nkA = exp?.a ?? 0;
    const diff = ourAmt - nkA;
    const flag = Math.abs(diff) < 0.01 ? ' ' : (exp ? '~' : 'X');
    if (Math.abs(diff) < 0.01) matchedPayers++;
    else suspects.push(...invs);
    console.log(
      `${flag} ${payer.slice(0, 30).padEnd(30)} ${String(invs.length).padStart(5)} ${String(nkN).padStart(4)} ${money(ourAmt).padStart(12)} ${money(nkA).padStart(12)} ${money(diff).padStart(12)}`
    );
  }

  // Payers Nookal lists that we produce nothing for.
  for (const [name, { c, a }] of expected) {
    if (![...byPayer.keys()].some((k) => k.toLowerCase() === name)) {
      console.log(`M ${name.slice(0, 30).padEnd(30)} ${'0'.padStart(5)} ${String(c).padStart(4)} ${money(0).padStart(12)} ${money(a).padStart(12)} ${money(-a).padStart(12)}`);
    }
  }
  console.log('-'.repeat(78));
  console.log(`legend:  (blank)=exact match   ~=amount differs   X=payer not in Nookal report   M=missing on our side`);
  console.log(`${matchedPayers} of ${rows.length} payers match to the cent.`);

  // ── What distinguishes the suspects? ──────────────────────────
  console.log('\n' + '='.repeat(78));
  console.log('WHAT IS DIFFERENT ABOUT THE EXTRA INVOICES?');
  console.log('='.repeat(78));

  const inNookalPayer = (i: RichInvoice) => expected.has(payerOf(i).toLowerCase());
  const extra = clean.filter((i) => !inNookalPayer(i));
  console.log(`\nInvoices whose payer is absent from Nookal's 32 rows: ${extra.length}, ${money(extra.reduce((s, i) => s + i.Balance, 0))}`);

  const tally = (label: string, rows2: RichInvoice[], pred: (i: RichInvoice) => boolean) => {
    const hit = rows2.filter(pred);
    if (!hit.length) return;
    console.log(`  ${label.padEnd(42)} ${String(hit.length).padStart(4)} inv  ${money(hit.reduce((s, i) => s + i.Balance, 0))}`);
  };

  console.log('\nAttributes of ALL our clean invoices:');
  tally('no invoiceNumber (draft)',           clean, (i) => !i.invoiceNumber?.trim());
  tally('practitionerID missing/0',           clean, (i) => !i.practitionerID);
  tally('no caseID',                          clean, (i) => !i.caseID);
  tally('has active credits',                 clean, (i) => sumArr(i.credits) > 0);
  tally('has active adjustments',             clean, (i) => sumArr(i.adjustments) > 0);
  tally('has active refunds',                 clean, (i) => sumArr(i.refunds) > 0);
  tally('no thirdParty record',               clean, (i) => !(i.thirdParty ?? []).length);
  tally('thirdParty status != 1',             clean, (i) => (i.thirdParty ?? []).some((t) => t.status !== 1));
  tally('isThirdPartyInvoice = 0',            clean, (i) => i.isThirdPartyInvoice === 0);
  tally('has a Stock/inventory entry',        clean, (i) => (i.entries ?? []).some((e) => /stock|product|inventor/i.test(e.itemType ?? '')));
  tally('ALL entries are Stock/inventory',    clean, (i) => (i.entries ?? []).length > 0 && (i.entries ?? []).every((e) => /stock|product|inventor/i.test(e.itemType ?? '')));
  tally('no entries at all',                  clean, (i) => !(i.entries ?? []).length);
  tally('all entries voided',                 clean, (i) => (i.entries ?? []).length > 0 && (i.entries ?? []).every((e) => !!e.void));

  // Distribution of itemType across entries on invoices with a balance.
  const typeAgg = new Map<string, { n: number; total: number }>();
  for (const i of clean) {
    for (const e of i.entries ?? []) {
      const k = `${e.itemType ?? '(null)'}${e.void ? ' [VOID]' : ''}`;
      const cur = typeAgg.get(k) ?? { n: 0, total: 0 };
      cur.n++; cur.total += e.total ?? 0;
      typeAgg.set(k, cur);
    }
  }
  console.log('\nEntry itemType distribution (on invoices with a balance):');
  for (const [k, v] of [...typeAgg.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${k.padEnd(30)} ${String(v.n).padStart(5)} entries  ${money(v.total)}`);
  }

  // Provider distribution — Nookal had "30 of 31 providers".
  const provAgg = new Map<number, { n: number; total: number }>();
  for (const i of clean) {
    const p = i.practitionerID ?? 0;
    const cur = provAgg.get(p) ?? { n: 0, total: 0 };
    cur.n++; cur.total += i.Balance;
    provAgg.set(p, cur);
  }
  console.log('\nBy practitionerID:');
  for (const [p, v] of [...provAgg.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${String(p).padEnd(8)} ${String(v.n).padStart(5)} inv  ${money(v.total)}`);
  }

  // ── Does an alternative balance definition hit the target? ────
  console.log('\n' + '='.repeat(78));
  console.log('CANDIDATE TOTALS — looking for ' + money(NOOKAL_TOTAL_AMT));
  console.log('='.repeat(78));
  const cands: Array<[string, RichInvoice[]]> = [
    ['clean (current dashboard rule)',            clean],
    ['clean, payer present in Nookal report',     clean.filter(inNookalPayer)],
    ['clean, has invoiceNumber',                  clean.filter((i) => !!i.invoiceNumber?.trim())],
    ['clean, has practitionerID',                 clean.filter((i) => !!i.practitionerID)],
    ['clean, has caseID',                         clean.filter((i) => !!i.caseID)],
    ['clean, no stock entries',                   clean.filter((i) => !(i.entries ?? []).some((e) => /stock|product|inventor/i.test(e.itemType ?? '')))],
    ['clean, has a thirdParty record',            clean.filter((i) => (i.thirdParty ?? []).length > 0)],
    ['clean, no credits',                         clean.filter((i) => sumArr(i.credits) === 0)],
    ['clean, no adjustments',                     clean.filter((i) => sumArr(i.adjustments) === 0)],
    ['clean, has non-void entries',               clean.filter((i) => (i.entries ?? []).some((e) => !e.void))],
  ];
  for (const [label, set] of cands) {
    const amt = set.reduce((s, i) => s + i.Balance, 0);
    const hit = Math.abs(amt - NOOKAL_TOTAL_AMT) < 0.01 ? '  <<< EXACT MATCH' : '';
    console.log(`  ${label.padEnd(44)} ${String(set.length).padStart(4)} inv  ${money(amt).padStart(13)}${hit}`);
  }

  // Balance minus credits/adjustments, on the full clean set.
  const minusCredits = clean.reduce((s, i) => s + Math.max(0, i.Balance - sumArr(i.credits)), 0);
  const minusBoth = clean.reduce((s, i) => s + Math.max(0, i.Balance - sumArr(i.credits) - sumArr(i.adjustments)), 0);
  const nonVoidEntries = clean.reduce((s, i) => {
    const ent = (i.entries ?? []).filter((e) => !e.void).reduce((t, e) => t + (e.total ?? 0), 0);
    return s + Math.max(0, ent - i.TotalPayments);
  }, 0);
  const nonStockEntries = clean.reduce((s, i) => {
    const ent = (i.entries ?? [])
      .filter((e) => !e.void && !/stock|product|inventor/i.test(e.itemType ?? ''))
      .reduce((t, e) => t + (e.total ?? 0), 0);
    return s + Math.max(0, ent - i.TotalPayments);
  }, 0);
  console.log(`\n  ${'Balance − credits'.padEnd(44)} ${''.padStart(4)}      ${money(minusCredits).padStart(13)}`);
  console.log(`  ${'Balance − credits − adjustments'.padEnd(44)} ${''.padStart(4)}      ${money(minusBoth).padStart(13)}`);
  console.log(`  ${'(non-void entries) − payments'.padEnd(44)} ${''.padStart(4)}      ${money(nonVoidEntries).padStart(13)}`);
  console.log(`  ${'(non-void, non-stock entries) − payments'.padEnd(44)} ${''.padStart(4)}      ${money(nonStockEntries).padStart(13)}`);

  console.log('');
  process.exit(0);
}

main().catch((err) => { console.error('\nFAILED:', err.message); process.exit(1); });
