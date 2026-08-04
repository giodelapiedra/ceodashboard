/**
 * notify-weekly-teams.ts
 *
 * Posts ONE weekly summary to the Teams group covering BOTH trackers:
 *   - Daily Patient Dropout Tracking
 *   - Daily Case Recommendation & Acceptance Tracker
 *
 * Sent via the Teams "Workflows" incoming webhook (Power Automate).
 *
 * Design notes that matter:
 *   - The week is the SAME Monday-anchored Mon–Sun bucket the dashboard and the
 *     CEO scorecard sheet use (services/week.calculator.ts), so the numbers in
 *     Teams always match the dashboard. Headline counts are by `date_logged`.
 *   - EVERY clinic is listed, including zeros. Sam's first read of this report
 *     showed only Brookvale, which looked like a bug — it was real silence, but
 *     a clinic that vanishes from the list hides exactly the thing worth acting
 *     on. Zeros are the signal, so they are always rendered.
 *   - A clinic with nothing this week gets called out with the date it last
 *     encoded ANYTHING (either tracker) — that answers "sino ang hindi
 *     naglalagay ng data", which a date_logged-only count cannot.
 *
 * Usage (from backend/):
 *   npm run notify:weekly:teams                       # dry-run, sends nothing
 *   npm run notify:weekly:teams -- --send             # post to Teams
 *   npm run notify:weekly:teams -- --week last        # last completed week
 *   npm run notify:weekly:teams -- --from 2026-07-20 --to 2026-07-26 --send
 *
 * Required env to send: TEAMS_WEBHOOK_URL (Power Automate trigger URL — it
 * embeds its own `sig=` signature, so it is a SECRET; .env only).
 *
 * Payload: the Workflows webhook accepts ONLY a message envelope wrapping an
 * Adaptive Card — a plain {"text": ...} body returns HTTP 202 and then the flow
 * run FAILS ("adaptive card request is missing or invalid"). A flat `text` copy
 * rides along so the flow can be switched to "Post message in a chat or
 * channel" (Message = triggerBody()?['text']) without changing this script.
 */

import axios from 'axios';
import { pool, query } from '../db/pool';
import { postToTeams, teamsConfigured } from '../services/teams-notify.service';
import { dropoutRepository } from '../features/dropouts/dropout.repository';
import { caseAcceptanceRepository } from '../features/case-acceptance/case-acceptance.repository';
import { getWeekRanges } from '../services/week.calculator';
import { CLINIC_IDS } from '../shared/roles';
import { RequestScope } from '../middleware/auth.middleware';

// Read-only aggregate across every clinic — same internal "act as ADMIN" scope
// literal the repositories use for their own cross-clinic lookups.
const SYSTEM_SCOPE: RequestScope = {
  role: 'ADMIN', userId: '0', clinic_id: null, full_name: null,
};

const CLINIC_LABEL: Record<string, string> = {
  newport:   'Newport',
  narrabeen: 'Narrabeen',
  brookvale: 'Brookvale',
};

/** Clinic-local timezone — the box runs UTC, so encode dates need converting. */
const CLINIC_TZ = 'Australia/Sydney';

const pad = (n: number) => String(n).padStart(2, '0');
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/** "2026-07-27" -> "27 Jul". Pure string work — no Date, so no TZ surprises. */
function prettyDay(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}
function prettyRange(from: string, to: string): string {
  return `${prettyDay(from)} → ${prettyDay(to)} ${from.slice(0, 4)}`;
}

interface Week {
  label:    string;
  dateFrom: string;
  dateTo:   string;
}

/**
 * Every real Mon–Sun bucket around today, in order. Spans the previous, current
 * and next month because a month's grid starts on its FIRST Monday — the days
 * before it belong to the previous month's last bucket, and "last week" can sit
 * in the previous month.
 */
function bucketsAroundToday(): Week[] {
  const now  = new Date();
  const y    = now.getFullYear();
  const m    = now.getMonth() + 1; // 1-indexed
  const spans: Array<[number, number]> = [
    m === 1  ? [y - 1, 12] : [y, m - 1],
    [y, m],
    m === 12 ? [y + 1, 1]  : [y, m + 1],
  ];
  return spans
    .flatMap(([yy, mm]) => getWeekRanges(yy, mm))
    // The calculator returns a sentinel remainder (9999-12-31) for months that
    // end on Week 4's Sunday — not a real range.
    .filter(w => w.dateFrom !== '9999-12-31')
    .map(w => ({ label: w.label, dateFrom: w.dateFrom, dateTo: w.dateTo }))
    .sort((a, b) => a.dateFrom.localeCompare(b.dateFrom));
}

/** The bucket containing today, or the one before it. */
function pickWeek(which: 'current' | 'last'): Week {
  const iso     = todayISO();
  const buckets = bucketsAroundToday();
  const idx     = buckets.findIndex(w => iso >= w.dateFrom && iso <= w.dateTo);
  if (idx === -1) {
    // Shouldn't happen — the three-month span always covers today. Fail loudly
    // rather than silently reporting the wrong week.
    throw new Error(`No Mon-Sun bucket covers ${iso} — check week.calculator`);
  }
  if (which === 'current') return buckets[idx];
  if (idx === 0) throw new Error('No preceding week bucket available');
  return buckets[idx - 1];
}

