import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';

/**
 * Occupancy from the Nookal v2 REST API, on the Occupancy report's own terms.
 *
 *     Occupancy = Occupied minutes / Scheduled Minutes
 *
 * Migrations 029 and 030 recorded that this could not be done from the API. Both
 * were checked against v3 (GraphQL) only, and both of the things they said were
 * missing turned out to be in v2:
 *
 *   getSchedules  the roster — a 15-minute grid per practitioner, per location,
 *                 per day, which is the report's "Scheduled Minutes"
 *   getEvents     the same diary events v3 returns with typeID null, but with
 *                 EventID / CategoryName / EventTitle attached, which is what
 *                 the report's "Events: 4 of 11 Events Selected" filter needs
 *
 * Verified against Sam's 03/08/2026-09/08/2026 report — see the accuracy notes
 * on fetchWeekOccupancy and docs/OCCUPANCY_2026-08-20.md.
 *
 * ── Freshness, which is the one real limit ─────────────────────────────────
 * getSchedules answers from the roster as it stands NOW. A booking that falls
 * outside today's roster comes back as -1, so an old week loses both rostered
 * time and the bookings inside it. Measured 2026-08-20, grid vs the appointments
 * actually in the diary: days from this week agreed within 15-90 minutes, days
 * from two weeks earlier were short by up to 840. So a week must be measured
 * while it is still fresh, which is why every result carries measuredDaysAfter
 * and why the caller is expected to refuse a stale one.
 */

// ── The v2 envelope ────────────────────────────────────────────────────────

interface V2Envelope<T> {
  status:  string;
  data?:   { api_call?: string; results?: Record<string, T[]> };
  details?: { totalItems?: string; currentItems?: number; errorMessage?: string; errorCode?: string; alerts?: string[] };
}

const PAGE_LENGTH = 200;

/** How many pages to walk before deciding something is wrong. At 200 rows a
 *  page this is 8,000 rows for one week — far past anything real. */
const MAX_PAGES = 40;

class NookalV2 {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({ baseURL: env.NOOKAL_BASE_URL, timeout: 30_000 });
  }

  /** One call, unpaged. Nookal reports its own failures in `details`, with the
   *  missing parameter named in `alerts` — worth surfacing, because that is how
   *  getSchedules' parameter list was found in the first place. */
  private async call<T>(endpoint: string, field: string, params: Record<string, string | number>): Promise<T[]> {
    const res = await this.client.get<V2Envelope<T>>(`/${endpoint}`, {
      params: { api_key: env.NOOKAL_API_KEY, ...params },
    });
    const body = res.data;
    if (body.status !== 'success') {
      const d = body.details;
      throw new Error(
        `Nookal v2 ${endpoint} failed: ${d?.errorMessage ?? 'unknown'}` +
        `${d?.errorCode ? ` (${d.errorCode})` : ''}` +
        `${d?.alerts?.length ? ` — ${d.alerts.join('; ')}` : ''}`
      );
    }
    return body.data?.results?.[field] ?? [];
  }

  /** Every page of one endpoint. v2 reports `details.totalItems` but no page
   *  count, so paging stops on a short page. */
  async fetchAll<T>(endpoint: string, field: string, params: Record<string, string | number>): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const rows = await this.call<T>(endpoint, field, { ...params, page, page_length: PAGE_LENGTH });
      out.push(...rows);
      if (rows.length < PAGE_LENGTH) return out;
    }
    console.warn(`[nookal-v2] ${endpoint} hit the ${MAX_PAGES}-page ceiling; results may be truncated`);
    return out;
  }

  /**
   * The roster grid for one practitioner at one location.
   *
   * date_to is EXCLUSIVE here, unlike getAppointments and getEvents where it is
   * inclusive. Measured 2026-08-20: 03->09 returns 03..08, 03->10 returns
   * 03..09, and from == to returns that one day. So callers pass the day after
   * the week they want, and this is the only endpoint that needs it.
   */
  async getSchedules(practitionerId: number, locationId: number, dateFrom: string, dateToExclusive: string) {
    // Not routed through call(): getSchedules nests differently from the list
    // endpoints — results is an object carrying `availabilities`, not an array
    // under a plural key — and it is never paged.
    const res = await this.client.get<{
      status: string;
      data?: { results?: { availabilities?: Record<string, Record<string, number>> } };
      details?: { errorMessage?: string; alerts?: string[] };
    }>('/getSchedules', {
      params: {
        api_key:         env.NOOKAL_API_KEY,
        practitioner_id: practitionerId,
        location_id:     locationId,
        date_from:       dateFrom,
        date_to:         dateToExclusive,
      },
    });
    if (res.data.status !== 'success') {
      throw new Error(
        `Nookal v2 getSchedules failed: ${res.data.details?.errorMessage ?? 'unknown'}` +
        `${res.data.details?.alerts?.length ? ` — ${res.data.details.alerts.join('; ')}` : ''}`
      );
    }
    return res.data.data?.results?.availabilities ?? {};
  }
}

