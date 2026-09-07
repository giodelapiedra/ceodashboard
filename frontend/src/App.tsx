import React, { useEffect, useRef } from 'react'
import { useAuthStore } from './store/auth.store'
import { canAccessAdLeads } from './types'
import { useNavStore } from './store/nav.store'
import { useToastStore } from './store/toast.store'
import { usePendingApprovalsStore } from './store/pendingApprovals.store'
import { useWeeklyKpiUnreadStore } from './store/weeklyKpiUnread.store'
import { draftsApi } from './api/drafts.api'
import LoginPage from './components/Auth/LoginPage'
import DashboardPage from './components/Dashboard/DashboardPage'
import UserManagementPage from './components/Admin/UserManagementPage'
import DropoutAdminPage from './components/Admin/DropoutAdminPage'
import DropoutAnalyticsPage from './components/Admin/DropoutAnalyticsPage'
import CEOAnalyticsPage from './components/Admin/CEOAnalyticsPage'
import CaseAcceptanceAdminPage from './components/Admin/CaseAcceptanceAdminPage'
import PractitionerStatsPage from './components/Admin/PractitionerStatsPage'
import AuditLogPage from './components/Admin/AuditLogPage'
import DropoutEntryPage from './components/Dropouts/DropoutEntryPage'
import CaseAcceptanceEntryPage from './components/CaseAcceptance/CaseAcceptanceEntryPage'
import DraftsPage from './components/Drafts/DraftsPage'
import DeleteRequestsPage from './components/Admin/DeleteRequestsPage'
import EditRequestsPage from './components/Admin/EditRequestsPage'
import ClinicianProfilePage from './components/Admin/ClinicianProfilePage'
import AdSpendEntryPage from './components/AdSpend/AdSpendEntryPage'
import AdLeadsEntryPage from './components/AdLeads/AdLeadsEntryPage'
import ClinicianHomePage from './components/Clinician/ClinicianHomePage'
import WeeklyKpiPage from './components/WeeklyKpi/WeeklyKpiPage'
import MyProfilePage from './components/Clinician/MyProfilePage'
import WeeklyKpiTrackerPage from './components/Admin/WeeklyKpiTrackerPage'
import ToastContainer from './components/shared/ToastContainer'
import ConfirmDialog from './components/shared/ConfirmDialog'
import PromptDialog from './components/shared/PromptDialog'
import DuplicateDialog from './components/shared/DuplicateDialog'
import PendingApprovalsModal from './components/shared/PendingApprovalsModal'

