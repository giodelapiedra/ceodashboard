/**
 * Shared client-side contract for the duplicate guard. Mirrors
 * backend/src/shared/duplicates.ts.
 */

/** What the server should do when the natural key already exists. */
export type OnDuplicate = 'reject' | 'overwrite' | 'allow'

export interface DuplicateReport<T> {
  /** Same natural key — a real duplicate, or null if there is none. */
  exact:         T | null
  /** Same patient nearby in time on a different key. Advisory only. */
  similar:       T[]
  /** Whether THIS user may overwrite `exact` directly. False → edit-request. */
  can_overwrite: boolean
}

/**
 * Pull the duplicate report out of a 409 thrown by a create call.
 *
 * The pre-flight check is advisory — someone else can key the same entry in
 * the seconds between the check and the POST — so every create path has to be
 * able to recover from this and show the same dialog. Returns null for any
 * other error, which the caller should rethrow / surface as usual.
 */
export function duplicateReportFromError<T>(e: any): DuplicateReport<T> | null {
  if (e?.response?.status !== 409) return null
  const details = e?.response?.data?.error?.details
  if (!details || details.kind !== 'duplicate' || !details.exact) return null
  return {
    exact:         details.exact as T,
    similar:       (details.similar ?? []) as T[],
    can_overwrite: !!details.can_overwrite,
  }
}