const v2 = new NookalV2();

// ── Rows as v2 sends them ──────────────────────────────────────────────────

interface V2Practitioner {
  ID: string; FirstName: string; LastName: string; locations?: string[]; status?: string;
}
interface V2Appointment {
  appointmentDate: string; appointmentStartTime: string; appointmentEndTime: string;
  practitionerID: string; cancelled: string | null; DNA: string | null; status: string | null;
  appointmentType: string | null;
}
interface V2Event {
  ApptDate: string; StartTime: string; EndTime: string;
  ProviderID: string; EventID: string; CategoryName: string | null;
  EventTitle: string | null; IsActive: string | null;
}
interface V2Class {
  classDate: string; classStartTime: string; classEndTime: string;
  practitionerID: string; cancelled: string | null;
}

// ── The grid ───────────────────────────────────────────────────────────────

/**
 * What each value in the getSchedules grid means. Read off the live data on
 * 2026-08-20 (Angus Clark, Narrabeen, 2026-08-04, 07:00-17:00):
 *
 *   07:00=1 07:15=1 07:30=0 07:45=0 ... 11:00=3 ... 12:45=3 13:00=1 ...
 *
 * Values arrive in identical pairs because the diary is booked in 30-minute
 * blocks, but the grid itself is 15-minute, so a slot is worth 15 minutes.
 */
const NOT_ROSTERED = -1;
const FREE         = 0;
const BOOKED       = 1;
const BREAK        = 3;

const SLOT_MINUTES = 15;

/**
 * A practitioner is one person, so their locations are merged rather than added
 * up — two clinics can report the same 15 minutes. When they disagree, the
 * stronger claim on the time wins: booked over free, free over break. A slot
 * that is free at one clinic is genuinely still bookable, whatever another
 * clinic calls it.
 */
const CLAIM_RANK: Record<number, number> = { [BOOKED]: 4, [FREE]: 3, 2: 2, [BREAK]: 1 };
const rank = (v: number) => CLAIM_RANK[v] ?? 2;

/** Occupied time is measured on a finer grid than the roster so a hand-edited
 *  appointment starting off the quarter hour still lands somewhere sensible. */
const OCCUPIED_GRID_MINUTES = 5;

/**
 * How much of the diary the roster grid must account for before its denominator
 * is believed. Set at 0.9 rather than 1.0 because the two are measured on
 * different grids (15 minutes against 5) and a booking may legitimately sit
 * slightly outside a shift — Nookal's own report has Gabriella at 102.17% for
 * exactly that reason. What it rules out is a roster that has lost whole days.
 */
const ROSTER_COVERAGE_FLOOR = 0.9;

const toMinutes = (t: string | null | undefined): number => {
  const [h, m] = String(t ?? '').split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : NaN;
};

const addDays = (isoDate: string, days: number): string => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Diary event types that Nookal counts as occupied — the report's "Events: 4 of
 * 11 Events Selected".
 *
 * The account uses these EventIDs: 1 General, 15 Business, 18 1-on-1, 21 CPD,
 * 24 Event, 29 Team Meeting, 35 Team Training. Which of them the report counts
 * is a checkbox nobody can read from the API, so it was solved for: every subset
 * was scored against the eleven rows of the 03/08/2026 report, and {15, 18, 29}
 * active-only won — four practitioners exact on appointments alone became eight,
 * with the rest inside one 30-minute block.
 *
 * Override with NOOKAL_OCCUPIED_EVENT_IDS once the report's own Events dropdown
 * has been read; that is the authority, not this fit.
 */
const OCCUPIED_EVENT_IDS: Set<string> = new Set(
  (process.env.NOOKAL_OCCUPIED_EVENT_IDS ?? '15,18,29')
    .split(',').map((s) => s.trim()).filter(Boolean)
);

/**
 * Event types whose diary events are NOT roster breaks — their `3` slots stay
 * inside Scheduled Minutes.
 *
 * A `3` in the grid only says "rostered, but not open to patients", and two very
 * different things land on it: a break configured in the roster, which Nookal
 * subtracts as a "Scheduled Break", and a diary event laid over the day, which it
 * does not. Subtracting both is what made every practitioner's Scheduled come out
 * LOW — Noah -210, Angus -330, Zac -270, and not one of the eleven too high.
 *
 * Scored against the Scheduled column of the 03/08/2026 report, over the eight
 * practitioners whose roster the coverage check says is intact:
 *
 *   subtract every 3                    1110 min of error, 2 exact
 *   keep every 3 explained by an event   240 min of error, 3 exact
 *   keep only these four types              0 min of error, 8 EXACT
 *
 * ── Read this before trusting it ────────────────────────────────────────────
 * That last line is a FIT on one week, and it is underdetermined: swapping 15
 * (Business) for 18 (1-on-1) scores identically, because no practitioner that
 * week had a `3` distinguishing them. The four kept here are the account's
 * General, Business, Team Meeting and Team Training; the subtracted ones are
 * 1-on-1, CPD and Event.
 *
 * The mechanism is sound and worth 4.6x on its own even without the per-type
 * list — that is the middle line above. A second week's report is what would
 * turn the last line from a fit into a fact. Override with
 * NOOKAL_SCHEDULED_EVENT_IDS.
 */
