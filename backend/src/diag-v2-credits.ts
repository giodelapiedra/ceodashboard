/**
 * Probe Nookal v2 REST for account credits endpoints.
 * Run: npx ts-node-dev --transpile-only src/diag-v2-credits.ts
 */
import axios from 'axios';
import { env } from './config/env';

const client = axios.create({ baseURL: env.NOOKAL_BASE_URL, timeout: 15000 });
const params = (extra: Record<string,string>) => ({
  api_key:   env.NOOKAL_API_KEY,
  date_from: '2026-06-01',
  date_to:   '2026-06-30',
  ...extra,
});

async function probe(endpoint: string, extra: Record<string,string> = {}) {
  try {
    const res = await client.get(endpoint, { params: params(extra) });
    const d = res.data?.details;
    if (d?.code === 1) {
      const results = d.results ?? [];
      const count = Array.isArray(results) ? results.length : Object.keys(results).length;
      console.log(`✅ ${endpoint.padEnd(30)} code=1  records=${count}  pages=${d.pages}`);
      if (count > 0 && count <= 5) console.log('   sample:', JSON.stringify(results[0] ?? results, null, 2).slice(0, 300));
    } else {
      console.log(`❌ ${endpoint.padEnd(30)} code=${d?.code} msg="${d?.message}"`);
    }
  } catch (e: any) {
    console.log(`💥 ${endpoint.padEnd(30)} ${e.response?.status ?? e.message}`);
  }
}

async function main() {
  console.log(`\nBase URL: ${env.NOOKAL_BASE_URL}\n`);
  // Try all plausible account-credit endpoints in Nookal v2 REST
  await probe('/getAccountCredits');
  await probe('/getCredits');
  await probe('/getCreditNotes');
  await probe('/getAccountCreditNotes');
  await probe('/getClientCredits');
  await probe('/getPatientCredits');
  await probe('/getPayments');
  await probe('/getAccountPayments');
  await probe('/getCreditHistory');
  await probe('/getAccountCreditHistory');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
