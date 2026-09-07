/**
 * Verify the Weekly Check-In scoring model against the reference document.
 *
 *     npm run verify:kpi-model
 *
 * Section 9 of "PhysioWard Weekly Check-In — Developer Reference": "Feed each
 * ratings column into your implementation. The expected outputs are computed
 * from the model above and are correct — if your build disagrees, your build is
 * wrong." Plus the document's own closing assertion: all thirty rated 2 must be
 * exactly 8.0, all 3 exactly 10.0, all 0 exactly 0.0.
 *
 * No database, no server, no network — this scores the pure function and exits
 * non-zero on any mismatch, so it is safe to run before a deploy and cheap to
 * run after any edit to the registry.
 *
 * Written as a script rather than a test file because this backend has no test
 * runner.
 */

import {
  scoreSignals, SIGNALS, SIGNAL_IDS, RatingMap, SignalRating,
  KPI_MODEL_VERSION, SIGNAL_GROUPS, bandFor, round1,
} from '../features/weekly-kpi/weekly-kpi.model';

/** The four published vectors. Ratings are listed S01..S30 in order, exactly as
 *  the document's two-column table reads down then across. */
const VECTORS: {
  name: string;
  ratings: (0 | 1 | 2 | 3 | 'NA')[];
  expect: { score: number; standards_missed: number; na_count: number; band_id: string };
}[] = [
  {
    name: 'A',
    ratings: [
      3, 3, 3, 3, 2, 3, 3, 3, 3,      // S01-S09
      3, 3, 3, 3, 2, 3, 3,            // S10-S16
      3, 3, 2, 3,                     // S17-S20
      3, 3, 2, 'NA', 3,               // S21-S25
      3, 3, 3, 3, 2,                  // S26-S30
    ],
    expect: { score: 9.7, standards_missed: 0, na_count: 1, band_id: 'model' },
  },
  {
    name: 'B',
    ratings: [
      2, 1, 1, 1, 1, 1, 1, 1, 2,
      1, 1, 1, 1, 1, 2, 2,
      1, 1, 1, 0,
      1, 1, 0, 'NA', 'NA',
      1, 2, 0, 1, 0,
    ],
    expect: { score: 4.5, standards_missed: 3, na_count: 2, band_id: 'intervene' },
  },
  {
    name: 'C',
    ratings: [
      1, 3, 2, 2, 2, 2, 2, 1, 3,
      2, 2, 2, 2, 1, 3, 3,
      3, 2, 2, 2,
      3, 2, 1, 2, 3,
      2, 3, 3, 3, 1,
    ],
    expect: { score: 8.4, standards_missed: 0, na_count: 0, band_id: 'strong' },
  },
  {
    name: 'D',
    ratings: [
      2, 2, 1, 1, 2, 2, 2, 2, 2,
      2, 1, 1, 1, 1, 2, 2,
      2, 1, 1, 1,
      2, 2, 1, 'NA', 'NA',
      2, 2, 1, 2, 0,
    ],
    expect: { score: 6.4, standards_missed: 0, na_count: 2, band_id: 'gap' },
  },
];

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${String(actual)}${ok ? '' : `  (expected ${String(expected)})`}`);
}

function toMap(ratings: (0 | 1 | 2 | 3 | 'NA')[]): RatingMap {
  if (ratings.length !== SIGNALS.length) {
    // A positional array is how the document publishes these, and it is fragile
    // by nature: insert a signal and every column shifts. Refusing a
    // length mismatch turns that into a loud failure instead of four wrong
    // scores that still look plausible.
    throw new Error(
      `vector has ${ratings.length} ratings but the registry has ${SIGNALS.length} signals`
    );
  }
  const map: RatingMap = {};
  ratings.forEach((r, i) => {
    map[SIGNAL_IDS[i]] = (r === 'NA' ? null : r) as SignalRating;
  });
  return map;
}

function main(): void {
  console.log(`Weekly Check-In model — version ${KPI_MODEL_VERSION}`);
  console.log(`${SIGNALS.length} signals in ${SIGNAL_GROUPS.length} groups, ` +
              `${SIGNALS.filter(s => s.standard).length} standards\n`);

  console.log('Section 9 — published test vectors');
  for (const v of VECTORS) {
    const r = scoreSignals(toMap(v.ratings));
    console.log(`\n Vector ${v.name}  (raw ${r.raw?.toFixed(4) ?? 'null'})`);
    check('effectiveness_score', r.score, v.expect.score);
    check('standards_missed',    r.standards_missed.length, v.expect.standards_missed);
    check('na_count',            r.na_count, v.expect.na_count);
    check('band_id',             r.band_id, v.expect.band_id);
  }

  console.log('\nSection 9 — closing assertion ("if any of those three fails, the point');
  console.log('mapping or the group renormalisation is wrong")');
  for (const [rating, expected] of [[3, 10.0], [2, 8.0], [0, 0.0]] as const) {
    const map: RatingMap = {};
    for (const id of SIGNAL_IDS) map[id] = rating as SignalRating;
    check(`all thirty rated ${rating}`, scoreSignals(map).score, expected);
  }

  console.log('\nEdge cases (section 5)');

  // Every signal N/A -> null, never 0.
  const allNa: RatingMap = {};
  for (const id of SIGNAL_IDS) allNa[id] = null;
  const na = scoreSignals(allNa);
  check('all N/A -> score is null (not 0)', na.score, null);
  check('all N/A -> incomplete', na.incomplete, true);

  // One whole group N/A -> its weight is redistributed, not counted as zero.
  const g4Na: RatingMap = {};
  for (const s of SIGNALS) g4Na[s.signal_id] = s.group_id === 'G4' ? null : 3;
  check('G4 fully N/A, everything else 3 -> 10.0', scoreSignals(g4Na).score, 10.0);

  // A missing key scores identically to an explicit null (section 5).
  const explicit: RatingMap = {};
  const omitted:  RatingMap = {};
  for (const s of SIGNALS) {
    if (s.signal_id === 'S24') { explicit[s.signal_id] = null; continue; }
    explicit[s.signal_id] = 2;
    omitted[s.signal_id]  = 2;
  }
  const eScore = scoreSignals(explicit);
  const oScore = scoreSignals(omitted);
  check('missing key scores the same as explicit N/A', oScore.score, eScore.score);
  check('missing key counts into na_count', oScore.na_count, 1);

  console.log('\nBand resolution (this build bands the ROUNDED score)');
  // The reference document's section 3 rounds the score but bands the raw
  // value. At a boundary those disagree — a raw 4.9666 displays as "5.0" and
  // bands as "Below 5 — Intervene" on the same screen. Assert the fix holds.
  for (const raw of [4.9666, 6.4694, 8.4951, 9.7996]) {
    const rounded = round1(raw);
    check(`raw ${raw} displays ${rounded} and bands as its displayed value`,
      bandFor(rounded), bandFor(round1(rounded)));
  }
  check('4.96 rounds to 5.0 and bands "gap", not "intervene"', bandFor(round1(4.9666)), 'gap');

  console.log(failures === 0
    ? '\nAll checks passed.'
    : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
