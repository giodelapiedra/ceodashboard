import { create } from 'zustand'
import { weeklyKpiApi, UnreadThread } from '../api/weeklyKpi.api'

/**
 * Unread weekly-KPI comments for the logged-in account — the notification Sam
 * asked for on 2026-08-24 ("ma notify si clinician na nag comment").
 *
 * WHY A POLLED COUNTER AND NOT A PUSH: there is no notification infrastructure
 * in this app. Teams is deliberately disabled on prod (cron line and webhook
 * both commented out, 2026-08-06) and there is no email sender. What DOES
 * already work, and what staff are already trained to look at, is the red count
 * badge pattern the edit/delete approval queues use — a store, a 60 s poll, a
 * re-poll on focus, and a badge wherever the work lives. This is that pattern,
 * pointed at one endpoint.
 *
 * Both sides of a thread poll the same endpoint: a physio is told when Sam
 * comments, and Sam is told when someone replies on a thread he is in. The
 * server decides which of those two questions it is answering.
 */
interface WeeklyKpiUnreadState {
  /** Total unread comments across every thread the caller is part of. */
  total:   number
  /** Which weeks they are on — lets a row show its own "new" marker. */
  threads: UnreadThread[]
  /** True once the first fetch has come back; avoids flashing a 0 badge. */
  loaded:  boolean

  refresh: () => Promise<void>
  /** Unread count for one report, 0 when there is nothing waiting. */
  unreadFor: (reportId: string) => number
  reset:   () => void
}

export const useWeeklyKpiUnreadStore = create<WeeklyKpiUnreadState>((set, get) => ({
  total:   0,
  threads: [],
  loaded:  false,

  refresh: async () => {
    try {
      const res = await weeklyKpiApi.unread()
      set({ total: res.total, threads: res.threads, loaded: true })
    } catch {
      // Best-effort, exactly like the approvals counter: a badge that failed to
      // load must never take a page down with it.
    }
  },

  unreadFor: (reportId) =>
    get().threads.find(t => String(t.report_id) === String(reportId))?.unread ?? 0,

  reset: () => set({ total: 0, threads: [], loaded: false }),
}))
