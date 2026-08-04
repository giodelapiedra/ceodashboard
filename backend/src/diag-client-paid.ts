/**
 * Diag: prove we can resolve a client by name and read their invoice totals.
 * Test subject: Thomas "Tom" West, clientID 96034 (Brookvale/Newport) —
 * Nookal UI shows Invoiced $238.62 / Paid $238.62.
 * Run: npx ts-node-dev --transpile-only src/diag-client-paid.ts
 */
import { nookalV3 } from './services/nookal-v3/client';

const SEARCH = /* GraphQL */ `
  query ($firstName: String, $lastName: String, $fuzzy: Int, $page: Int!, $pageLength: Int!) {
    clients(firstName: $firstName, lastName: $lastName, fuzzy: $fuzzy, page: $page, pageLength: $pageLength) {
      clientID
      fullName
      firstName
      lastName
      nickname
      DOB
      active
      invoices { invoiceID invoiceNumber Total TotalPayments Balance void dateCreated locationID }
    }
  }
`;

async function run(label: string, vars: Record<string, unknown>) {
  console.log(`\n=== ${label} ===`);
  try {
    const data: any = await nookalV3.query(SEARCH, { page: 1, pageLength: 20, ...vars });
    const clients = data.clients ?? [];
    console.log(`matches: ${clients.length}`);
    for (const c of clients) {
      const inv = (c.invoices ?? []).filter((i: any) => i.void !== 1);
      const total = inv.reduce((s: number, i: any) => s + (i.Total ?? 0), 0);
      const paid  = inv.reduce((s: number, i: any) => s + (i.TotalPayments ?? 0), 0);
      console.log(`  #${c.clientID} ${c.fullName ?? c.firstName + ' ' + c.lastName}` +
        ` (active=${c.active}) invoices=${inv.length} Total=$${total.toFixed(2)} Paid=$${paid.toFixed(2)}`);
    }
  } catch (e: any) {
    console.log(`  ERROR: ${e.message}`);
  }
}

async function main() {
  await run('exact: Thomas West', { firstName: 'Thomas', lastName: 'West' });
  await run('lastName only: West', { lastName: 'West' });
  await run('fuzzy: Tom West', { firstName: 'Tom', lastName: 'West', fuzzy: 1 });
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
