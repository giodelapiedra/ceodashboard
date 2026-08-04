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

/** The Adaptive Card envelope the Workflows webhook requires. */
export function buildTeamsCard(lines: string[]) {
  const body = lines
    .filter(t => t !== '')
    .map((text, i) => ({
      type: 'TextBlock', text, wrap: true, spacing: i === 0 ? 'None' : 'Small',
    }));

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
