import { create } from 'zustand'
import { deleteRequestsApi } from '../api/deleteRequests.api'
import { editRequestsApi } from '../api/editRequests.api'

/**
 * Pending edit / delete request counters for the super admin.
 *
 * A toast was too easy to miss (it auto-hides after 8 s), so the counts live in
 * a shared store instead and drive three *persistent* signals that only go away
 * once the queue is actually empty:
 *   1. a blocking pop-up on login  (PendingApprovalsModal)
 *   2. a red bar under the header  (AppShell)
 *   3. red count badges on the Admin menu + the admin home card
 */
interface PendingApprovalsState {
  editCount:   number
  deleteCount: number
  /** True once the first fetch has come back — avoids flashing "0" on load. */
  loaded:      boolean
  /** Whether the pop-up is currently on screen. */
  popupOpen:   boolean
  /** User id the queue has already been announced for (once per login). */
  shownFor:    string | null
  /** Highest total already shown in a pop-up — a rise above it means new work. */
  announced:   number

  /** Re-fetch both queues. Safe to call from anywhere; failures are ignored. */
  refresh:     () => Promise<void>
  /** First fetch after login — fires the pop-up if anything is already pending. */
  announce:    (userId: string) => Promise<void>
  closePopup:  () => void
  /** Pages that already loaded a queue push their count in — saves a request. */
  setEditCount:   (n: number) => void
  setDeleteCount: (n: number) => void
  reset:       () => void
}

/** The two review queues — no pop-up while the admin is already looking at one. */
const QUEUE_PATHS = ['/admin/edit-requests', '/admin/delete-requests']

export const usePendingApprovalsStore = create<PendingApprovalsState>((set, get) => ({
  editCount:   0,
  deleteCount: 0,
  loaded:      false,
  popupOpen:   false,
  shownFor:    null,
  announced:   0,

  refresh: async () => {
    try {
      const [delReqs, editReqs] = await Promise.all([
        deleteRequestsApi.listPending(),
        editRequestsApi.listPending(),
      ])
      const total = delReqs.length + editReqs.length
      set({ deleteCount: delReqs.length, editCount: editReqs.length, loaded: true })
      const { announced, popupOpen } = get()
      if (total > announced) {
        // Something new came in (or this is the first fetch of the session) —
        // pop it up, unless the admin is already on the queue page.
        set({ announced: total })
        if (!popupOpen && !QUEUE_PATHS.includes(window.location.pathname)) {
          set({ popupOpen: true })
        }
      } else if (total < announced) {
        // Queue shrank — re-arm, so the next incoming request pops up again.
        set({ announced: total })
      }
    } catch { /* best-effort — never break the page over a counter */ }
  },

  announce: async (userId) => {
    if (get().shownFor === userId) return   // already announced this login
    set({ shownFor: userId })
    await get().refresh()
  },

  closePopup:      () => set({ popupOpen: false }),
  setEditCount:    (n) => set({ editCount: n, loaded: true, announced: n + get().deleteCount }),
  setDeleteCount:  (n) => set({ deleteCount: n, loaded: true, announced: n + get().editCount }),
  reset: () => set({
    editCount: 0, deleteCount: 0, loaded: false,
    popupOpen: false, shownFor: null, announced: 0,
  }),
}))
