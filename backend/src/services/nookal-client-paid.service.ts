import { nookalV3 } from './nookal-v3/client';

/**
 * Resolve a free-text patient name (as typed on an ad lead) to Nookal client
 * account totals — the same "Invoiced / Paid" figures Nookal shows on
 * Clients → Accounts, so staff don't have to look each booked lead up by hand.
 *
 * Verified live 2026-07-30 (diag-client-paid.ts): the v3 `clients` query
 * accepts firstName/lastName args (case-insensitive) and exposes the client's
 * nested `invoices` with server-computed Total / TotalPayments, matching the
 * Nookal UI to the cent once voided invoices are excluded.
 */

// Two-step on purpose: asking for nested `invoices` in the SEARCH query makes
// Nookal silently truncate the client list (observed live: lastName "West"
// returns 17 clients without invoices but only 5 with them). So the search is
// names-only, and invoices are fetched afterwards for just the shortlisted
// clientIDs.
const CLIENT_SEARCH_QUERY = /* GraphQL */ `
  query ClientPaidSearch($firstName: String, $lastName: String, $page: Int!, $pageLength: Int!) {
    clients(firstName: $firstName, lastName: $lastName, page: $page, pageLength: $pageLength) {
      clientID
      firstName
      lastName
      nickname
      fullName
    }
  }
`;

// One clientID per call, NOT batched: page/pageLength govern the flattened
// client×invoice join, so a batch of 5 clients with pageLength 5 comes back
// with 5 invoices *total* (observed live). Per client we page until a page
// comes back short.
const CLIENT_INVOICES_QUERY = /* GraphQL */ `
  query ClientPaidInvoices($ids: [Int], $page: Int!, $pageLength: Int!) {
    clients(clientIDs: $ids, page: $page, pageLength: $pageLength) {
      clientID
      fullName
      invoices { Total TotalPayments void }
    }
  }
`;

const INVOICE_PAGE_LENGTH = 200;   // Nookal's silent per-page cap
const INVOICE_MAX_PAGES   = 10;    // 2000 invoices — far beyond any real client

// One page is plenty: we search with at least a full surname, and a surname
// with 50+ clients is useless as a match anyway (reported as 'multiple').
const SEARCH_PAGE_LENGTH = 50;

interface RawClientStub {
  clientID:  number;
  firstName: string | null;
  lastName:  string | null;
  nickname:  string | null;
  fullName:  string | null;
}

interface RawClientInvoices {
  clientID: number;
  fullName: string | null;
  invoices: { Total: number | null; TotalPayments: number | null; void: number }[] | null;
}

export interface NookalPaidCandidate {
  clientID:      number;
  fullName:      string;
  invoiceCount:  number;
  invoiced:      number;
  paid:          number;
}

export interface NookalPaidLookup {
  status:     'matched' | 'multiple' | 'not_found' | 'error';
  candidates: NookalPaidCandidate[];
}

/** How many names one lookup batch may resolve concurrently against Nookal. */
const LOOKUP_CONCURRENCY = 4;

/**
 * Totals move whenever the front desk takes a payment, so keep the cache
 * short — it only exists to absorb re-renders / page flips, not to persist.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 1000;

const cache = new Map<string, { at: number; result: NookalPaidLookup }>();

function normalizeName(name: string): string {
  return name.trim().replace(/["'’]/g, '').replace(/\s+/g, ' ').toLowerCase();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function searchClients(vars: { firstName?: string; lastName?: string }): Promise<RawClientStub[]> {
  const data = await nookalV3.query<{ clients: RawClientStub[] }>(CLIENT_SEARCH_QUERY, {
    ...vars,
    page:       1,
    pageLength: SEARCH_PAGE_LENGTH,
  });
  return data.clients ?? [];
}

/** All of one client's invoices, paging until a page comes back short. */
async function fetchAllInvoices(clientID: number) {
  const all: { Total: number | null; TotalPayments: number | null; void: number }[] = [];
  for (let page = 1; page <= INVOICE_MAX_PAGES; page++) {
    const data = await nookalV3.query<{ clients: RawClientInvoices[] }>(CLIENT_INVOICES_QUERY, {
      ids: [clientID], page, pageLength: INVOICE_PAGE_LENGTH,
    });
    const invoices = data.clients?.[0]?.invoices ?? [];
    all.push(...invoices);
    if (invoices.length < INVOICE_PAGE_LENGTH) break;
  }
  return all;
}

