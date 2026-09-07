/**
 * Parity check: the server's scorer vs the browser's live preview.
 *
 *     npm run verify:kpi-parity
 *
 * WHY THIS EXISTS. The Weekly Check-In score is computed twice on purpose. The
 * server computes the number that is stored (weekly-kpi.model.ts). The form
 * computes the same number as the physio answers, because waiting for a round
 * trip on each of thirty clicks is not a form (frontend/src/lib/weeklyKpi.score
 * .ts). That is the one piece of duplicated logic in the feature, and the only
 * honest way to keep two copies of an algorithm in step is to assert it.
 *
 * The blast radius of a drift is small by construction — the server always
 * recomputes and stores ITS number, so a divergence shows a wrong preview, not
 * a wrong record. Small is not zero: a physio who sees 8.4 while filling the
 * form in and 7.9 on the tracker afterwards has lost trust in the whole thing.
 *
 * HOW. It imports both implementations — the real ones, not copies — and runs
 * thousands of randomised rating maps through each, including the shapes that
 * exercise the edges: fully-N/A groups, all-N/A forms, half-finished forms with
 * signals still missing from the map, and every uniform vector. Any single
 * mismatch fails the run.
 *
 * This file lives in tools/ rather than src/ deliberately: it reaches across
 * into the frontend package, and backend/tsconfig.json has rootDir "./src", so
 * a file importing across that boundary must stay out of the compiled build.
 * It is a development check, never shipped.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
  scoreSignals, CURRENT_MODEL, kpiModelPayload, SIGNAL_IDS, SIGNALS,
  RatingMap, SignalRating,
} from '../src/features/weekly-kpi/weekly-kpi.model';

const CLIENT_SCORER = path.join(__dirname, '../../frontend/src/lib/weeklyKpi.score.ts');

/** The shape this check needs off the client module. Declared rather than
 *  imported: the frontend's types live in an ESM package this CommonJS script
 *  cannot pull in, and importing them would only re-state what is asserted
 *  below by actually running the code. */
interface ClientScore {
  score:            number | null;
  band_id:          string | null;
  na_count:         number;
  standards_missed: string[];
  standards_na:     string[];
  groups:           { group_id: string; pct: number | null }[];
}
type ClientScorer = (model: unknown, answers: Record<string, unknown>) => ClientScore;

/**
 * Load the browser's scorer — the real file, not a copy.
 *
 * It cannot simply be `require`d: frontend/package.json declares
 * `"type": "module"`, so every .ts file in that package is an ES module, and
 * this script runs as CommonJS. Rather than fork the build config of either
 * package to satisfy a development check, the source is transpiled in memory
 * and evaluated here.
 *
 * The blocked `require` is the point, not a shortcut. weeklyKpi.score.ts is
 * written to have NO runtime imports — its only import is `import type`, which
 * erases — precisely so it can be verified in isolation like this. If someone
 * later adds a value import to it, this throws with that module's name instead
 * of the parity check quietly ceasing to be runnable.
 */
