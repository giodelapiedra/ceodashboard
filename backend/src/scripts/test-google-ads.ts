/**
 * One-off diagnostic: call the Google Ads API directly with the current .env
 * credentials and print the REAL error (the route only surfaces a generic 500).
 *   npm run test:google-ads
 */
import { adSpendService } from '../features/ad-spend/ad-spend.service';

(async () => {
  try {
    // Exercises the FULL endpoint path: API fetch + ADSPEND-user lookup + DB upsert.
    const result = await adSpendService.syncGoogleAds('2026-01-01', '2026-06-18');
    console.log('\n✓ SUCCESS — sync result:', result);
  } catch (e: any) {
    console.error('\n✗ FAILED — real error:');
    console.error('message:', e?.message);
    if (e?.errors)  console.error('errors:', JSON.stringify(e.errors, null, 2));
    if (e?.code)    console.error('code:', e.code);
    console.error('\n--- full ---\n', e);
  } finally {
    process.exit(0);
  }
})();
