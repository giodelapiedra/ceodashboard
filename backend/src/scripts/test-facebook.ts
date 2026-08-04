import { fetchFacebookAdsSpend } from '../services/facebook-ads.service';
(async () => {
  try {
    const rows = await fetchFacebookAdsSpend('2026-06-01', '2026-06-18');
    console.log('\n✓ FB SUCCESS — rows:', rows.length);
    console.log(rows.slice(0, 3));
  } catch (e: any) {
    console.error('\n✗ FB FAILED:');
    console.error('message:', e?.message);
    if (e?.response?.data) console.error('graph error:', JSON.stringify(e.response.data));
  } finally { process.exit(0); }
})();
