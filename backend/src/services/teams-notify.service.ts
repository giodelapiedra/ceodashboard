/**
 * teams-notify.service.ts
 *
 * One place that knows how to put a message in the Teams group. Used by the
 * weekly summary script AND by the live edit/delete-request alerts.
 *
 * Transport: the Teams "Workflows" incoming webhook (Power Automate). It accepts
 * ONLY a message envelope wrapping an Adaptive Card — a plain {"text": "..."}
 * body comes back HTTP 202 and then the flow run FAILS ("adaptive card request
 * is missing or invalid"). A flat `text` copy rides along so the flow can be
 * switched to "Post message in a chat or channel" (Message =
 * triggerBody()?['text']) with no change here.
 * Ref: learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using
 *
 * Cards are deliberately plain — one line per fact, no FactSet columns, no
 * oversized numbers. Sam asked for something that reads like a chat message.
 */

import axios from 'axios';
import { env } from '../config/env';

/** Admin UI origin, for deep links in alerts. FRONTEND_URL is a comma list of
 *  allowed origins; the CEO admin app is the one Sam actually opens. */
export function adminAppUrl(): string {
  const origins = env.FRONTEND_URL.split(',').map(s => s.trim()).filter(Boolean);
  return origins.find(o => o.includes('ceoadmin')) ?? origins[0] ?? '';
}

export function teamsConfigured(): boolean {
  return !!env.TEAMS_WEBHOOK_URL;
}

/**
 * The Adaptive Card envelope the Workflows webhook requires.
 *
 * An EMPTY string in `lines` is a block break, not a line: it is dropped from
 * the card and the next real line is given a rule and wider spacing instead.
 * Sam, 2026-08-31: the KPI alerts ran as five equal lines and read as one wall
 * — "may separation para mas madali intindihin pag nag notify". An empty
 * TextBlock renders as nothing in Teams, so the gap has to be spacing, not a
 * blank line.
 *
 * This CHANGED the weekly summary card too (scripts/notify-weekly-teams.ts),
 * which already pushed `''` between its sections and had them silently dropped.
 * Those breaks now render, which is what pushing a blank line was always
 * reaching for — so the convention is deliberately shared rather than given a
 * private marker. Anything that wants a literal blank line has to say so with
 * a space; nothing does.
 *
 * Leading and trailing breaks are ignored (no rule above the first line or
 * below the last), and consecutive breaks collapse into one.
 */
export function buildTeamsCard(lines: string[]) {
  const body: Array<Record<string, unknown>> = [];
  let breakBefore = false;

  for (const text of lines) {
    if (text === '') { breakBefore = body.length > 0; continue; }
    body.push({
      type: 'TextBlock', text, wrap: true,
      spacing: body.length === 0 ? 'None' : breakBefore ? 'Medium' : 'Small',
      ...(breakBefore ? { separator: true } : {}),
    });
    breakBefore = false;
  }

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl:  null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type:    'AdaptiveCard',
          version: '1.2',
          body,
        },
      },
    ],
    text: lines.join('\n'),
  };
}

/** Posts and throws on failure — for scripts that want to report the result. */
export async function postToTeams(lines: string[]): Promise<number> {
  if (!env.TEAMS_WEBHOOK_URL) {
    throw new Error('TEAMS_WEBHOOK_URL is not set');
  }
  const res = await axios.post(env.TEAMS_WEBHOOK_URL, buildTeamsCard(lines), {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15_000,
  });
  return res.status;
}

/**
 * Fire-and-forget notification for use inside a request handler.
 *
 * Never awaited by the caller and never rethrows: a Teams outage, a rotated
 * webhook URL or a slow Power Automate must NOT make a receptionist's
 * edit/delete request fail. Failures are logged and nothing else.
 * No-op when TEAMS_WEBHOOK_URL is unset (dev machines, tests).
 */
export function notifyTeams(lines: string[]): void {
  if (!env.TEAMS_WEBHOOK_URL) return;
  postToTeams(lines).catch((e: unknown) => {
    // Never log the URL — it embeds its own `sig=` auth.
    const status = axios.isAxiosError(e) ? e.response?.status ?? e.code : undefined;
    console.error(`[teams] notification failed${status ? ` (${status})` : ''}:`,
      e instanceof Error ? e.message.replace(env.TEAMS_WEBHOOK_URL!, '<webhook>') : e);
  });
}

