/**
 * Introspect the Nookal v3 invoice type — list every field we could be missing.
 * We need this to find why our ageing total ($21,370.17) is $9,163.34 higher
 * than Nookal's Ageing Debts report ($12,206.83, 10 Years, All Providers).
 *
 * Run: npx ts-node-dev --transpile-only src/diag-invoice-fields.ts
 */
import { nookalV3 } from './services/nookal-v3/client';

const ALL_TYPES = `
  query { __schema { types {
    name
    kind
    fields { name type { name kind ofType { name kind ofType { name kind } } } }
  }}}
`;

function typeName(t: any): string {
  if (!t) return '?';
  if (t.name) return t.name;
  if (t.ofType) return typeName(t.ofType) + (t.kind === 'LIST' ? '[]' : '');
  return t.kind ?? '?';
}

async function main() {
  const schema: any = await nookalV3.query(ALL_TYPES);
  const types = (schema.__schema?.types ?? []).filter(
    (t: any) => t.kind === 'OBJECT' && !t.name.startsWith('__')
  );

  // Find the type(s) carrying a Balance field — that's the invoice shape.
  const invoiceLike = types.filter((t: any) =>
    (t.fields ?? []).some((f: any) => f.name === 'Balance')
  );

  console.log(`\n${types.length} object types in schema.`);
  console.log(`Types with a "Balance" field: ${invoiceLike.map((t: any) => t.name).join(', ') || '(none)'}`);

  for (const t of invoiceLike) {
    console.log(`\n=== ${t.name} (${(t.fields ?? []).length} fields) ===`);
    for (const f of t.fields ?? []) {
      console.log(`  ${f.name.padEnd(30)} ${typeName(f.type)}`);
    }
  }

  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
