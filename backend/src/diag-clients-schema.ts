/**
 * Diag: what args do the `clients` / `invoices` / `payments` queries accept,
 * and what fields does the Client type expose (name fields especially)?
 * Run: npx ts-node-dev --transpile-only src/diag-clients-schema.ts
 */
import { nookalV3 } from './services/nookal-v3/client';

const ARGS_QUERY = `
  query { __schema { queryType { fields {
    name
    type { name kind ofType { name kind } }
    args { name type { name kind ofType { name kind } } }
  }}}}
`;

const TYPE_QUERY = `
  query TypeFields($name: String!) {
    __type(name: $name) { name fields { name type { name kind ofType { name } } } }
  }
`;

async function main() {
  const data: any = await nookalV3.query(ARGS_QUERY);
  const fields = data.__schema?.queryType?.fields ?? [];
  const typeNames = new Set<string>();
  for (const f of fields) {
    if (!/^clients$|^invoices$|^payments$/.test(f.name)) continue;
    const retType = f.type?.name ?? f.type?.ofType?.name;
    if (retType) typeNames.add(retType);
    console.log(`QUERY ${f.name.padEnd(12)} returns: ${retType ?? f.type?.kind}`);
  }

  for (const typeName of typeNames) {
    const t: any = await nookalV3.query(TYPE_QUERY, { name: typeName });
    if (t.__type?.fields) {
      console.log(`\nTYPE ${t.__type.name} fields:`);
      for (const fl of t.__type.fields) {
        console.log(`  ${fl.name}: ${fl.type?.name ?? fl.type?.ofType?.name ?? fl.type?.kind}`);
      }
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