export default function App() {
  const { isAuthenticated, isLoading, refreshToken, user } = useAuthStore()
  const { page, navigate } = useNavStore()

  // On app load — try to restore session via refresh token cookie
  useEffect(() => { refreshToken() }, [])

  // When user changes role (e.g. just logged in), pick a sensible default page.
  useEffect(() => {
    if (!user) return
    if (user.role === 'ADMIN') {
      // Super admin lands on the card-style choice hub, then picks what to do.
      // 'dashboard' (the '/' default) is intentionally NOT in this list, so a
      // fresh login lands on the hub. The dashboard is still reachable via the
      // hub card / top menu (navigating there doesn't re-fire this effect).
      // 'admin-practitioner-stats' was missing here, so reloading the browser
      // while on Practitioner Stats bounced the admin back to the hub. Now
      // that a hub card points straight at it, that had to be fixed.
      if (!['admin-home', 'admin-ceo-analytics', 'admin-users', 'admin-dropouts', 'admin-dropout-analytics', 'admin-case-acceptance', 'admin-practitioner-stats', 'admin-ad-leads', 'ad-leads-entry', 'admin-delete-requests', 'admin-edit-requests', 'admin-activity-log', 'admin-clinician-profile', 'admin-weekly-kpi', 'dropout-entry', 'case-acceptance-entry', 'ad-spend-entry', 'drafts'].includes(page)) {
        navigate('admin-home')
      }
    } else if (user.role === 'ADSPEND') {
      // Was hard-locked onto the ad-spend form; since 2026-08-12 it lands on a
      // two-card hub (ad spend + ad leads). Ad-leads is still gated by the
      // allow-list, so a future ADSPEND account that is not listed keeps the
      // ad-spend page only.
      const asAllowed = ['adspend-home', 'ad-spend-entry']
      if (canAccessAdLeads(user.role, user.email)) asAllowed.push('ad-leads-entry')
      if (!asAllowed.includes(page)) navigate('adspend-home')
    } else if (user.role === 'CLINICIAN') {
      if (!['clinician-home', 'dropout-entry', 'case-acceptance-entry', 'weekly-kpi', 'my-profile', 'drafts'].includes(page)) {
        navigate('clinician-home')
      }
    } else {
      // FRONT_DESK / FRONT_DESK_GLOBAL land on the same card-style home page
      // as clinicians, then pick what to record. Ad-leads is open to the whole
      // front desk since 2026-08-12, on the same rules bella@ always had.
      const fdAllowed = ['frontdesk-home', 'dropout-entry', 'case-acceptance-entry', 'drafts']
      if (canAccessAdLeads(user.role, user.email)) fdAllowed.push('ad-leads-entry')
      if (!fdAllowed.includes(page)) {
        navigate('frontdesk-home')
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.role])

  // On login, remind encoders if they left unfinished drafts behind. Fires once
  // per login (keyed on user id) — restored sessions count as a login too.
  const remindedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!user) { remindedFor.current = null; return }
    if (remindedFor.current === user.id) return  // already reminded this login
    remindedFor.current = user.id
    const role = user.role
    ;(async () => {
      try {
        if (['CLINICIAN', 'FRONT_DESK', 'FRONT_DESK_GLOBAL'].includes(role)) {
          // Encoders: remind about unfinished drafts.
          const [dropouts, cases] = await Promise.all([
            draftsApi.list('dropout'),
            draftsApi.list('case_acceptance'),
          ])
          const n = dropouts.length + cases.length
          if (n > 0) {
            useToastStore.getState().show(
              'info',
              `You have ${n} saved draft${n === 1 ? '' : 's'} — open “My Drafts” to finish ${n === 1 ? 'it' : 'them'}.`,
              8000,
            )
          }
        }
      } catch { /* reminder is best-effort — never block the app on it */ }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // Admin: pending edit / delete requests get a pop-up, then stay visible as a red
  // bar + menu badges until the queue is cleared. Counts are re-polled every 60 s
  // and whenever the tab regains focus, so a request filed while the admin is
  // already logged in pops up on its own too (see the store's `announced` guard).
  useEffect(() => {
    if (!user) { usePendingApprovalsStore.getState().reset(); return }
    if (user.role !== 'ADMIN') return
    const store = usePendingApprovalsStore.getState()
    store.announce(user.id)
    const tick = () => { if (!document.hidden) usePendingApprovalsStore.getState().refresh() }
    const timer = setInterval(tick, 60_000)
    window.addEventListener('focus', tick)
    return () => { clearInterval(timer); window.removeEventListener('focus', tick) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // Weekly KPI comment threads (2026-08-24). Both sides of a thread get the
  // same polled counter: the physio is told when Sam comments on their week,
  // Sam is told when a physio replies on a thread he is in. Same 60 s + focus
  // cadence as the approvals queue above — there is no push channel in this app
  // (Teams is disabled on prod, no email sender), so a poll IS the notification.
  useEffect(() => {
    if (!user) { useWeeklyKpiUnreadStore.getState().reset(); return }
    if (user.role !== 'CLINICIAN' && user.role !== 'ADMIN') return
    const tick = () => { if (!document.hidden) useWeeklyKpiUnreadStore.getState().refresh() }
    tick()
    const timer = setInterval(tick, 60_000)
    window.addEventListener('focus', tick)
    return () => { clearInterval(timer); window.removeEventListener('focus', tick) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  if (isLoading) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: '#f0f2f5', fontFamily: "'DM Sans', sans-serif",
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: 36, height: 36,
            border: '3px solid #e5e7eb', borderTop: '3px solid #0f6e56',
            borderRadius: '50%', margin: '0 auto 16px',
            animation: 'spin 0.8s linear infinite',
          }} />
          <div style={{ fontSize: 14, color: '#6b7280' }}>Loading...</div>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    )
  }

  if (!isAuthenticated || !user) {
    return <><LoginPage /><ToastContainer /><ConfirmDialog /><PromptDialog /><DuplicateDialog /></>
  }

  let page_node: React.ReactNode
  if (user.role === 'ADMIN') {
    if      (page === 'dashboard')                page_node = <DashboardPage />
    else if (page === 'admin-users')              page_node = <UserManagementPage />
    else if (page === 'admin-dropouts')           page_node = <DropoutAdminPage />
    else if (page === 'admin-dropout-analytics')  page_node = <DropoutAnalyticsPage />
    else if (page === 'admin-ceo-analytics')      page_node = <CEOAnalyticsPage />
    else if (page === 'admin-case-acceptance')    page_node = <CaseAcceptanceAdminPage />
    else if (page === 'admin-practitioner-stats') page_node = <PractitionerStatsPage />
    else if (page === 'admin-ad-leads')           page_node = <AdLeadsEntryPage />
    else if (page === 'admin-delete-requests')    page_node = <DeleteRequestsPage />
    else if (page === 'admin-edit-requests')      page_node = <EditRequestsPage />
    else if (page === 'admin-activity-log')       page_node = <AuditLogPage />
    else if (page === 'admin-clinician-profile')  page_node = <ClinicianProfilePage />
    // Team Performance KPI: the admin gets the shared TRACKER, never the form.
    // Spec section 2 puts Sam on the viewing side by name, and the server
    // refuses a submit from an ADMIN token — so there is no admin form to route.
    else if (page === 'admin-weekly-kpi')         page_node = <WeeklyKpiTrackerPage />
    // ADMIN can also create/edit/delete entries and save drafts, so they get
    // the entry pages + drafts, plus the card-style choice hub as their home.
    else if (page === 'case-acceptance-entry')    page_node = <CaseAcceptanceEntryPage />
    else if (page === 'dropout-entry')            page_node = <DropoutEntryPage />
    else if (page === 'ad-spend-entry')           page_node = <AdSpendEntryPage />
    // Same component as 'admin-ad-leads' above. The admin's own hub card and
    // top menu both use 'admin-ad-leads', but /ad-leads-entry is a real URL an
    // admin can bookmark or be linked to — without this line it silently fell
    // through to the hub, which is how Sam found it on 2026-08-12.
    else if (page === 'ad-leads-entry')           page_node = <AdLeadsEntryPage />
    else if (page === 'drafts')                   page_node = <DraftsPage />
    else                                          page_node = <ClinicianHomePage />
  } else if (user.role === 'ADSPEND') {
    // Still a hard lock, just over three pages now instead of one: the hub, the
    // ad-spend form, and — only for an allow-listed login — ad leads. No
    // dashboard, dropouts, or case acceptance, whatever the nav state says.
    if      (page === 'ad-spend-entry') page_node = <AdSpendEntryPage />
    else if (page === 'ad-leads-entry' && canAccessAdLeads(user.role, user.email)) page_node = <AdLeadsEntryPage />
    else                                page_node = <ClinicianHomePage />
  } else if (user.role === 'CLINICIAN') {
    if      (page === 'dropout-entry')         page_node = <DropoutEntryPage />
    else if (page === 'case-acceptance-entry') page_node = <CaseAcceptanceEntryPage />
    else if (page === 'weekly-kpi')            page_node = <WeeklyKpiPage />
    // The physio's own profile — their weeks, their dropouts, their case
    // acceptance, read-only. Sam's ask 2026-08-24: "dapat meron profile view
    // din si clinician makita niya data". Same shape as the admin's
    // /admin/clinician-profile, minus every administrative control.
    else if (page === 'my-profile')            page_node = <MyProfilePage />
    else if (page === 'drafts')                page_node = <DraftsPage />
    else                                       page_node = <ClinicianHomePage />
  } else {
    // FRONT_DESK, FRONT_DESK_GLOBAL — card home + entry pages + drafts.
    if      (page === 'case-acceptance-entry') page_node = <CaseAcceptanceEntryPage />
    else if (page === 'drafts')                page_node = <DraftsPage />
    else if (page === 'dropout-entry')         page_node = <DropoutEntryPage />
    else if (page === 'ad-leads-entry' && canAccessAdLeads(user.role, user.email)) page_node = <AdLeadsEntryPage />
    else                                       page_node = <ClinicianHomePage />
  }

  return <>{page_node}<PendingApprovalsModal /><ToastContainer /><ConfirmDialog /><PromptDialog /><DuplicateDialog /></>
}