function loadClientScorer(): ClientScorer {
  const source = fs.readFileSync(CLIENT_SCORER, 'utf8');
  const js = ts.transpileModule(source, {
    fileName: CLIENT_SCORER,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;

  const mod = { exports: {} as Record<string, unknown> };
  const blockedRequire = (id: string): never => {
    throw new Error(
      `${path.basename(CLIENT_SCORER)} must have no runtime imports so it can be ` +
      `parity-checked in isolation, but it required "${id}". ` +
      `Use \`import type\` for types, or move the value into a parameter.`
    );
  };

  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(
    mod.exports, blockedRequire, mod, CLIENT_SCORER, path.dirname(CLIENT_SCORER),
  );

  const fn = mod.exports.scoreLocally;
  if (typeof fn !== 'function') {
    throw new Error(`${path.basename(CLIENT_SCORER)} does not export scoreLocally`);
  }
  return fn as ClientScorer;
}

const scoreLocally = loadClientScorer();

/** The client is driven by the SERVED payload, not by the internal model — the
 *  same JSON the browser gets, including point_map keys as strings. Scoring
 *  against the in-memory model would let a serialisation bug pass. */
const servedModel = JSON.parse(JSON.stringify(kpiModelPayload())) as unknown;

let cases = 0;
let mismatches = 0;

function compare(label: string, ratings: RatingMap): void {
  cases++;
  const server = scoreSignals(ratings);
  const client = scoreLocally(servedModel, ratings as Record<string, unknown>);

  const problems: string[] = [];
  if (server.score !== client.score) {
    problems.push(`score ${server.score} vs ${client.score}`);
  }
  if (server.band_id !== client.band_id) {
    problems.push(`band ${server.band_id} vs ${client.band_id}`);
  }
  if (server.na_count !== client.na_count) {
    problems.push(`na_count ${server.na_count} vs ${client.na_count}`);
  }
  if (server.standards_missed.join(',') !== client.standards_missed.join(',')) {
    problems.push(`standards_missed [${server.standards_missed}] vs [${client.standards_missed}]`);
  }
  if (server.standards_na.join(',') !== client.standards_na.join(',')) {
    problems.push(`standards_na [${server.standards_na}] vs [${client.standards_na}]`);
  }
  for (const g of server.groups) {
    const c = client.groups.find(x => x.group_id === g.group_id);
    const a = g.pct === null ? null : Math.round(g.pct * 1e9);
    const b = c?.pct == null ? null : Math.round(c.pct * 1e9);
    if (a !== b) problems.push(`group ${g.group_id} pct ${g.pct} vs ${c?.pct}`);
  }

  if (problems.length > 0) {
    mismatches++;
    if (mismatches <= 5) {
      console.log(`  MISMATCH  ${label}\n            ${problems.join('\n            ')}`);
      console.log(`            ratings: ${JSON.stringify(ratings)}`);
    }
  }
}

/** Deterministic PRNG (mulberry32) so a failure is reproducible from the seed
 *  printed below, rather than being a run nobody can repeat. */
function rng(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function main(): void {
  const SEED = 20260901;
  const rand = rng(SEED);
  const OPTIONS: (SignalRating | undefined)[] = [0, 1, 2, 3, null, undefined];

  console.log('Weekly Check-In — server / client scoring parity');
  console.log(`model ${CURRENT_MODEL.version}, ${SIGNALS.length} signals, seed ${SEED}\n`);

  // 1. Uniform vectors, including the document's published assertions.
  for (const v of [0, 1, 2, 3] as const) {
    const m: RatingMap = {};
    for (const id of SIGNAL_IDS) m[id] = v;
    compare(`all ${v}`, m);
  }

  // 2. Every single group fully N/A, one at a time — the renormalisation path,
  //    which is where a re-implementation is most likely to go wrong.
  for (const g of CURRENT_MODEL.groups) {
    const m: RatingMap = {};
    for (const s of SIGNALS) m[s.signal_id] = s.group_id === g.group_id ? null : 2;
    compare(`group ${g.group_id} fully N/A`, m);
  }

  // 3. All N/A — both sides must return null, not 0.
  {
    const m: RatingMap = {};
    for (const id of SIGNAL_IDS) m[id] = null;
    compare('all N/A', m);
  }

  // 4. Empty map — the form before the physio has answered anything.
  compare('nothing answered', {});

  // 5. Randomised, including missing keys (a half-finished form) and explicit
  //    nulls, which must score identically.
  for (let i = 0; i < 20000; i++) {
    const m: RatingMap = {};
    for (const id of SIGNAL_IDS) {
      const pick = OPTIONS[Math.floor(rand() * OPTIONS.length)];
      if (pick !== undefined) m[id] = pick;
      // `undefined` means the key is simply not written — the honest shape of a
      // form the physio has not finished.
    }
    compare(`random #${i}`, m);
  }

  console.log(`\n${cases} cases compared, ${mismatches} mismatch(es).`);
  console.log(mismatches === 0
    ? 'Server and client agree on every case.'
    : 'DRIFT: the form would show a physio a different score than the one stored.');
  process.exit(mismatches === 0 ? 0 : 1);
}

main();
