import React, { useEffect, useRef } from 'react'
import { useAuthStore } from './store/auth.store'
import { isAdLeadsEncoder } from './types'
import { useNavStore } from './store/nav.store'
import { useToastStore } from './store/toast.store'
import { usePendingApprovalsStore } from './store/pendingApprovals.store'
import { draftsApi } from './api/drafts.api'
import LoginPage from './components/Auth/LoginPage'
import DashboardPage from './components/Dashboard/DashboardPage'
import UserManagementPage from './components/Admin/UserManagementPage'
import DropoutAdminPage from './components/Admin/DropoutAdminPage'
import DropoutAnalyticsPage from './components/Admin/DropoutAnalyticsPage'
import CEOAnalyticsPage from './components/Admin/CEOAnalyticsPage'
import CaseAcceptanceAdminPage from './components/Admin/CaseAcceptanceAdminPage'
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
      if (!['admin-home', 'admin-ceo-analytics', 'admin-users', 'admin-dropouts', 'admin-dropout-analytics', 'admin-case-acceptance', 'admin-ad-leads', 'admin-delete-requests', 'admin-edit-requests', 'admin-activity-log', 'admin-clinician-profile', 'dropout-entry', 'case-acceptance-entry', 'ad-spend-entry', 'drafts'].includes(page)) {
        navigate('admin-home')
      }
    } else if (user.role === 'ADSPEND') {
      // The ad-spend encoder only ever sees the ad-spend entry page.
      if (page !== 'ad-spend-entry') navigate('ad-spend-entry')
    } else if (user.role === 'CLINICIAN') {
      if (!['clinician-home', 'dropout-entry', 'case-acceptance-entry', 'drafts'].includes(page)) {
        navigate('clinician-home')
      }
    } else {
      // FRONT_DESK / FRONT_DESK_GLOBAL land on the same card-style home page
      // as clinicians, then pick what to record. Ad-leads is only reachable by
      // allow-listed logins (see AD_LEADS_ENCODER_EMAILS).
      const fdAllowed = ['frontdesk-home', 'dropout-entry', 'case-acceptance-entry', 'drafts']
      if (isAdLeadsEncoder(user.email)) fdAllowed.push('ad-leads-entry')
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
    else if (page === 'admin-ad-leads')           page_node = <AdLeadsEntryPage />
    else if (page === 'admin-delete-requests')    page_node = <DeleteRequestsPage />
    else if (page === 'admin-edit-requests')      page_node = <EditRequestsPage />
    else if (page === 'admin-activity-log')       page_node = <AuditLogPage />
    else if (page === 'admin-clinician-profile')  page_node = <ClinicianProfilePage />
    // ADMIN can also create/edit/delete entries and save drafts, so they get
    // the entry pages + drafts, plus the card-style choice hub as their home.
    else if (page === 'case-acceptance-entry')    page_node = <CaseAcceptanceEntryPage />
    else if (page === 'dropout-entry')            page_node = <DropoutEntryPage />
    else if (page === 'ad-spend-entry')           page_node = <AdSpendEntryPage />
    else if (page === 'drafts')                   page_node = <DraftsPage />
    else                                          page_node = <ClinicianHomePage />
  } else if (user.role === 'ADSPEND') {
    // Hard lock: the ad-spend encoder can ONLY ever render this one page,
    // regardless of nav state. No dashboard, dropouts, or case acceptance.
    page_node = <AdSpendEntryPage />
  } else if (user.role === 'CLINICIAN') {
    if      (page === 'dropout-entry')         page_node = <DropoutEntryPage />
    else if (page === 'case-acceptance-entry') page_node = <CaseAcceptanceEntryPage />
    else if (page === 'drafts')                page_node = <DraftsPage />
    else                                       page_node = <ClinicianHomePage />
  } else {
    // FRONT_DESK, FRONT_DESK_GLOBAL — card home + entry pages + drafts.
    if      (page === 'case-acceptance-entry') page_node = <CaseAcceptanceEntryPage />
    else if (page === 'drafts')                page_node = <DraftsPage />
    else if (page === 'dropout-entry')         page_node = <DropoutEntryPage />
    else if (page === 'ad-leads-entry' && isAdLeadsEncoder(user.email)) page_node = <AdLeadsEntryPage />
    else                                       page_node = <ClinicianHomePage />
  }

  return <>{page_node}<PendingApprovalsModal /><ToastContainer /><ConfirmDialog /><PromptDialog /><DuplicateDialog /></>
}
