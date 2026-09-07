/**
 * End-to-end smoke test for the Weekly Check-In submission path — LOCAL ONLY.
 *
 *     npm run smoke:kpi-checkin
 *
 * Drives the real validator, the real service and the real repository against
 * the real database, then reads the rows back and checks them. That covers the
 * three places a scoring bug can actually hide and a pure unit test cannot see:
 * zod coercion on the wire shape, the NUMERIC round trip through node-postgres
 * (which hands numerics back as STRINGS), and the CHECK constraints.
 *
 * It creates its own throwaway clinician, uses it, and deletes it again — it
 * never touches a real account or a real week. The test account is created with
 * show_in_picker = false so that even mid-run it cannot appear on the tracker's
 * "not yet submitted" list or in anyone's clinician dropdown.
 *
 * Refuses to run against anything but a local database. This writes and deletes
 * rows; pointing it at prod would put a fake physio on Sam's tracker.
 */

import { pool, query } from '../db/pool';
import { env } from '../config/env';
import { submitMondaySchema, submitFridaySchema } from '../features/weekly-kpi/weekly-kpi.validators';
import { weeklyKpiService } from '../features/weekly-kpi/weekly-kpi.service';
import { RequestScope } from '../middleware/auth.middleware';
import { SIGNAL_IDS, SIGNALS } from '../features/weekly-kpi/weekly-kpi.model';

const TEST_EMAIL = '__kpi_smoketest@physioward.local';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${String(actual)}${ok ? '' : `  (expected ${String(expected)})`}`);
}

function assertLocal(): void {
  const url = env.DATABASE_URL ?? '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    throw new Error(
      'smoke:kpi-checkin refuses to run against a non-local DATABASE_URL. ' +
      'It creates and deletes rows.'
    );
  }
}

/** Test vector C from section 9 of the reference document: expected 8.4,
 *  0 standards missed, 0 N/A, band "strong". Using a PUBLISHED vector means
 *  this asserts the whole stack lands on the document's own number, not merely
 *  on whatever the code happens to compute. */
const VECTOR_C: (0 | 1 | 2 | 3)[] = [
  1, 3, 2, 2, 2, 2, 2, 1, 3,
  2, 2, 2, 2, 1, 3, 3,
  3, 2, 2, 2,
  3, 2, 1, 2, 3,
  2, 3, 3, 3, 1,
];

async function createTestClinician(): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, clinic_id, is_active, show_in_picker)
     VALUES ($1, 'x-not-a-usable-hash', 'KPI Smoke Test', 'CLINICIAN', 'newport', true, false)
     ON CONFLICT (email) DO UPDATE SET is_active = true
     RETURNING id`,
    [TEST_EMAIL]
  );
  return rows[0].id;
}

async function cleanup(userId: string): Promise<void> {
  // Ratings and comments cascade off the report; the report has to go before
  // the user, whose FK is ON DELETE RESTRICT everywhere by design.
  await query('DELETE FROM weekly_kpi_reports WHERE clinician_id = $1', [userId]);
  await query('DELETE FROM users WHERE id = $1', [userId]);
}