/** Fetch invoice totals for the shortlisted clients. */
async function fetchCandidates(stubs: RawClientStub[]): Promise<NookalPaidCandidate[]> {
  return Promise.all(stubs.map(async (s) => {
    const invoices = (await fetchAllInvoices(s.clientID)).filter((i) => i.void !== 1);
    return {
      clientID:     s.clientID,
      fullName:     s.fullName ?? [s.firstName, s.lastName].filter(Boolean).join(' '),
      invoiceCount: invoices.length,
      invoiced:     round2(invoices.reduce((sum, i) => sum + (i.Total ?? 0), 0)),
      paid:         round2(invoices.reduce((sum, i) => sum + (i.TotalPayments ?? 0), 0)),
    };
  }));
}

/**
 * Two-step match:
 *  1. exact firstName + lastName (Nookal matches case-insensitively);
 *  2. if nothing, lastName only, then keep clients whose first name OR
 *     nickname starts with the lead's first token — catches "Tom West"
 *     encoded for a client registered as Thomas (nickname Tom) West.
 */
async function lookupOne(rawName: string): Promise<NookalPaidLookup> {
  const tokens = normalizeName(rawName).split(' ').filter(Boolean);
  if (tokens.length === 0) return { status: 'not_found', candidates: [] };

  const first = tokens[0];
  const last  = tokens[tokens.length - 1];

  let matches: RawClientStub[];
  if (tokens.length === 1) {
    // Single word — could be either name part; surname is the better bet.
    matches = await searchClients({ lastName: last });
  } else {
    matches = await searchClients({ firstName: first, lastName: last });
    if (matches.length === 0) {
      const byLast = await searchClients({ lastName: last });
      matches = byLast.filter((c) =>
        (c.firstName ?? '').toLowerCase().startsWith(first) ||
        (c.nickname  ?? '').toLowerCase().startsWith(first)
      );
    }
  }

  const candidates = await fetchCandidates(matches.slice(0, 5));
  return {
    status: matches.length === 1 ? 'matched'
          : matches.length > 1   ? 'multiple'
          : 'not_found',
    candidates,
  };
}

/**
 * Resolve many lead names at once (the All Entries page sends one batch per
 * page of booked leads). Results are keyed by the exact input strings.
 * A lookup that fails (Nookal down, timeout) reports status 'error' for that
 * name only — one bad name must not sink the whole batch.
 *
 * refresh=true ignores cached entries (still re-caching the fresh results) —
 * the manual Sync button uses it to pick up payments taken minutes ago.
 */
export async function lookupPaidByNames(
  names: string[],
  refresh = false
): Promise<Record<string, NookalPaidLookup>> {
  const now = Date.now();
  const results: Record<string, NookalPaidLookup> = {};

  // Unique by normalized form so "Tom West" and "tom west" cost one call.
  const pending = new Map<string, string[]>();
  for (const name of names) {
    const key = normalizeName(name);
    const hit = refresh ? undefined : cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      results[name] = hit.result;
    } else {
      const list = pending.get(key);
      if (list) list.push(name);
      else pending.set(key, [name]);
    }
  }

  const keys = [...pending.keys()];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(LOOKUP_CONCURRENCY, keys.length) }, async () => {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      const inputs = pending.get(key)!;
      let result: NookalPaidLookup;
      try {
        result = await lookupOne(inputs[0]);
        cache.set(key, { at: Date.now(), result });
      } catch (err) {
        console.warn(`[nookal-paid] lookup failed for "${inputs[0]}":`, (err as Error).message);
        result = { status: 'error', candidates: [] };
        // Deliberately NOT cached — the next request retries.
      }
      for (const name of inputs) results[name] = result;
    }
  });
  await Promise.all(workers);

  // Crude size cap — drop the oldest entries once the map grows too big.
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = [...cache.entries()]
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, cache.size - CACHE_MAX_ENTRIES);
    for (const [k] of oldest) cache.delete(k);
  }

  return results;
}
