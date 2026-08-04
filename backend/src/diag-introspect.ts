/**
 * Introspect Nookal v3 GraphQL schema — find all available query fields.
 * Run: npx ts-node-dev --transpile-only src/diag-introspect.ts
 */
import { nookalV3 } from './services/nookal-v3/client';

const INTROSPECT = `
  query { __schema { queryType { fields {
    name
    args { name type { name kind ofType { name kind } } }
  }}}}
`;

async function main() {
  const data: any = await nookalV3.query(INTROSPECT);
  const fields = data.__schema?.queryType?.fields ?? [];
  console.log(`\n${fields.length} query fields available:\n`);
  for (const f of fields) {
    const args = (f.args ?? []).map((a: any) => a.name).join(', ');
    console.log(`  ${f.name.padEnd(30)} args: ${args || '(none)'}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
