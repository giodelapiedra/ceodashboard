/**
 * Cache every invoice-with-a-balance (plus client + payer context) to a local
 * JSON file so we can iterate on the Nookal reconciliation without repeating
 * the ~3-minute 10-year pull.
 *
 * Writes: <scratchpad>/ageing-cache.json
 * Run: npx ts-node-dev --transpile-only src/diag-ageing-cache.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { nookalV3 } from './services/nookal-v3/client';
import {
  INVOICES_BY_DATE_BALANCE_QUERY,
  InvoicesByDateBalanceResult,
  V3InvoiceBalance,
  PAGE_LENGTH,
} from './services/nookal-v3/queries';

export const CACHE_FILE = path.join(
  'C:/Users/GIO/AppData/Local/Temp/claude/D--New-folder--7--PhysioWard-v2/79c8cdd5-9406-4ada-9fd2-d25aced87431/scratchpad',
  'ageing-cache.json'
);

const RICH_QUERY = /* GraphQL */ `
  query RichInvoices($invoiceIDs: [Int], $void: Int, $page: Int!, $pageLength: Int!) {
    invoices(invoiceIDs: $invoiceIDs, void: $void, page: $page, pageLength: $pageLength) {
      invoiceID
      invoiceNumber
      clientID
      caseID
      locationID
      practitionerID
      addresseeID
      recipientID
      ApptID
      ApptDate
      Total
      TotalPayments
      Balance
      dateCreated
      lastModified
      isThirdPartyInvoice
      void
      thirdParty { thirdPartyID name status type expiryDate }
      credits     { creditID amount void }
      adjustments { adjustmentID amount void }
      refunds     { refundID amount void isCreditRefund }
      entries     { entryID itemType name category total void ItemID providerID }
    }
  }
`;

const CLIENTS_QUERY = /* GraphQL */ `
  query Clients($clientIDs: [Int], $page: Int!, $pageLength: Int!) {
    clients(clientIDs: $clientIDs, page: $page, pageLength: $pageLength) {
      clientID
      firstName
      lastName
      active
      deceased
      locationID
    }
  }
`;

const CONTACTS_QUERY = /* GraphQL */ `
  query Contacts($page: Int!, $pageLength: Int!) {
    contacts(page: $page, pageLength: $pageLength) {
      contactID
      firstName
      lastName
      companyName
      contactType
    }
  }
`;

const STAFF_QUERY = /* GraphQL */ `
  query Staff($page: Int!, $pageLength: Int!) {
    staff(page: $page, pageLength: $pageLength, allStaff: 1) {
      staffID
      firstName
      lastName
      fullName
      isProvider
      status
    }
  }
`;

const BATCH = 8;

function todayAEST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
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

/** Paginate a query that takes only page/pageLength. */
async function fetchAllPaged<T>(query: string, key: string, extra: Record<string, unknown> = {}): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 200; page++) {
    const r: any = await nookalV3.query(query, { ...extra, page, pageLength: PAGE_LENGTH });
    const rows: T[] = r[key] ?? [];
    out.push(...rows);
    if (rows.length < PAGE_LENGTH) break;
  }
  return out;
}

async function main() {
  const today = todayAEST();
  const [y, m, d] = today.split('-');
  const from = `${Number(y) - 10}-${m}-${d}`;

  console.log(`Window ${from} → ${today}`);
  console.log('\nPass 1 — light pull …');
  const light = await fetchLight(from, today);
  const cutoff = new Date(`${from}T00:00:00+10:00`).getTime();
  const candidates = light.filter((i) => {
    const dt = new Date(i.dateCreated);
    return !isNaN(dt.getTime()) && dt.getTime() >= cutoff && (i.Balance ?? 0) > 0;
  });
  console.log(`  ${light.length} invoices, ${candidates.length} with Balance > 0`);

  console.log('\nPass 2 — rich invoice detail …');
  const invoices: any[] = [];
  const ids = candidates.map((i) => i.invoiceID);
  const CHUNK = 40;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const r: any = await nookalV3.query(RICH_QUERY, {
      invoiceIDs: ids.slice(i, i + CHUNK), void: 0, page: 1, pageLength: PAGE_LENGTH,
    });
    invoices.push(...(r.invoices ?? []));
    process.stdout.write(`\r  … ${invoices.length}/${ids.length}`);
  }
  console.log('');

  console.log('\nPass 3 — clients for those invoices …');
  const clientIDs = [...new Set(invoices.map((i) => i.clientID).filter((c) => c > 0))];
  const clients: any[] = [];
  for (let i = 0; i < clientIDs.length; i += CHUNK) {
    const r: any = await nookalV3.query(CLIENTS_QUERY, {
      clientIDs: clientIDs.slice(i, i + CHUNK), page: 1, pageLength: PAGE_LENGTH,
    });
    clients.push(...(r.clients ?? []));
    process.stdout.write(`\r  … ${clients.length}/${clientIDs.length}`);
  }
  console.log('');

  console.log('\nPass 4 — contacts (payers) …');
  let contacts: any[] = [];
  try { contacts = await fetchAllPaged<any>(CONTACTS_QUERY, 'contacts'); }
  catch (e: any) { console.log(`  contacts failed: ${e.message}`); }
  console.log(`  ${contacts.length} contacts`);

  console.log('\nPass 5 — staff (providers) …');
  let staff: any[] = [];
  try { staff = await fetchAllPaged<any>(STAFF_QUERY, 'staff'); }
  catch (e: any) { console.log(`  staff failed: ${e.message}`); }
  console.log(`  ${staff.length} staff`);

  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(
    CACHE_FILE,
    JSON.stringify({ window: { from, to: today }, invoices, clients, contacts, staff }, null, 1)
  );
  console.log(`\nWrote ${CACHE_FILE}`);
  console.log(`  ${invoices.length} invoices, ${clients.length} clients, ${contacts.length} contacts, ${staff.length} staff`);
  process.exit(0);
}
main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