// ── Shared bits for the request alerts ───────────────────────────────────────

const ENTITY_LABEL: Record<string, string> = {
  dropout:         'Dropout',
  case_acceptance: 'Case acceptance',
  ad_lead:         'Ad lead',
};

const CLINIC_LABEL: Record<string, string> = {
  newport:   'Newport',
  narrabeen: 'Narrabeen',
  brookvale: 'Brookvale',
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/** "2026-07-27" -> "27 Jul 2026". String work only — no Date, no TZ surprises. */
function prettyDate(iso: string | null): string | null {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** "Dropout · Jay Rowley · 27 Jul 2026 · Brookvale" — whatever is known. */
function entityLine(r: {
  entity_type: string; patient_name: string | null;
  entry_date: string | null; clinic_id: string | null;
}): string {
  return [
    ENTITY_LABEL[r.entity_type] ?? r.entity_type,
    r.patient_name,
    prettyDate(r.entry_date),
    r.clinic_id ? CLINIC_LABEL[r.clinic_id] ?? r.clinic_id : null,
  ].filter(Boolean).join('  ·  ');
}

/**
 * Alert for a new edit request. `patch` keys are listed (not their values) so
 * the alert says WHAT changed without dumping the whole record into the chat.
 */
export function notifyEditRequest(r: {
  entity_type:  string;
  patient_name: string | null;
  entry_date:   string | null;
  clinic_id:    string | null;
  reason:       string;
  patch:        Record<string, unknown>;
  requested_by_name: string | null;
}): void {
  const fields = Object.keys(r.patch).map(k => k.replace(/_/g, ' ')).join(', ');
  notifyTeams([
    `**Edit request — waiting for admin approval**`,
    entityLine(r),
    `Requested by ${r.requested_by_name || 'a staff member'}`,
    ...(fields ? [`Changing: ${fields}`] : []),
    `Reason: ${r.reason}`,
    `[Review it](${adminAppUrl()}/admin/edit-requests)`,
  ]);
}

/** Alert for a new delete request. */
export function notifyDeleteRequest(r: {
  entity_type:  string;
  patient_name: string | null;
  entry_date:   string | null;
  clinic_id:    string | null;
  reason:       string | null;
  requested_by_name: string | null;
}): void {
  notifyTeams([
    `**Delete request — waiting for admin approval**`,
    entityLine(r),
    `Requested by ${r.requested_by_name || 'a staff member'}`,
    `Reason: ${r.reason || 'none given'}`,
    `[Review it](${adminAppUrl()}/admin/delete-requests)`,
  ]);
}

// ── Weekly KPI submission alerts ─────────────────────────────────────────────
//
// Own webhook (TEAMS_KPI_WEBHOOK_URL), not TEAMS_WEBHOOK_URL above — that one
// is disabled on prod (2026-08-06) and this must not silently ride back in on
// it. No-op the same way when unset.

function notifyKpiTeams(lines: string[]): void {
  if (!env.TEAMS_KPI_WEBHOOK_URL) return;
  axios.post(env.TEAMS_KPI_WEBHOOK_URL, buildTeamsCard(lines), {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15_000,
  }).catch((e: unknown) => {
    const status = axios.isAxiosError(e) ? e.response?.status ?? e.code : undefined;
    console.error(`[teams:kpi] notification failed${status ? ` (${status})` : ''}:`,
      e instanceof Error ? e.message.replace(env.TEAMS_KPI_WEBHOOK_URL!, '<webhook>') : e);
  });
}

/**
 * Who the card is about. The NAME only — no clinic.
 *
 * Sam, 2026-09-01: *"alisin mo ung clinic name sa teams pag nag notify … jan
 * wala na dapat ganyan newport etc"*. The clinic was on the card because the
 * other Teams notifiers in this file carry it, but those are about operational
 * records that belong to a site (a dropout, a case acceptance). This one is
 * about a person's own week, and physios rotate between clinics — so the clinic
 * on the card was at best noise and at worst wrong by the time it was read.
 *
 * The report still STORES clinic_id (migration 032 keeps it deliberately, so a
 * past week keeps reading as the clinic it was reported for). It just is not
 * announced.
 */
function kpiWho(clinician_name: string | null): string {
  return clinician_name || 'A physio';
}

/**
 * The week's running count, as Sam asked for it: "4 of 10 submitted".
 *
 * Optional on purpose — the counts come from an extra query the caller runs
 * after the save, and if that query fails the alert still goes out without
 * this line rather than not going out at all.
 *
 * Structurally identical to `WeekProgress` in the weekly-kpi repository, and
 * deliberately NOT imported from it: this is a shared service that every
 * feature may call, so it declares what it needs and lets the caller satisfy
 * it. Importing a feature's repository type here would point the dependency
 * the wrong way and tie the notifier to that feature's schema.
 */
export interface KpiProgress {
  submitted:     number;
  friday_closed: number;
  expected:      number;
}

/** The footer block: a break, then "4 of 10 submitted · 2 Friday closed".
 *  Empty when the counts are absent, so the card simply ends at the answer. */
function kpiProgressBlock(p?: KpiProgress | null): string[] {
  return p
    ? ['', `${p.submitted} of ${p.expected} submitted  ·  ${p.friday_closed} Friday closed`]
    : [];
}

/**
 * Both KPI cards are the same four blocks, in the order Sam asked for
 * (2026-08-31): heading, who and when, the answer they gave, and the week's
 * running count LAST — "sa dulo ung submitted". The count is context for the
 * whole team, so it reads as a footer; putting it above the answer buried the
 * one line the alert exists to deliver.
 *
 * '' between blocks draws the rule (see buildTeamsCard).
 */
function kpiCard(heading: string, r: {
  clinician_name: string | null;
  week_start:     string;
  progress?:      KpiProgress | null;
}, answer: string[]): void {
  notifyKpiTeams([
    `**${heading}**`,
    '',
    kpiWho(r.clinician_name),
    `Week of ${prettyDate(r.week_start)}`,
    '',
    ...answer,
    ...kpiProgressBlock(r.progress),
  ]);
}

/**
 * ── WHAT THESE TWO CARDS MAY SAY ───────────────────────────────────────────
 *
 * Sam, 2026-09-01: *"we dont want the effectiveness / mojo rating showing in
 * the group chat, or any other information. We only want the Intention on a
 * Monday, and their wins on a Friday."*
 *
 * TEAMS_KPI_WEBHOOK_URL posts into a GROUP CHAT — everybody on it reads every
 * card. An Effectiveness score, a Mojo number, a missed Standard or a
 * contradictory count is one person's week being read by their colleagues, and
 * none of it is anybody else's business. So the cards carry the physio's own
 * words and nothing measured about them.
 *
 * This is enforced by the SIGNATURES below, not by remembering to leave things
 * out: neither function accepts a score, a band, a mojo rating, a Standard or a
 * count. A future edit cannot leak one into the group chat without deliberately
 * adding the parameter back and reading this comment on the way past.
 *
 * The section 8 triggers the reference document asks for — standards missed by
 * name, mojo at or below 5, a high N/A count — are NOT lost. They are on the
 * tracker and on the physio's own results screen, where the super admin reads
 * them privately. There is no private Teams channel for this feature, so the
 * group chat is not where they go.
 */

/** Monday card: who, which week, and their intention. Nothing else. */
export function notifyKpiMonday(r: {
  clinician_name: string | null;
  week_start:     string;
  intention:      string;
  progress?:      KpiProgress | null;
}): void {
  // Label and answer on separate lines: an intention is a sentence, and
  // "**Intention:** <sentence>" wraps into an unreadable block on a phone.
  kpiCard('Weekly KPI — Monday submitted', r, [
    '**Intention**',
    r.intention,
  ]);
}

/**
 * Friday card: who, which week, and what went well. Nothing else — in
 * particular NOT whether they achieved their Monday intention, which this card
 * used to announce. That is a pass/fail on a person, published to their
 * colleagues; it belongs on the tracker, not in the group chat.
 */
export function notifyKpiFriday(r: {
  clinician_name: string | null;
  week_start:     string;
  /** "What went well this week?" — optional on the form, so it can be blank. */
  wins:           string | null;
  progress?:      KpiProgress | null;
}): void {
  const wins = r.wins?.trim();
  kpiCard('Weekly KPI — Friday closed', r, wins
    ? ['**Wins**', wins]
    // The card still goes out with nothing written: closing the week is itself
    // the news, and a physio who had a quiet week must not look like one who
    // did not submit. Said plainly rather than left as an empty block.
    : ['**Wins**', '_Nothing noted this week._']);
}