async function main(): Promise<void> {
  assertLocal();

  const userId = await createTestClinician();
  const scope: RequestScope = {
    userId, role: 'CLINICIAN', clinic_id: 'newport',
    full_name: 'KPI Smoke Test', email: TEST_EMAIL,
  };

  try {
    console.log('1. Monday submit — KPI/intention + Mojo drain/action (Effectiveness/Mojo rating moved to Friday, 2026-09-04)\n');

    // Parsed by the SAME schema the route uses, from a plain JSON-shaped object
    // — so a coercion bug shows up here rather than in production.
    const mondayBody = (extra: Record<string, unknown> = {}) => submitMondaySchema.parse({
      kpis: [
        { name: 'Recommendation', target: '8', result: '', hit: null },
        { name: 'Conversion',     target: '6', result: '', hit: null },
        { name: '', target: '', result: '' },
      ],
      missed_goal_actions: '  Block 20 min after each patient.  ',
      counts: {},
      mojo_drain:  ['mental'],
      mojo_action: 'Batch admin Wednesday 4pm.',
      intention:   'Re-anchor the goal in every follow-up.',
      case_to_discuss: null,
      help_needed:     '',
      checkin_needed:  false,
      checkin_focus:   '',
      ...extra,
    });

    const firstMonday = mondayBody();
    check('blank optional long answer became null', firstMonday.help_needed, null);
    check('blank KPI cell became null',             firstMonday.kpis[2].name, null);
    check('long answer was trimmed',
      firstMonday.missed_goal_actions, 'Block 20 min after each patient.');

    const monday = await weeklyKpiService.submitMonday(scope, firstMonday);
    check('effectiveness_rating null until Friday', monday.effectiveness_rating, null);
    check('mojo_rating null until Friday',          monday.mojo_rating, null);
    check('mojo_drain stored on Monday (array)',    JSON.stringify(monday.mojo_drain), JSON.stringify(['mental']));

    console.log('\n2. Friday submit — published test vector C through the real wire shape\n');

    const signals: Record<string, 0 | 1 | 2 | 3 | null> = {};
    SIGNAL_IDS.forEach((id, i) => { signals[id] = VECTOR_C[i]; });

    const fridayBody = (extra: Record<string, unknown> = {}) => submitFridaySchema.parse({
      wins: 'Two prepays.',
      goal_achieved: false,
      goal_reflection: 'Ran out of time on Thursday.',
      flag_for_sam: null,
      best_behaviour: 'Walked every patient out.',
      slipped: 'Notes on Wednesday.',
      commitment: 'Notes before leaving each room.',
      signals,
      mojo_rating: 7,
      ...extra,
    });

    const saved = await weeklyKpiService.submitFriday(scope, fridayBody());

    console.log('\n3. What the server computed and stored\n');
    check('effectiveness_score', saved.effectiveness.effectiveness_score, 8.4);
    check('band_id',             saved.effectiveness.band_id, 'strong');
    check('standards_missed',    saved.effectiveness.standards_missed, 0);
    check('standards_na',        saved.effectiveness.standards_na, 0);
    check('na_count',            saved.effectiveness.na_count, 0);
    check('model_version',       saved.effectiveness.model_version, '1.0');
    check('is_incomplete',       saved.effectiveness.is_incomplete, false);
    // The derived whole-number column every existing reader still uses.
    check('effectiveness_rating derived', saved.effectiveness_rating, 8);
    check('mojo_drain untouched by the friday write (still Monday\'s)', JSON.stringify(saved.mojo_drain), JSON.stringify(['mental']));
    check('friday stamped',      saved.friday_submitted_at !== null, true);
    check('reflection stored',   saved.slipped, 'Notes on Wednesday.');
    check('kpi row untouched by the friday write', saved.kpis[0].name, 'Recommendation');

    console.log('\n4. Raw ratings landed as rows\n');
    const { rows: ratingRows } = await query<{ n: string }>(
      'SELECT COUNT(*)::int AS n FROM weekly_kpi_signal_ratings WHERE report_id = $1',
      [saved.id]
    );
    check('30 rating rows written', Number(ratingRows[0].n), 30);
    check('ratings read back onto the DTO', Object.keys(saved.signals ?? {}).length, 30);
    check('S01 round-tripped as a number', saved.signals?.S01, 1);

    console.log('\n5. Re-submit corrects the same row (never a second one)\n');
    const naSignals: Record<string, 0 | 1 | 2 | 3 | null> = { ...signals };
    // Blank the whole of G4, plus a Standard, to exercise group renormalisation
    // and the standards_na counter on a real write.
    for (const s of SIGNALS) if (s.group_id === 'G4') naSignals[s.signal_id] = null;
    naSignals.S26 = null;

    const again = await weeklyKpiService.submitFriday(scope, fridayBody({ signals: naSignals }));

    check('same report id', again.id, saved.id);
    const { rows: countRows } = await query<{ n: string }>(
      'SELECT COUNT(*)::int AS n FROM weekly_kpi_reports WHERE clinician_id = $1',
      [userId]
    );
    check('still exactly one row for the person-week', Number(countRows[0].n), 1);
    check('na_count after blanking G4 + S26', again.effectiveness.na_count, 6);
    check('standards_na picked up S26',       again.effectiveness.standards_na, 1);
    check('G4 group_pct is null, not 0',      again.effectiveness.group_pcts.G4, null);
    check('stale ratings were replaced, not merged',
      Object.values(again.signals ?? {}).filter(v => v === null).length, 6);

    console.log('\n6. Fully-N/A submission is refused (never stored as a 0.0)\n');
    const allNa: Record<string, null> = {};
    for (const id of SIGNAL_IDS) allNa[id] = null;
    let refused = false;
    try {
      fridayBody({ signals: allNa });
    } catch { refused = true; }
    check('validator refuses an all-N/A week', refused, true);

    console.log('\n7. An out-of-domain rating is rejected, not coerced\n');
    let rejected = false;
    try {
      fridayBody({ signals: { ...signals, S01: 2.5 } });
    } catch { rejected = true; }
    check('2.5 rejected', rejected, true);

    let unknownRejected = false;
    try {
      fridayBody({ signals: { ...signals, S99: 3 } });
    } catch { unknownRejected = true; }
    check('unknown signal id rejected', unknownRejected, true);

    console.log('\n8. Drain (Monday): "No drain" cannot combine with a real drain\n');
    let drainRejected = false;
    try {
      mondayBody({ mojo_drain: ['none', 'mental'] });
    } catch { drainRejected = true; }
    check('none + mental rejected', drainRejected, true);

    let multiDrainOk = true;
    try {
      mondayBody({ mojo_drain: ['mental', 'physical'] });
    } catch { multiDrainOk = false; }
    check('two real drains accepted', multiDrainOk, true);

    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  } finally {
    await cleanup(userId);
    console.log(`\nCleaned up the test account (${TEST_EMAIL}) and its week.`);
    await pool.end();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('smoke test failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
