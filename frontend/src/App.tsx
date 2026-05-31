import React, { useEffect } from 'react'
import { useAuthStore } from './store/auth.store'
import { useNavStore } from './store/nav.store'
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
import AdSpendEntryPage from './components/AdSpend/AdSpendEntryPage'
import ToastContainer from './components/shared/ToastContainer'
import ConfirmDialog from './components/shared/ConfirmDialog'
import PromptDialog from './components/shared/PromptDialog'

export default function App() {
  const { isAuthenticated, isLoading, refreshToken, user } = useAuthStore()
  const { page, navigate } = useNavStore()

  // On app load — try to restore session via refresh token cookie
  useEffect(() => { refreshToken() }, [])

  // When user changes role (e.g. just logged in), pick a sensible default page.
  useEffect(() => {
    if (!user) return
    if (user.role === 'ADMIN') {
      if (!['dashboard', 'admin-ceo-analytics', 'admin-users', 'admin-dropouts', 'admin-dropout-analytics', 'admin-case-acceptance', 'admin-activity-log', 'dropout-entry', 'case-acceptance-entry', 'ad-spend-entry'].includes(page)) {
        navigate('dashboard')
      }
    } else if (user.role === 'ADSPEND') {
      // The ad-spend encoder only ever sees the ad-spend entry page.
      if (page !== 'ad-spend-entry') navigate('ad-spend-entry')
    } else {
      if (!['dropout-entry', 'case-acceptance-entry'].includes(page)) {
        navigate('dropout-entry')
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.role])

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
    return <><LoginPage /><ToastContainer /><ConfirmDialog /><PromptDialog /></>
  }

  let page_node: React.ReactNode
  if (user.role === 'ADMIN') {
    if      (page === 'admin-users')              page_node = <UserManagementPage />
    else if (page === 'admin-dropouts')           page_node = <DropoutAdminPage />
    else if (page === 'admin-dropout-analytics')  page_node = <DropoutAnalyticsPage />
    else if (page === 'admin-ceo-analytics')      page_node = <CEOAnalyticsPage />
    else if (page === 'admin-case-acceptance')    page_node = <CaseAcceptanceAdminPage />
    else if (page === 'admin-activity-log')       page_node = <AuditLogPage />
    // ADMIN also has access to the data-entry pages so they can edit / delete
    // any row. The create form on those pages is hidden for ADMINs (they're
    // blocked from creating in the backend).
    else if (page === 'case-acceptance-entry')    page_node = <CaseAcceptanceEntryPage />
    else if (page === 'dropout-entry')            page_node = <DropoutEntryPage />
    else if (page === 'ad-spend-entry')           page_node = <AdSpendEntryPage />
    else                                          page_node = <DashboardPage />
  } else if (user.role === 'ADSPEND') {
    // Hard lock: the ad-spend encoder can ONLY ever render this one page,
    // regardless of nav state. No dashboard, dropouts, or case acceptance.
    page_node = <AdSpendEntryPage />
  } else {
    // CLINICIAN, FRONT_DESK, FRONT_DESK_GLOBAL — same two pages.
    if (page === 'case-acceptance-entry') page_node = <CaseAcceptanceEntryPage />
    else                                  page_node = <DropoutEntryPage />
  }

  return <>{page_node}<ToastContainer /><ConfirmDialog /><PromptDialog /></>
}
