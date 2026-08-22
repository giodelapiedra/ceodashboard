/**
 * Fetch the cases behind every outstanding invoice and record each case's
 * referrerID / payer. Nookal's Ageing Debts "Payers" filter is named
 * `referrer-list[]` in the DOM, which points at Case.referrerID — not at the
 * invoice's recipientID. Adds `cases` to the ageing cache.
 *
 * Run: npx ts-node-dev --transpile-only src/diag-case-fetch.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { nookalV3 } from './services/nookal-v3/client';

const CACHE_FILE = path.join(
  'C:/Users/GIO/AppData/Local/Temp/claude/D--New-folder--7--PhysioWard-v2/79c8cdd5-9406-4ada-9fd2-d25aced87431/scratchpad',
  'ageing-cache.json'
);

const CASES_QUERY = /* GraphQL */ `
  query Cases($caseIDs: [Int], $page: Int!, $pageLength: Int!) {
    cases(caseIDs: $caseIDs, page: $page, pageLength: $pageLength) {
      caseID
      clientID
      title
      status
      active
      referrerType
      referrerID
      referrerName
      primaryProviderID
      payer { thirdPartyID name status type expiryDate }
    }
  }
`;

async function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  const caseIDs = [...new Set(cache.invoices.map((i: any) => i.caseID).filter((c: any) => c > 0))] as number[];
  console.log(`${caseIDs.length} distinct caseIDs to fetch`);

  const out: any[] = [];
  const CHUNK = 40;
  for (let i = 0; i < caseIDs.length; i += CHUNK) {
    const r: any = await nookalV3.query(CASES_QUERY, {
      caseIDs: caseIDs.slice(i, i + CHUNK), page: 1, pageLength: 200,
    });
    out.push(...(r.cases ?? []));
    process.stdout.write(`\r  … ${out.length}/${caseIDs.length}`);
  }
  console.log('');

  cache.cases = out;
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
  console.log(`saved ${out.length} cases into the cache`);

  console.log('\nsample:');
  for (const c of out.slice(0, 8)) {
    console.log(`  case ${c.caseID} referrerID=${c.referrerID} type=${c.referrerType} name="${c.referrerName}" payer=${JSON.stringify(c.payer)}`);
  }
}
main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