// status / reason are nullable (the legacy 2026 import kept blanks verbatim),
// so an aggregate can carry a literal "null" key — never show that raw.
const cleanKey = (k: string) => (k === 'null' || k === '' ? '(not set)' : k);

function rank(o: Record<string, number>): Array<[string, number]> {
  return Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => [cleanKey(k), n]);
}

/** Per-clinic counts in fixed clinic order, zeros included. */
function perClinic(byClinic: Record<string, number>): Array<[string, number]> {
  return CLINIC_IDS.map(id => [CLINIC_LABEL[id] ?? id, byClinic[id] ?? 0]);
}

/**
 * Entries for the week grouped by a person column, both trackers combined,
 * busiest first. Not available from the repositories' aggregates (they group by
 * clinic / status / reason), so it's a small query local to this report.
 *
 * `column` is either:
 *   clinician_id — the treating physio recorded ON the entry
 *   entered_by   — the staff account that actually keyed the entry in
 * These are usually DIFFERENT people (front desk encodes for the physios), and
 * Sam read "Per clinician" as "who encoded", so the report now shows both under
 * explicit labels.
 */
async function perPerson(
  week: Week,
  column: 'clinician_id' | 'entered_by'
): Promise<Array<[string, number]>> {
  // Interpolated, never user input — one of two literals typed above.
  const { rows } = await query<{ person: string | null; n: string }>(`
    SELECT u.full_name AS person, COUNT(*)::bigint AS n
    FROM (
      SELECT ${column} AS person_id FROM patient_dropouts WHERE date_logged BETWEEN $1 AND $2
      UNION ALL
      SELECT ${column} AS person_id FROM case_acceptances WHERE date_logged BETWEEN $1 AND $2
    ) x
    JOIN users u ON u.id = x.person_id
    GROUP BY u.full_name
    ORDER BY COUNT(*) DESC, u.full_name ASC
  `, [week.dateFrom, week.dateTo]);

  // First name only — same convention as the staff pickers in the UI.
  return rows.map(r => [(r.person ?? '?').trim().split(/\s+/)[0], Number(r.n)]);
}

/**
 * Last calendar day (clinic-local) each clinic encoded ANYTHING, across both
 * trackers. Used to say how long a silent clinic has been silent.
 */
async function lastEncodedByClinic(): Promise<Record<string, string | null>> {
  const { rows } = await query<{ clinic_id: string; last_encoded: string | null }>(`
    SELECT clinic_id, MAX(d)::text AS last_encoded
    FROM (
      SELECT clinic_id, (created_at AT TIME ZONE $1)::date AS d FROM patient_dropouts
      UNION ALL
      SELECT clinic_id, (created_at AT TIME ZONE $1)::date AS d FROM case_acceptances
    ) x
    GROUP BY clinic_id
  `, [CLINIC_TZ]);

  const out: Record<string, string | null> = {};
  for (const id of CLINIC_IDS) out[id] = null;
  for (const r of rows) out[r.clinic_id] = r.last_encoded;
  return out;
}

interface Summary {
  which: 'current' | 'last';
  week:  Week;
  dropouts: {
    total:      number;
    byClinic:   Array<[string, number]>;
    byStatus:   Array<[string, number]>;
    topReasons: Array<[string, number]>;
  };
  cases: {
    total:       number;
    byClinic:    Array<[string, number]>;
    recs:        number;
    booked:      number;
    acceptedPct: number | null;
    prepayAcc:   number;
  };
  /** Entries by the treating physio recorded on the entry, busiest first. */
  byClinician: Array<[string, number]>;
  /** Entries by the staff account that keyed them in, busiest first. */
  byEncoder: Array<[string, number]>;
  /** Clinics with zero entries in BOTH trackers this week. */
  silent: Array<{ clinic: string; lastEncoded: string | null }>;
}

async function loadSummary(week: Week, which: 'current' | 'last'): Promise<Summary> {
  const filters = { date_from: week.dateFrom, date_to: week.dateTo };

  const [drop, cases, lastEncoded, byClinician, byEncoder] = await Promise.all([
    dropoutRepository.aggregate(SYSTEM_SCOPE, filters),
    caseAcceptanceRepository.aggregate(SYSTEM_SCOPE, filters),
    lastEncodedByClinic(),
    perPerson(week, 'clinician_id'),
    perPerson(week, 'entered_by'),
  ]);

  const silent = CLINIC_IDS
    .filter(id => (drop.byClinic[id] ?? 0) === 0 && (cases.byClinic[id] ?? 0) === 0)
    .map(id => ({ clinic: CLINIC_LABEL[id] ?? id, lastEncoded: lastEncoded[id] }));

  return {
    which, week,
    dropouts: {
      total:      drop.total,
      byClinic:   perClinic(drop.byClinic),
      byStatus:   rank(drop.byStatus),
      topReasons: rank(drop.byReason).slice(0, 3),
    },
    cases: {
      total:       cases.total,
      byClinic:    perClinic(cases.byClinic),
      recs:        cases.totalRecommendations,
      booked:      cases.totalBooked,
      acceptedPct: cases.caseAcceptancePct,
      prepayAcc:   cases.prepayAccepted,
    },
    byClinician,
    byEncoder,
    silent,
  };
}