const SCHEDULED_EVENT_IDS: Set<string> = new Set(
  (process.env.NOOKAL_SCHEDULED_EVENT_IDS ?? '1,15,29,35')
    .split(',').map((s) => s.trim()).filter(Boolean)
);

// ── Result ─────────────────────────────────────────────────────────────────

export interface ProviderOccupancy {
  providerId:       number;
  providerName:     string;
  /** Rostered minutes less the roster's own breaks — Nookal's "Scheduled Minutes". */
  scheduledMinutes: number;
  /** The breaks that were subtracted, kept so the rule can be revisited. */
  breakMinutes:     number;
  /** Appointment, class and counted-event minutes, as a union so a double
   *  booking or a two-clinic day is not counted twice. */
  occupiedMinutes:  number;
  /** null only when the practitioner neither worked nor was rostered. */
  occupancyPct:     number | null;

  /**
   * The roster's own booked slots (grid value 1), and the appointment minutes the
   * diary actually holds. These are two accounts of the same thing, so they are
   * kept side by side as a check on the roster rather than as figures in their
   * own right — see rosterIncomplete.
   */
  gridBookedMinutes:      number;
  appointmentOnlyMinutes: number;
  /**
   * True when the roster cannot account for the bookings that are in the diary.
   *
   * This is the drift check, and it is what stops a bad denominator reaching the
   * board. A booking outside today's roster comes back as -1, so the roster loses
   * the window AND the booking inside it — which shows up here as a grid that
   * reports far less booked time than the appointment feed does. Measured
   * 2026-08-20, Ben Bryden's week of 10 Aug came back with 960 rostered minutes
   * against 1500 minutes of real appointments: 156% occupancy, from a roster
   * missing most of his week.
   *
   * The tolerance is one-sided on purpose. The grid may legitimately read HIGHER
   * than the appointment feed, because counted diary events sit in it too.
   */
  rosterIncomplete: boolean;
}

export interface WeekOccupancy {
  dateFrom:          string;
  dateTo:            string;
  /** Days between the end of the week and this measurement. Above about 7 the
   *  roster has usually moved on and the figures understate the week. */
  measuredDaysAfter: number;
  providers:         ProviderOccupancy[];
}

/**
 * Measure one week, all locations, every provider with a diary.
 *
 * ── Accuracy, against the 03/08/2026-09/08/2026 report ─────────────────────
 * Occupied reproduced exactly for Samuel Ward (180), Noah Djordjevic (1470),
 * Gabriella Whittaker (1410), Ben Bryden (1500) and Emma Sloot (1230), and was
 * within one 30-minute block for the other six (Jervis -30, Angus +30, Isabella
 * -30, Caitlin -30, Zac -30, Kyle +30). Total error 180 minutes across roughly
 * 14,000 — about 1%, or a percentage point of occupancy.
 *
 * Scheduled reproduced exactly for Gabriella (1380) and Finn Van Lathum (480)
 * and drifted for the rest, but that week was already two weeks old when it was
 * measured. On a fresh week the grid tracks the diary to within 15-90 minutes.
 */
