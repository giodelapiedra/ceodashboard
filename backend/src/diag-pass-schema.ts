/**
 * Introspect the `pass` type in Nookal v3 to get correct field names.
 * Run: npx ts-node-dev --transpile-only src/diag-pass-schema.ts
 */
import { nookalV3 } from './services/nookal-v3/client';
import { CLINICS } from './types';

const PASS_SCHEMA = `query {
  __type(name: "pass") { fields { name type { name kind ofType { name kind } } } }
}`;

// Minimal pass query to discover available fields
const PASS_SAMPLE = `query Passes($locationIDs: [Int], $page: Int!, $pageLength: Int!) {
  passes(locationIDs: $locationIDs, page: $page, pageLength: $pageLength) {
    passID
    passName
    locationID
    status
    dateCreated
    dateExpiry
    sessions
    sessionsRemaining
    price
    clientID
  }
}`;

async function main() {
  // Introspect schema
  console.log('\n=== pass type fields ===');
  try {
    const schema: any = await nookalV3.query(PASS_SCHEMA);
    for (const f of schema.__type?.fields ?? []) {
      console.log(` ${f.name.padEnd(25)} ${f.type?.name ?? f.type?.kind ?? '?'}`);
    }
  } catch (e: any) { console.log('schema introspect failed:', e.message); }

  // Try a minimal sample query
  console.log('\n=== passes sample (1 record) ===');
  try {
    const d: any = await nookalV3.query(PASS_SAMPLE, {
      locationIDs: CLINICS.map(c => c.v3LocationId), page: 1, pageLength: 1
    });
    console.log(JSON.stringify(d.passes?.[0] ?? 'no records', null, 2));
  } catch (e: any) { console.log('passes sample failed:', e.message); }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