/**
 * "Week so far" / "Week 3 [20-26]" — but for an explicit --from/--to run the
 * label IS the raw range, which would read twice next to the pretty range.
 */
function headingFor(s: Summary): string {
  if (s.which === 'current') return 'Week so far';
  return s.week.label === `${s.week.dateFrom} → ${s.week.dateTo}` ? 'Custom range' : s.week.label;
}

const joinCounts = (rows: Array<[string, number]>) =>
  rows.map(([k, n]) => `${k} ${n}`).join(', ');

/** The message body, as plain lines. Used for the card, the flat `text` copy
 *  and the console dry-run — one source of truth for the wording. */
function messageLines(s: Summary): string[] {
  const lines = [
    `**PhysioWard weekly trackers** — ${headingFor(s)}, ${prettyRange(s.week.dateFrom, s.week.dateTo)}`,
    ``,
    `**Dropouts: ${s.dropouts.total}**`,
    `Clinic: ${joinCounts(s.dropouts.byClinic)}`,
  ];
  if (s.dropouts.byStatus.length)   lines.push(`Status: ${joinCounts(s.dropouts.byStatus)}`);
  if (s.dropouts.topReasons.length) lines.push(`Top reasons: ${joinCounts(s.dropouts.topReasons)}`);

  const c = s.cases;
  lines.push(``);
  lines.push(`**Case acceptance: ${c.total}**`);
  lines.push(`Clinic: ${joinCounts(c.byClinic)}`);
  if (c.recs > 0) {
    lines.push(
      `Recommended ${c.recs}, booked ${c.booked}` +
      `${c.acceptedPct !== null ? ` (${c.acceptedPct}% acceptance)` : ''}` +
      `${c.prepayAcc > 0 ? `, prepay accepted ${c.prepayAcc}` : ''}`
    );
  }

  // Two different questions, so two labelled lines: whose patients these were,
  // and who did the data entry. "Per clinician" alone read as "who encoded".
  if (s.byClinician.length || s.byEncoder.length) {
    lines.push(``);
    if (s.byClinician.length) {
      lines.push(`**Treating clinician:** ${joinCounts(s.byClinician)}`);
    }
    if (s.byEncoder.length) {
      lines.push(`**Encoded by (staff):** ${joinCounts(s.byEncoder)}`);
    }
  }

  if (s.silent.length) {
    lines.push(``);
    lines.push(
      `**No entries this week: ${s.silent
        .map(x => `${x.clinic}${x.lastEncoded ? ` (last encoded ${prettyDay(x.lastEncoded)})` : ' (never)'}`)
        .join(', ')}**`
    );
  }
  return lines;
}

const renderText = (s: Summary) => messageLines(s).join('\n');

async function main() {
  const argv = process.argv.slice(2);
  const send = argv.includes('--send');
  const arg  = (name: string) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  const wArg = arg('--week') ?? 'current';
  if (wArg !== 'current' && wArg !== 'last') {
    throw new Error(`--week must be "current" or "last" (got "${wArg}")`);
  }

  // Explicit range wins over the Mon–Sun bucket — for a one-off catch-up post.
  const from = arg('--from');
  const to   = arg('--to');
  if ((from && !to) || (to && !from)) {
    throw new Error('--from and --to must be given together (YYYY-MM-DD)');
  }

  const week: Week = from && to
    ? { label: `${from} → ${to}`, dateFrom: from, dateTo: to }
    : pickWeek(wArg);

  const summary = await loadSummary(week, from && to ? 'last' : wArg);

  console.log('─'.repeat(72));
  console.log(renderText(summary));
  console.log('─'.repeat(72));

  if (!send) {
    console.log('\nDry run — nothing sent. Add --send to post this to Teams.');
    return;
  }

  if (!teamsConfigured()) {
    throw new Error('TEAMS_WEBHOOK_URL is not set — add it to .env before using --send');
  }

  // Power Automate answers 202 Accepted before the flow itself runs, so 202 is
  // NOT proof the card was posted — a bad payload still shows as a Failed run in
  // the flow's history. Anything 4xx/5xx throws.
  const status = await postToTeams(messageLines(summary));
  console.log(`Posted to Teams — HTTP ${status} (202 = accepted; check the flow run if nothing appears)`);
}

main()
  .catch((e: unknown) => {
    // Never print the URL itself (it embeds the signature). Axios puts the full
    // request URL in its message, so report only the status + response body.
    if (axios.isAxiosError(e)) {
      console.error(
        `Teams post failed — HTTP ${e.response?.status ?? '(no response)'}`,
        typeof e.response?.data === 'string' ? e.response.data.slice(0, 500) : e.response?.data ?? e.code
      );
    } else {
      console.error(e instanceof Error ? e.message : e);
    }
    process.exitCode = 1;
  })
  .finally(() => pool.end());