export async function fetchWeekOccupancy(dateFrom: string, dateTo: string, today?: string): Promise<WeekOccupancy> {
  const now  = today ?? new Date().toISOString().slice(0, 10);
  const days = Math.round((Date.parse(`${now}T00:00:00Z`) - Date.parse(`${dateTo}T00:00:00Z`)) / 86_400_000);

  const [practitioners, appointments, events, classes] = await Promise.all([
    v2.fetchAll<V2Practitioner>('getPractitioners', 'practitioners', {}),
    v2.fetchAll<V2Appointment>('getAppointments', 'appointments', { date_from: dateFrom, date_to: dateTo }),
    v2.fetchAll<V2Event>('getEvents', 'events', { date_from: dateFrom, date_to: dateTo }),
    v2.fetchAll<V2Class>('getClasses', 'classes', { date_from: dateFrom, date_to: dateTo }),
  ]);

  // ── Occupied: one 5-minute grid per provider, unioned ────────────────────
  // Two grids: everything the report counts, and appointments alone. The second
  // exists only to check the roster against the diary (see rosterIncomplete).
  const occupied    = new Map<number, Set<string>>();
  const apptsOnly   = new Map<number, Set<string>>();
  const paintInto = (into: Map<number, Set<string>>, providerId: number, date: string, from: number, to: number): void => {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
    let set = into.get(providerId);
    if (!set) { set = new Set(); into.set(providerId, set); }
    for (let t = from; t < to; t += OCCUPIED_GRID_MINUTES) set.add(`${date}|${t}`);
  };

  for (const a of appointments) {
    // A cancelled slot went back on the market. A DNA did not — the time was
    // held and could not be resold, and the report counts it: including DNAs is
    // what made Noah, Gabriella and Emma land exactly on their reported figures.
    if (a.cancelled === '1') continue;
    const [p, d, s, e] = [Number(a.practitionerID), a.appointmentDate, toMinutes(a.appointmentStartTime), toMinutes(a.appointmentEndTime)] as const;
    paintInto(occupied,  p, d, s, e);
    paintInto(apptsOnly, p, d, s, e);
  }
  for (const c of classes) {
    if (c.cancelled === '1') continue;
    const [p, d, s, e] = [Number(c.practitionerID), c.classDate, toMinutes(c.classStartTime), toMinutes(c.classEndTime)] as const;
    paintInto(occupied,  p, d, s, e);
    paintInto(apptsOnly, p, d, s, e);
  }
  for (const e of events) {
    if (!OCCUPIED_EVENT_IDS.has(String(e.EventID))) continue;
    // An inactive event is one that was deleted or superseded; the diary no
    // longer holds that time.
    if (e.IsActive !== '1') continue;
    paintInto(occupied, Number(e.ProviderID), e.ApptDate, toMinutes(e.StartTime), toMinutes(e.EndTime));
  }

  // ── Scheduled: the roster grid, merged across a provider's locations ─────
  const dateToExclusive = addDays(dateTo, 1);
  const providers: ProviderOccupancy[] = [];

  for (const p of practitioners) {
    const providerId = Number(p.ID);
    const locations  = (p.locations ?? []).map(Number).filter(Number.isFinite);

    const merged = new Map<string, number>();
    for (const locationId of locations) {
      const grid = await v2.getSchedules(providerId, locationId, dateFrom, dateToExclusive);
      for (const [date, slots] of Object.entries(grid)) {
        // The endpoint has its own idea of the range; keep only the week asked for.
        if (date < dateFrom || date > dateTo) continue;
        for (const [time, value] of Object.entries(slots)) {
          if (value === NOT_ROSTERED) continue;
          const k    = `${date}|${time}`;
          const held = merged.get(k);
          if (held === undefined || rank(value) > rank(held)) merged.set(k, value);
        }
      }
    }

    let rosteredSlots = 0, breakSlots = 0, bookedSlots = 0;
    for (const value of merged.values()) {
      rosteredSlots += 1;
      if (value === BREAK)  breakSlots  += 1;
      if (value === BOOKED) bookedSlots += 1;
    }

    const breakMinutes     = breakSlots * SLOT_MINUTES;
    const scheduledMinutes = rosteredSlots * SLOT_MINUTES - breakMinutes;
    const occupiedMinutes  = (occupied.get(providerId)?.size ?? 0) * OCCUPIED_GRID_MINUTES;

    const gridBookedMinutes      = bookedSlots * SLOT_MINUTES;
    const appointmentOnlyMinutes = (apptsOnly.get(providerId)?.size ?? 0) * OCCUPIED_GRID_MINUTES;
    // A grid that accounts for less than this much of the diary has lost
    // rostered windows, and with them the bookings inside them.
    const rosterIncomplete =
      appointmentOnlyMinutes > 0 &&
      gridBookedMinutes < appointmentOnlyMinutes * ROSTER_COVERAGE_FLOOR;

    // Nothing rostered and nothing booked: the practitioner did not work that
    // week, which is not the same as a 0% week.
    const occupancyPct =
      scheduledMinutes > 0 ? Math.round((occupiedMinutes / scheduledMinutes) * 100 * 100) / 100
      : occupiedMinutes > 0 ? 100   // what the report shows for time booked against no roster
      : null;

    providers.push({
      providerId,
      providerName: `${p.FirstName} ${p.LastName}`.trim(),
      scheduledMinutes,
      breakMinutes,
      occupiedMinutes,
      occupancyPct,
      gridBookedMinutes,
      appointmentOnlyMinutes,
      rosterIncomplete,
    });
  }

  return { dateFrom, dateTo, measuredDaysAfter: days, providers };
}

/** Exposed for the CLI, so a run can print which event types it counted. */
export const occupiedEventIds = (): string[] => [...OCCUPIED_EVENT_IDS];
