/**
 * Last hypothesis for the $12,206.83 rule: Nookal's Ageing Debts payer filter
 * resolves the payer through the CASE's third-party record, not the invoice's
 * recipientID. Payers 879 and 8928 are both named "DVA"; 879 is deselected in
 * Sam's filter. If the 8928-recipient invoices hang off cases whose third-party
 * is 879, that explains the 20 invoices our rule wrongly keeps.
 *
 * Run: npx ts-node-dev --transpile-only src/diag-case-payer.ts
 */
import { nookalV3 } from './services/nookal-v3/client';

const ALL_TYPES = `
  query { __schema { types { name kind
    fields { name type { name kind ofType { name kind ofType { name kind } } } } } } }
`;
const tn = (t: any): string => (!t ? '?' : t.name ? t.name : t.ofType ? tn(t.ofType) + (t.kind === 'LIST' ? '[]' : '') : t.kind);

async function main() {
  const schema: any = await nookalV3.query(ALL_TYPES);
  const types: any[] = schema.__schema?.types ?? [];
  for (const want of ['Case', 'case', 'cases']) {
    const t = types.find((x) => x.name === want);
    if (!t) continue;
    console.log(`\n=== ${t.name} ===`);
    for (const f of t.fields ?? []) console.log(`  ${f.name.padEnd(28)} ${tn(f.type)}`);
  }
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
