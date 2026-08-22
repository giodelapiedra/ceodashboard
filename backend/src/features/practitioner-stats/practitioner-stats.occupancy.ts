import { nookalV3 } from '../../services/nookal-v3/client';

/**
 * Occupancy from Nookal — how much of a practitioner's still-bookable diary is
 * actually booked.
 *
 * Migration 024 recorded Occupancy as having no API path. That held for the
 * appointment feed, but Nookal v3 also exposes `availabilities`, which returns
 * the free bookable slots left in a diary. Probed live 2026-08-20:
 *
 *   availabilities(dateFrom: "2026-08-10", dateTo: "2026-08-16",
 *                  locationID: [1,2,6], staffID: [117], slotDuration: 15)
 *     -> 14:30 14:45 15:00 15:15 15:30 15:45 on 2026-08-10, and 14:30 14:45 on
 *        2026-08-13
 *
 * Angus was booked until 14:00 and again from 16:00 that Monday, so the six
 * slots are exactly his 90 free minutes. Re-running at slotDuration 30 returned
 * 14:30 15:00 15:30 and at 60 returned 14:30 — the slots tile each free gap at
 * whatever granularity is asked for, without overlapping. So:
 *
 *     free minutes = slot count x slotDuration
 *
 * and 15 is the granularity to ask for: every appointment length in the practice
 * is a multiple of 15 (measured over two weeks: 15, 30, 45, 60, 75, 90), so 15
 * loses nothing, while 60 would silently drop a trailing half hour.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 * This is not a reproduction of Nookal's own Reports -> Occupancy screen. That
 * report divides booked time by ROSTERED SHIFT hours, which is why it can read
 * above 100% when appointments are booked outside a shift — migration 024 cites
 * a real 113%. Dividing by booked + still-free cannot exceed 100% by
 * construction. The shift roster lives behind the v2 REST endpoint
 * `getSchedules` (params: practitioner_id, location_id, date_from, date_to —
 * confirmed by that endpoint's own "Missing variable" replies), but the
 * NOOKAL_API_KEY in .env is dead: it draws the same L003/L004 refusal as a
 * garbage key. Once a working v2 key exists, swap the denominator here and the
 * two figures reconcile.
 */

// ── GraphQL ────────────────────────────────────────────────────────────────

const AVAILABILITIES_QUERY = /* GraphQL */ `
  query Availabilities(
    $dateFrom: String!, $dateTo: String!,
    $locationID: [Int], $staffID: [Int], $slotDuration: Int
  ) {
    availabilities(
      dateFrom: $dateFrom, dateTo: $dateTo,
      locationID: $locationID, staffID: $staffID, slotDuration: $slotDuration
    ) {
      range {
        slots {
          startTime
          date
          location_id
          ProviderID
        }
      }
    }
  }
`;

/** One still-bookable slot. Nookal types the ids as String here, unlike
 *  everywhere else in the schema, so they are parsed rather than trusted. */
interface FreeSlot {
  startTime:   string | null;
  date:        string | null;
  location_id: string | null;
  ProviderID:  string | null;
}

/** The appointment fields occupancy needs. A superset of what the appointment
 *  sync reads, so one fetch feeds both. */
export interface ApptWindow {
  providerID:      number | null;
  appointmentDate: string;
  startTime:       string | null;
  endTime:         string | null;
  status:          string | null;
  apptType:        string | null;
}

/**
 * Granularity to ask Nookal for, and the resolution the diary is painted at.
 *
 * SLOT_MINUTES is what free time is counted in. GRID_MINUTES is finer so that a
 * hand-edited appointment starting off-grid still lands somewhere sensible
 * instead of being rounded into a neighbouring slot.
 */
const SLOT_MINUTES = 15;
const GRID_MINUTES = 5;

/**
 * Nookal collapses a single-element list into a bare object. Every list-valued
 * field in this schema needs the same treatment — see fetchProviders in
 * practitioner-stats.nookal.ts.
 */
const arr = <T>(v: T | T[] | null | undefined): T[] =>
  Array.isArray(v) ? v : v ? [v] : [];

/**
 * Free bookable slots for the given practitioners over a date range.
 *
 * One call covers the whole month and every location at once — measured at
 * ~2,500 slots and 3.5s for August 2026 across all three clinics, so there is
 * no reason to page or split it. `staffID` cannot be omitted: leaving it out
 * returns zero slots rather than every provider.
 */
export async function fetchFreeSlots(
  dateFrom:    string,
  dateTo:      string,
  locationIDs: number[],
  staffIDs:    number[]
): Promise<FreeSlot[]> {
  if (staffIDs.length === 0) return [];

  interface Range { slots?: FreeSlot | FreeSlot[] | null }
  interface Availability { range?: Range | Range[] | null }

  const data = await nookalV3.query<{ availabilities: Availability | Availability[] | null }>(
    AVAILABILITIES_QUERY,
    {
      dateFrom, dateTo,
      locationID:   locationIDs,
      staffID:      staffIDs,
      slotDuration: SLOT_MINUTES,
    }
  );

  return arr(data.availabilities)
    .flatMap((a) => arr(a.range))
    .flatMap((r) => arr(r.slots));
}

// ── Minute arithmetic ──────────────────────────────────────────────────────

/** "14:30" and "14:30:00" both appear in this API. NaN for anything else, which
 *  the callers treat as "no usable window" rather than as midnight. */
function toMinutes(t: string | null | undefined): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(t ?? '');
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

export interface OccupancyMinutes {
  /** Consultation and class time held. */
  bookedMinutes:    number;
  /** Still bookable — the rest of the denominator. */
  availableMinutes: number;
  /** Blockouts. Reported but not in the denominator; see occupancyPct. */
  blockedMinutes:   number;
}

