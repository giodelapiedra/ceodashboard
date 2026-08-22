/**
 * Top up ageing-cache.json with contacts (payers) and staff (providers).
 * Separate from diag-ageing-cache.ts so we don't repeat the 3-minute pull.
 *
 * Run: npx ts-node-dev --transpile-only src/diag-ageing-cache-add.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { nookalV3 } from './services/nookal-v3/client';

// Inlined rather than imported from diag-ageing-cache.ts — that module calls
// main() at load time, so importing it kicks off the 3-minute pull again.
const CACHE_FILE = path.join(
  'C:/Users/GIO/AppData/Local/Temp/claude/D--New-folder--7--PhysioWard-v2/79c8cdd5-9406-4ada-9fd2-d25aced87431/scratchpad',
  'ageing-cache.json'
);

const PAGE_LENGTH = 200;

const CONTACTS_QUERY = /* GraphQL */ `
  query Contacts($page: Int!, $pageLength: Int!) {
    contacts(page: $page, pageLength: $pageLength) {
      contactID
      FirstName
      LastName
      Company
      displayName
      ContactType
    }
  }
`;

const STAFF_QUERY = /* GraphQL */ `
  query Staff($page: Int!, $pageLength: Int!, $allStaff: String) {
    staff(page: $page, pageLength: $pageLength, allStaff: $allStaff) {
      staffID
      firstName
      lastName
      fullName
      isProvider
      status
    }
  }
`;

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
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));

  console.log('contacts …');
  try {
    cache.contacts = await fetchAllPaged<any>(CONTACTS_QUERY, 'contacts');
    console.log(`  ${cache.contacts.length}`);
  } catch (e: any) { console.log(`  FAILED: ${e.message}`); }

  console.log('staff …');
  try {
    cache.staff = await fetchAllPaged<any>(STAFF_QUERY, 'staff', { allStaff: 'true' });
    console.log(`  ${cache.staff.length}`);
  } catch (e: any) {
    console.log(`  allStaff:'true' failed: ${e.message}`);
    try {
      cache.staff = await fetchAllPaged<any>(STAFF_QUERY, 'staff', { allStaff: '1' });
      console.log(`  ${cache.staff.length} (allStaff:'1')`);
    } catch (e2: any) { console.log(`  FAILED: ${e2.message}`); }
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
  console.log(`\nUpdated ${CACHE_FILE}`);

  // Quick peek so we know what the payer records look like.
  console.log('\nSample contacts:');
  for (const c of (cache.contacts ?? []).slice(0, 8)) console.log('  ' + JSON.stringify(c));
  console.log('\nSample staff:');
  for (const s of (cache.staff ?? []).slice(0, 5)) console.log('  ' + JSON.stringify(s));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
