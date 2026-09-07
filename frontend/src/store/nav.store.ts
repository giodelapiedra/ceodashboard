import { useNavigate, useLocation } from 'react-router-dom'

export type AppPage =
  | 'dashboard'
  | 'admin-ceo-analytics'
  | 'admin-users'
  | 'admin-dropouts'
  | 'admin-dropout-analytics'
  | 'admin-case-acceptance'
  | 'admin-practitioner-stats'
  | 'admin-ad-leads'
  | 'admin-delete-requests'
  | 'admin-edit-requests'
  | 'admin-activity-log'
  | 'admin-clinician-profile'
  | 'admin-weekly-kpi'
  | 'dropout-entry'
  | 'case-acceptance-entry'
  | 'ad-leads-entry'
  | 'weekly-kpi'
  | 'my-profile'
  | 'drafts'
  | 'ad-spend-entry'
  | 'clinician-home'
  | 'frontdesk-home'
  | 'admin-home'
  | 'adspend-home'

export const PAGE_PATH: Record<AppPage, string> = {
  'dashboard':                 '/',
  'admin-ceo-analytics':       '/ceo-analytics',
  'admin-users':               '/admin/users',
  'admin-dropouts':            '/admin/dropouts',
  'admin-dropout-analytics':   '/admin/dropout-analytics',
  'admin-case-acceptance':     '/admin/case-acceptance',
  'admin-practitioner-stats':  '/admin/practitioner-stats',
  'admin-ad-leads':            '/admin/ad-leads',
  'admin-delete-requests':     '/admin/delete-requests',
  'admin-edit-requests':       '/admin/edit-requests',
  'admin-activity-log':        '/admin/activity-log',
  'admin-clinician-profile':   '/admin/clinician-profile',
  'admin-weekly-kpi':          '/admin/weekly-kpi',
  'dropout-entry':             '/dropout-entry',
  'case-acceptance-entry':     '/case-acceptance-entry',
  'ad-leads-entry':            '/ad-leads-entry',
  'weekly-kpi':                '/weekly-kpi',
  'my-profile':                '/my-profile',
  'drafts':                    '/drafts',
  'ad-spend-entry':            '/ad-spend',
  'clinician-home':            '/clinician-home',
  'frontdesk-home':            '/frontdesk-home',
  'admin-home':                '/admin-home',
  'adspend-home':              '/adspend-home',
}

const PATH_PAGE: Record<string, AppPage> = Object.fromEntries(
  Object.entries(PAGE_PATH).map(([page, path]) => [path, page as AppPage])
)

export function useNavStore() {
  const rrNavigate = useNavigate()
  const { pathname } = useLocation()

  const page: AppPage = PATH_PAGE[pathname] ?? 'dashboard'

  return {
    page,
    navigate: (p: AppPage, opts?: { clinicianId?: string }) => {
      const base = PAGE_PATH[p]
      if (opts?.clinicianId) {
        rrNavigate(`${base}?clinician_id=${encodeURIComponent(opts.clinicianId)}`)
      } else {
        rrNavigate(base)
      }
    },
  }
}