/**
 * Occupancy as a percentage, or null when it cannot honestly be stated.
 *
 * Denominator is booked + free. Blocked-out time is excluded rather than
 * counted against the practitioner: a break, a meeting or an admin block is
 * time the diary was closed to patients, not time they failed to fill. That is
 * a judgement, which is exactly why occupancy_blocked_minutes is stored — the
 * rule can be changed by recomputing from the stored columns, with no re-sync.
 *
 * Null when there is no free time at all. Nookal's `availabilities` answers from
 * the roster as it stands TODAY, so a week whose roster has since been replaced
 * reports zero free minutes and would otherwise read as a flawless 100%.
 * Measured 2026-08-20: free hours per week hold at 93-157h back to Feb 2026,
 * then collapse (Jan 2026: 49h across 5 practitioners; Feb 2025: 46h across 3).
 * A practitioner genuinely booked solid for a whole week would be lost in that
 * same signal, so the week is left blank for a human instead of asserted.
 */
export function occupancyPct(m: OccupancyMinutes): number | null {
  if (m.availableMinutes <= 0) return null;
  const denominator = m.bookedMinutes + m.availableMinutes;
  if (denominator <= 0) return null;
  return Math.round((m.bookedMinutes / denominator) * 100 * 100) / 100;
}

/**
 * Whether an appointment holds real patient time.
 *
 * Statuses seen live over three sample weeks: Completed, StdAppt (booked, not
 * yet seen), Waiting, DNA, Cancelled, Event, Note, Class.
 *
 *   - DiaryNote / Note occupies no diary time at all — it is an annotation
 *     pinned to a time, and several sit on top of live appointments.
 *   - DiaryEvent / Event is a blockout: breaks, meetings, admin.
 *   - Cancelled is excluded. The slot went back on the market, and Nookal
 *     confirms it by handing that same window back as free — verified for Angus
 *     on 2026-08-10, whose cancelled 15:00 and 15:30 reappear in the free-slot
 *     list. Counting it as booked would double-count it.
 *   - DNA counts as booked. The patient did not turn up, but the practitioner's
 *     time was held and could not be resold, which is what occupancy measures.
 */
function classify(a: ApptWindow): 'booked' | 'blocked' | 'ignore' {
  if (a.apptType === 'DiaryNote')  return 'ignore';
  if (a.apptType === 'DiaryEvent') return 'blocked';
  if (a.status   === 'Cancelled')  return 'ignore';
  return 'booked';
}

/**
 * Booked / available / blocked minutes per provider for one date window.
 *
 * Painted onto a minute grid and measured by set size rather than by summing
 * durations, because durations double-count overlap and a practitioner cannot
 * be in two places at once. Overlap is not hypothetical: double-booked
 * consultations, an all-day blockout laid over a normal day, and a practitioner
 * split across two clinics on one date all occur in this data. Locations are
 * unioned for the same reason — the practitioner is one person.
 *
 * Precedence: booked beats blocked beats free. A blockout laid over a live
 * consultation must not erase it, and a slot some other record shows as
 * occupied is not free.
 */
export function occupancyByProvider(
  appts:    ApptWindow[],
  slots:    FreeSlot[],
  dateFrom: string,
  dateTo:   string
): Map<number, OccupancyMinutes> {
  const booked  = new Map<number, Set<string>>();
  const blocked = new Map<number, Set<string>>();
  const free    = new Map<number, Set<string>>();

  const cells = (m: Map<number, Set<string>>, pid: number): Set<string> => {
    let s = m.get(pid);
    if (!s) m.set(pid, s = new Set());
    return s;
  };
  const paint = (into: Set<string>, day: string, from: number, to: number): void => {
    for (let t = from; t < to; t += GRID_MINUTES) into.add(`${day}T${t}`);
  };

  for (const a of appts) {
    const pid = Number(a.providerID);
    if (!Number.isFinite(pid) || pid <= 0) continue;

    const day = (a.appointmentDate ?? '').slice(0, 10);
    if (!day || day < dateFrom || day > dateTo) continue;

    const start = toMinutes(a.startTime);
    const end   = toMinutes(a.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    const kind = classify(a);
    if (kind === 'ignore') continue;
    paint(cells(kind === 'booked' ? booked : blocked, pid), day, start, end);
  }

  for (const s of slots) {
    const pid = Number(s.ProviderID);
    if (!Number.isFinite(pid) || pid <= 0) continue;

    const day = (s.date ?? '').slice(0, 10);
    if (!day || day < dateFrom || day > dateTo) continue;

    const start = toMinutes(s.startTime);
    if (!Number.isFinite(start)) continue;
    paint(cells(free, pid), day, start, start + SLOT_MINUTES);
  }

  const out = new Map<number, OccupancyMinutes>();
  const providers = new Set<number>([...booked.keys(), ...blocked.keys(), ...free.keys()]);

  for (const pid of providers) {
    const b = booked.get(pid)  ?? new Set<string>();
    const k = blocked.get(pid) ?? new Set<string>();
    const f = free.get(pid)    ?? new Set<string>();

    let blockedOnly = 0;
    for (const cell of k) if (!b.has(cell)) blockedOnly += 1;

    let freeOnly = 0;
    for (const cell of f) if (!b.has(cell) && !k.has(cell)) freeOnly += 1;

    out.set(pid, {
      bookedMinutes:    b.size      * GRID_MINUTES,
      blockedMinutes:   blockedOnly * GRID_MINUTES,
      availableMinutes: freeOnly    * GRID_MINUTES,
    });
  }

  return out;
}
