import { PoolClient } from 'pg';
import { AppError } from './errors';

/**
 * What the caller wants done when an entry with the same natural key already
 * exists:
 *   - 'reject'    (default) → 409 CONFLICT carrying the existing row, so the
 *                  UI can show a side-by-side diff and let the user choose.
 *   - 'allow'     → the user looked at the diff and chose to save anyway —
 *                  insert a second row.
 *
 * There is deliberately no 'overwrite'. Until 2026-08-12 a duplicate could be
 * written over in place, which for a non-admin meant being pushed into the
 * edit-request approval queue mid-entry. Sam's call: the guard warns, it never
 * blocks and never routes an entry into review. Correcting a saved row is a
 * separate, explicit action from the entries list.
 */
export type OnDuplicate = 'reject' | 'allow';

/**
 * Canonical patient name for duplicate matching: inner whitespace collapsed,
 * trimmed, lowercased. Without this, "  cedric   ADAMS " and "Cedric Adams"
 * are different keys and the guard is defeated by a stray space — which is
 * exactly how duplicates get in when two people key the same patient.
 *
 * MUST stay equivalent to NAME_NORM_SQL below: the JS side builds the advisory
 * lock key, the SQL side does the matching, and they have to agree.
 */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * SQL twin of normalizeName(), e.g. NAME_NORM_SQL('d.patient_name').
 * The functional indexes in migration 022 use this exact expression — keep
 * them character-identical or Postgres will ignore the index and seq-scan.
 *
 * `[[:space:]]+` rather than `\s+` on purpose: `\s` was verified NOT to match
 * in this database (a name with a double space came back uncollapsed), and a
 * backslash in the pattern also depends on standard_conforming_strings. The
 * POSIX class has no escape at all, so it cannot silently degrade.
 */
export const NAME_NORM_SQL = (col: string): string =>
  `lower(btrim(regexp_replace(${col}, '[[:space:]]+', ' ', 'g')))`;

/**
 * Tier-2 window. Same patient at the same clinic within ±14 days is worth a
 * heads-up (a dropout logged twice in the same week is usually a mistake) but
 * is NOT blocked — a patient can legitimately drop out or be re-assessed more
 * than once.
 */
export const SIMILAR_WINDOW_DAYS = 14;

/**
 * What the 409 body and the pre-flight check both return. Purely informational:
 * every field here feeds the warning dialog, and nothing in it can stop a save.
 */
export interface DuplicateReport<T> {
  /** Same natural key — a true duplicate. */
  exact:   T | null;
  /** Same patient + clinic near the same date, different key. Advisory only. */
  similar: T[];
}

/**
 * Serialize check-then-insert for one natural key. Two identical POSTs racing
 * (double-click, two browser tabs, receptionist and clinician keying the same
 * patient at once) would otherwise both read "no duplicate" and both insert.
 *
 * Transaction-scoped: released on COMMIT/ROLLBACK, so no leak on error. Keyed
 * by hash, so unrelated entries never contend.
 */
export async function lockDuplicateKey(client: PoolClient, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
}

/**
 * 409 CONFLICT whose `details` carry the whole existing row. The client shows
 * the diff from this payload — it must never have to re-fetch to find out what
 * it collided with.
 */
export function duplicateConflict<T>(
  label:    string,
  report:   DuplicateReport<T>
): AppError {
  return new AppError(
    'CONFLICT',
    `This ${label} has already been logged. Check the details, then save it anyway if it is a separate one.`,
    { kind: 'duplicate', ...report }
  );
}
