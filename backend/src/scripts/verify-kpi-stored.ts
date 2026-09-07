/**
 * Re-score every stored Weekly Check-In from its RAW ratings and compare the
 * result against the numbers denormalised onto the row.
 *
 *     npm run verify:kpi-stored
 *
 * WHY. Section 7 of the reference document asks for the computed fields to be
 * persisted — score, band, group percentages, the two counts — and they are,
 * on weekly_kpi_reports. The facts behind them live one table down, in
 * weekly_kpi_signal_ratings. Two copies of the same truth can drift, and
 * Postgres cannot express "this column must equal a function of those rows" as
 * a CHECK.
 *
 * Both are written in one transaction by one code path (upsertMonday), so drift
 * should be impossible. "Should be impossible" is exactly the class of thing
 * worth being able to prove on demand: a hand-run UPDATE, a restored backup, a
 * half-applied migration or a future second writer would all show up here and
 * nowhere else.
 *
 * READ-ONLY. It reports; it never repairs. A row that disagrees with its own
 * ratings is a question about how it got that way, and silently rewriting it
 * would destroy the evidence — and, if the model was retuned, would be exactly
 * the "recalculate historical rows silently" that section 5 forbids.
 *
 * Rows scored under a model this build does not know are SKIPPED, not failed:
 * on a rollback the database legitimately holds rows from a newer deploy, and
 * re-scoring those with an older model would manufacture drift rather than
 * find it.
 */

import { pool, query } from '../db/pool';
import {
  scoreSignals, modelFor, knownModelVersions, RatingMap, SignalRating,
} from '../features/weekly-kpi/weekly-kpi.model';

interface StoredRow {
  id:                  string;
  clinician_name:      string | null;
  week_start:          Date;
  effectiveness_score: string | null;
  effectiveness_rating: number;
  band_id:             string | null;
  standards_missed:    number | null;
  standards_na:        number | null;
  na_count:            number | null;
  model_version:       string | null;
  group_pct_g1:        string | null;
  group_pct_g2:        string | null;
  group_pct_g3:        string | null;
  group_pct_g4:        string | null;
  group_pct_g5:        string | null;
}

function num(v: string | number | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isoDate(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  const { rows } = await query<StoredRow>(
    `SELECT w.id, u.full_name AS clinician_name, w.week_start,
            w.effectiveness_score, w.effectiveness_rating, w.band_id,
            w.standards_missed, w.standards_na, w.na_count, w.model_version,
            w.group_pct_g1, w.group_pct_g2, w.group_pct_g3, w.group_pct_g4, w.group_pct_g5
       FROM weekly_kpi_reports w
       LEFT JOIN users u ON u.id = w.clinician_id
      WHERE w.model_version IS NOT NULL
      ORDER BY w.week_start DESC, w.id`
  );

  console.log(`Weekly Check-In — stored vs recomputed`);
  console.log(`known models: ${knownModelVersions().join(', ')}`);
  console.log(`${rows.length} scored row(s) to check\n`);

  if (rows.length === 0) {
    console.log('Nothing scored under the signal model yet — nothing to verify.');
    await pool.end();
    process.exit(0);
  }

  let drifted = 0;
  let skipped = 0;

  for (const r of rows) {
    const model = modelFor(r.model_version);
    if (!model) {
      skipped++;
      console.log(`  SKIP  #${r.id} ${isoDate(r.week_start)} — scored under unknown model ` +
                  `"${r.model_version}" (newer deploy?), not re-scored`);
      continue;
    }

    const { rows: ratingRows } = await query<{ signal_id: string; rating: number | null }>(
      'SELECT signal_id, rating FROM weekly_kpi_signal_ratings WHERE report_id = $1',
      [r.id]
    );
    const ratings: RatingMap = {};
    for (const rr of ratingRows) {
      ratings[rr.signal_id] = (rr.rating === null ? null : Number(rr.rating)) as SignalRating;
    }

    const fresh = scoreSignals(ratings, model);

    const problems: string[] = [];
    const stored = num(r.effectiveness_score);
    if (stored !== fresh.score) problems.push(`score stored ${stored}, recomputed ${fresh.score}`);
    if (r.band_id !== fresh.band_id) problems.push(`band stored ${r.band_id}, recomputed ${fresh.band_id}`);
    if (r.na_count !== fresh.na_count) problems.push(`na_count stored ${r.na_count}, recomputed ${fresh.na_count}`);
    if (r.standards_missed !== fresh.standards_missed.length) {
      problems.push(`standards_missed stored ${r.standards_missed}, recomputed ${fresh.standards_missed.length}`);
    }
    if (r.standards_na !== fresh.standards_na.length) {
      problems.push(`standards_na stored ${r.standards_na}, recomputed ${fresh.standards_na.length}`);
    }

    // The derived whole-number column every pre-existing reader still uses. If
    // this drifts, the tracker and the Excel export disagree with the report.
    if (fresh.score !== null && r.effectiveness_rating !== Math.round(fresh.score)) {
      problems.push(`effectiveness_rating stored ${r.effectiveness_rating}, ` +
                    `expected ROUND(${fresh.score}) = ${Math.round(fresh.score)}`);
    }

    const storedPcts: Record<string, number | null> = {
      G1: num(r.group_pct_g1), G2: num(r.group_pct_g2), G3: num(r.group_pct_g3),
      G4: num(r.group_pct_g4), G5: num(r.group_pct_g5),
    };
    for (const g of fresh.groups) {
      const s = storedPcts[g.group_id];
      // Stored at 4dp (NUMERIC(5,4)), so compare at that precision rather than
      // flagging every row for a rounding difference that is by design.
      const f = g.pct === null ? null : Math.round(g.pct * 10000) / 10000;
      if (s !== f) problems.push(`${g.group_id} pct stored ${s}, recomputed ${f}`);
    }

    if (ratingRows.length === 0) {
      problems.push('no raw ratings stored for a scored row — the score cannot be reproduced');
    }

    if (problems.length > 0) {
      drifted++;
      console.log(`  DRIFT #${r.id} ${isoDate(r.week_start)} ${r.clinician_name ?? 'unknown'} ` +
                  `(model ${r.model_version})`);
      for (const p of problems) console.log(`        ${p}`);
    }
  }

  const checked = rows.length - skipped;
  console.log(`\n${checked} row(s) re-scored, ${skipped} skipped, ${drifted} drifted.`);
  console.log(drifted === 0
    ? 'Every stored score matches its raw ratings.'
    : 'Stored scores disagree with their ratings. Investigate before repairing — ' +
      'do NOT bulk-recompute, that would overwrite the evidence.');

  await pool.end();
  process.exit(drifted === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('verify:kpi-stored failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
