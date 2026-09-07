import React, { useState } from 'react'
import { weeklyKpiApi } from '../../api/weeklyKpi.api'
import { WeeklyKpiDTO, canDeleteWeeklyKpiReport } from '../../types'
import { useAuthStore } from '../../store/auth.store'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/confirm.store'
import { BORDER_MID, DANGER, TEXT_MUTED, weekLabel, smallBtnStyle } from './weeklyKpi.ui'

/**
 * Delete one weekly KPI report — Sam's ask, 2026-08-24:
 * *"puwede rin mag delete si super admin Team performance KPI"*.
 *
 * One component rather than a button in each of the two places a report can be
 * opened (the tracker row, and a week in the history list), because the thing
 * worth keeping in one place is the WORDING of the confirmation: it names the
 * physio and the week, and it says out loud that the comment thread goes too.
 * A generic "Are you sure?" on the only irreversible action in the feature is
 * how the wrong week gets deleted.
 *
 * Renders nothing for anyone but the super admin — a physio has no delete for
 * their own week by design (correct the current one by re-submitting it; past
 * weeks are frozen).
 */
export default function DeleteReportButton({
  report, onDeleted,
}: {
  report:    WeeklyKpiDTO
  /** Re-read whatever list this button was rendered in. */
  onDeleted: () => void
}) {
  const { user } = useAuthStore()
  const [busy, setBusy] = useState(false)
  const [hover, setHover] = useState(false)

  if (!user || !canDeleteWeeklyKpiReport(user.role)) return null

  const who  = report.clinician_name ?? 'this clinician'
  const week = weekLabel(report.week_start)
  const comments = report.comment_count ?? 0

  const run = async () => {
    const ok = await confirmDialog.destructive({
      title:   'Delete this weekly KPI report?',
      message:
        `${who} · ${week}\n\n` +
        'This removes the Monday half, the Friday half' +
        (comments > 0
          ? ` and the ${comments} comment${comments === 1 ? '' : 's'} on this week`
          : '') +
        '. It cannot be undone, and the physio cannot re-file a past week.',
      confirmLabel: 'Delete this week',
    })
    if (!ok) return

    setBusy(true)
    try {
      await weeklyKpiApi.deleteReport(report.id)
      toast.success(`Deleted ${who}’s report for ${week}`)
      onDeleted()
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || 'Could not delete the report')
    } finally { setBusy(false) }
  }

  return (
    <button
      onClick={run}
      disabled={busy}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`Delete ${who}’s report for ${week}`}
      style={{
        ...smallBtnStyle,
        // Quiet until pointed at: it sits next to two harmless buttons, and a
        // permanently red control in that row invites the wrong click.
        color:       hover && !busy ? DANGER : TEXT_MUTED,
        borderColor: hover && !busy ? DANGER : BORDER_MID,
        opacity:     busy ? 0.5 : 1,
        cursor:      busy ? 'wait' : 'pointer',
        transition:  'color .12s, border-color .12s',
      }}
    >
      {busy ? 'Deleting…' : 'Delete this week'}
    </button>
  )
}
