/**
 * One-off diagnostic: run dashboardService.getMonthly directly and print the
 * REAL error behind the generic 500 on /api/dashboard/monthly.
 *   npx ts-node-dev --transpile-only src/scripts/test-dashboard.ts
 */
import { dashboardService } from '../services/dashboard.service';
import { CLINICS } from '../types';

(async () => {
  const clinic = CLINICS.find((c) => c.id === 'newport')!;
  try {
    // Match the browser call: clinic=newport, month=6, year=2026, no force refresh.
    const result = await dashboardService.getMonthly(clinic, 2026, 6, false);
    console.log('\n✓ SUCCESS — fromCache:', result.fromCache, 'duration:', result.duration);
    console.log('monthly revenue:', (result as any).monthly?.totalRevenue);
  } catch (e: any) {
    console.error('\n✗ FAILED — real error:');
    console.error('message:', e?.message);
    if (e?.code)     console.error('code:', e.code);
    if (e?.response) console.error('http response:', e.response?.status, JSON.stringify(e.response?.data)?.slice(0, 500));
    console.error('\n--- stack ---\n', e?.stack);
  } finally {
    process.exit(0);
  }
})();
