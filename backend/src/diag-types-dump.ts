/**
 * Dump fields for the types needed to reproduce Nookal's Ageing Debts filters:
 * staff (provider names), invoiceEntry (itemType → inventory vs service),
 * and credit/adjustment/refund (possible Balance reducers).
 *
 * Run: npx ts-node-dev --transpile-only src/diag-types-dump.ts
 */
import { nookalV3 } from './services/nookal-v3/client';

const ALL_TYPES = `
  query { __schema { types {
    name kind
    fields { name type { name kind ofType { name kind ofType { name kind } } } }
  }}}
`;

const WANTED = ['staff', 'invoiceEntry', 'credit', 'adjustment', 'refund', 'discount', 'service', 'stock', 'thirdParty'];

function typeName(t: any): string {
  if (!t) return '?';
  if (t.name) return t.name;
  if (t.ofType) return typeName(t.ofType) + (t.kind === 'LIST' ? '[]' : '');
  return t.kind ?? '?';
}

async function main() {
  const schema: any = await nookalV3.query(ALL_TYPES);
  const types: any[] = schema.__schema?.types ?? [];

  for (const want of WANTED) {
    const t = types.find((x) => x.name?.toLowerCase() === want.toLowerCase());
    if (!t) {
      const near = types.filter((x) => x.name?.toLowerCase().includes(want.toLowerCase())).map((x) => x.name);
      console.log(`\n=== ${want}: NOT FOUND ${near.length ? `(similar: ${near.join(', ')})` : ''}`);
      continue;
    }
    console.log(`\n=== ${t.name} ===`);
    console.log('  ' + (t.fields ?? []).map((f: any) => `${f.name}:${typeName(f.type)}`).join('\n  '));
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
