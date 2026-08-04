import React, { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { useAuthStore } from '../../store/auth.store'
import { useNavStore, AppPage } from '../../store/nav.store'
import { usePendingApprovalsStore } from '../../store/pendingApprovals.store'
import { Role, ROLE_LABEL, CLINIC_LABEL, ClinicId, isAdLeadsEncoder } from '../../types'
import { useMediaBelow } from '../../hooks/useMediaBelow'

const TEAL    = '#0f6e56'
const HEADER  = '#1e2547'
const DANGER  = '#b91c1c'

/** Red count bubbles on nav items, keyed by the page they point at. */
type NavBadges = Partial<Record<AppPage, number>>

interface NavLeaf {
  page:  AppPage
  label: string
}
type NavItem =
  | { kind: 'link';  page: AppPage; label: string }
  | { kind: 'group'; label: string; items: NavLeaf[] }

const NAV_TREE: Record<Role, NavItem[]> = {
  ADMIN: [
    { kind: 'group', label: 'CEO', items: [
      { page: 'dashboard',            label: 'CEO Dashboard' },
      { page: 'admin-ceo-analytics',  label: 'CEO Analytics' },
    ]},
    { kind: 'group', label: 'Dropouts', items: [
      { page: 'admin-dropouts',           label: 'Patient Dropouts' },
      { page: 'admin-dropout-analytics',  label: 'Dropout Analytics' },
      { page: 'dropout-entry',            label: 'Manage entries'    },
    ]},
    { kind: 'group', label: 'Case Acceptance', items: [
      { page: 'admin-case-acceptance', label: 'Reports'          },
      { page: 'case-acceptance-entry', label: 'Manage entries'   },
    ]},
    { kind: 'group', label: 'Ad Leads', items: [
      { page: 'admin-ad-leads',        label: 'Meta/Google Leads' },
    ]},
    { kind: 'group', label: 'Admin', items: [
      { page: 'admin-users',           label: 'User Management'  },
      { page: 'admin-delete-requests', label: 'Delete Requests'  },
      { page: 'admin-edit-requests',  label: 'Edit Requests'    },
      { page: 'admin-activity-log',    label: 'Activity Log'     },
      { page: 'ad-spend-entry',        label: 'Ad Spend'         },
    ]},
  ],
  CLINICIAN: [],  // clinician nav is handled by ClinicianHomePage landing screen
  FRONT_DESK: [
    { kind: 'link', page: 'dropout-entry',         label: 'Patient Dropouts' },
    { kind: 'link', page: 'case-acceptance-entry', label: 'Case Acceptance'  },
    { kind: 'link', page: 'ad-leads-entry',        label: 'Meta/Google Leads' },
    { kind: 'link', page: 'drafts',                label: 'My Drafts'        },
  ],
  FRONT_DESK_GLOBAL: [
    { kind: 'link', page: 'dropout-entry',         label: 'Patient Dropouts' },
    { kind: 'link', page: 'case-acceptance-entry', label: 'Case Acceptance'  },
    { kind: 'link', page: 'ad-leads-entry',        label: 'Meta/Google Leads' },
    { kind: 'link', page: 'drafts',                label: 'My Drafts'        },
  ],
  ADSPEND: [
    { kind: 'link', page: 'ad-spend-entry',        label: 'Ad Spend' },
  ],
}

interface Props {
  children: React.ReactNode
  /** If true, the shell renders the page header bar; otherwise the page handles
   *  its own header (DashboardPage already does this). */
  withHeader?: boolean
  /** Hide the top navigation links (used on the card-style choice hubs — the
   *  cards ARE the navigation there, so the menu would just be clutter). */
  hideNav?:   boolean
  title?:     string
}

export default function AppShell({ children, withHeader = true, hideNav = false, title }: Props) {
  const { user, logout, accessToken } = useAuthStore()
  const { page, navigate } = useNavStore()
  const { editCount, deleteCount } = usePendingApprovalsStore()

  // Single open-group state — opening one group auto-closes any other.
  const [openGroup, setOpenGroup]         = useState<string | null>(null)
  const [showChangePwd, setShowChangePwd] = useState(false)

  // Below 900px the inline nav + user block can't fit — collapse to a burger.
  const isMobile = useMediaBelow(900)
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => { if (!isMobile) setMenuOpen(false) }, [isMobile])

  if (!user) return <>{children}</>

  // Ad Leads (Meta/Google Leads) is restricted to specific front-desk logins
  // (see AD_LEADS_ENCODER_EMAILS). Every other front-desk account never sees the
  // encode link. ADMIN's "Meta/Google Leads" is a separate admin page, unaffected.
  const canSeeAdLeads = isAdLeadsEncoder(user.email)
  const items = hideNav ? [] : (NAV_TREE[user.role] ?? []).filter((it) =>
    !(it.kind === 'link' && it.page === 'ad-leads-entry' && !canSeeAdLeads)
  )
  const go = (p: AppPage) => { setOpenGroup(null); setMenuOpen(false); navigate(p) }

  // Pending approvals only concern the super admin. Two signals, both persistent
  // (a toast was too easy to miss): red badges on the Admin menu, and a red bar
  // under the header on every page except the queues themselves.
  const isAdmin = user.role === 'ADMIN'
  const badges: NavBadges = isAdmin
    ? { 'admin-edit-requests': editCount, 'admin-delete-requests': deleteCount }
    : {}
  const pendingTotal = isAdmin ? editCount + deleteCount : 0
  const onQueuePage  = page === 'admin-edit-requests' || page === 'admin-delete-requests'
  const showPendingBar = pendingTotal > 0 && !onQueuePage

  // Roles with a card-style landing page get a "← Home" button when away from it.
  const homePage: AppPage | null =
    user.role === 'CLINICIAN' ? 'clinician-home'
    : (user.role === 'FRONT_DESK' || user.role === 'FRONT_DESK_GLOBAL') ? 'frontdesk-home'
    : user.role === 'ADMIN' ? 'admin-home'
    : null
  const showHome = homePage !== null && page !== homePage

  return (
    <div style={{ minHeight: '100vh', background: '#f0f2f5', fontFamily: "'DM Sans', sans-serif" }}>
      <style>{`
        @keyframes pwBadgePulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(220,38,38,0.55) }
          50%      { box-shadow: 0 0 0 5px rgba(220,38,38,0) }
        }
      `}</style>
      <header
        className="no-print"
        style={{
          background: HEADER, color: '#fff',
          padding: isMobile ? '12px 16px' : '14px 28px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          position: 'relative',
          zIndex: 30,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 28, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 32, height: 32, background: TEAL, borderRadius: 8,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 700, fontSize: 12, letterSpacing: 1, flexShrink: 0,
            }}>PW</div>
            <div style={{ fontWeight: 700, fontSize: 16, whiteSpace: 'nowrap' }}>PhysioWard</div>
          </div>

          {!isMobile && (
          <nav style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {items.map((item) => item.kind === 'link' ? (
              <NavLink
                key={item.page}
                page={item.page}
                label={item.label}
                active={page === item.page}
                onClick={() => go(item.page)}
              />
            ) : (
              <NavGroup
                key={item.label}
                label={item.label}
                items={item.items}
                badges={badges}
                currentPage={page}
                isOpen={openGroup === item.label}
                onToggle={() => setOpenGroup(openGroup === item.label ? null : item.label)}
                onClose={() => setOpenGroup(null)}
                onNavigate={go}
              />
            ))}
            {showHome && (
              <button
                onClick={() => navigate(homePage!)}
                style={{
                  background: 'transparent',
                  color: '#fff',
                  border: '1px solid rgba(255,255,255,0.20)',
                  borderRadius: 6,
                  padding: '7px 14px',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  fontFamily: "'DM Sans', sans-serif",
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}
              >
                ← Home
              </button>
            )}
          </nav>
          )}
        </div>

        {isMobile ? (
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setMenuOpen(o => !o)}
              aria-label={pendingTotal > 0 ? `Menu — ${pendingTotal} pending approvals` : 'Menu'}
              aria-expanded={menuOpen}
              style={{
                background: menuOpen ? 'rgba(255,255,255,0.12)' : 'transparent',
                border: '1px solid rgba(255,255,255,0.25)',
                color: '#fff', borderRadius: 8, padding: '8px 12px',
                fontSize: 18, lineHeight: 1, cursor: 'pointer',
              }}
            >{menuOpen ? '✕' : '☰'}</button>
            {pendingTotal > 0 && !menuOpen && (
              <span style={{
                position: 'absolute', top: -5, right: -5,
                minWidth: 18, height: 18, padding: '0 5px',
                borderRadius: 9, background: '#dc2626', color: '#fff',
                fontSize: 11, fontWeight: 800, lineHeight: '18px', textAlign: 'center',
                animation: 'pwBadgePulse 1.8s ease-in-out infinite',
              }}>{pendingTotal}</span>
            )}
          </div>
        ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ textAlign: 'right', lineHeight: 1.2 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {user.full_name || user.email}
            </div>
            <div style={{ fontSize: 11, opacity: 0.6 }}>
              {ROLE_LABEL[user.role]}
              {user.clinic_id ? ` · ${CLINIC_LABEL[user.clinic_id as ClinicId]}` : ''}
            </div>
          </div>
          <button
            onClick={() => setShowChangePwd(true)}
            style={{
              background: 'transparent', border: '1px solid rgba(255,255,255,0.2)',
              color: '#fff', borderRadius: 6, padding: '6px 12px',
              fontSize: 12, fontWeight: 500, cursor: 'pointer',
              fontFamily: "'DM Sans', sans-serif",
            }}
          >
            Change password
          </button>
          <button
            onClick={logout}
            style={{
              background: 'transparent', border: '1px solid rgba(255,255,255,0.2)',
              color: '#fff', borderRadius: 6, padding: '6px 12px',
              fontSize: 12, fontWeight: 500, cursor: 'pointer',
              fontFamily: "'DM Sans', sans-serif",
            }}
          >
            Sign out
          </button>
        </div>
        )}
      </header>

      {isMobile && menuOpen && (
        <MobileMenu
          items={items}
          badges={badges}
          currentPage={page}
          userLine1={user.full_name || user.email}
          userLine2={`${ROLE_LABEL[user.role]}${user.clinic_id ? ` · ${CLINIC_LABEL[user.clinic_id as ClinicId]}` : ''}`}
          showHome={showHome}
          onNavigate={go}
          onHome={() => { setMenuOpen(false); navigate(homePage!) }}
          onChangePwd={() => { setMenuOpen(false); setShowChangePwd(true) }}
          onLogout={logout}
        />
      )}

      {showPendingBar && (
        <PendingApprovalsBar
          editCount={editCount}
          deleteCount={deleteCount}
          isMobile={isMobile}
          onReview={(p) => go(p)}
        />
      )}

      {showChangePwd && (
        <ChangePasswordModal
          accessToken={accessToken!}
          onClose={() => setShowChangePwd(false)}
          onSuccess={logout}
        />
      )}

      {withHeader && title && (
        <div className="pw-page" style={{ padding: '20px 28px 0' }}>
          <h1 style={{
            margin: 0, fontSize: 22, fontWeight: 700, color: '#111827',
            letterSpacing: '-0.01em',
          }}>{title}</h1>
        </div>
      )}

      <main>{children}</main>
    </div>
  )
}

// ── Pending approvals bar ──────────────────────────────────────────────

/**
 * Always-on red strip under the header while edit/delete requests sit unreviewed.
 * Unlike the login pop-up this cannot be dismissed — it disappears only when the
 * queues are empty, so a request can never be silently forgotten.
 */
function PendingApprovalsBar({
  editCount, deleteCount, isMobile, onReview,
}: {
  editCount:   number
  deleteCount: number
  isMobile:    boolean
  onReview:    (p: AppPage) => void
}) {
  const total = editCount + deleteCount
  const parts: string[] = []
  if (editCount   > 0) parts.push(`${editCount} edit request${editCount === 1 ? '' : 's'}`)
  if (deleteCount > 0) parts.push(`${deleteCount} delete request${deleteCount === 1 ? '' : 's'}`)

  const btn: React.CSSProperties = {
    background: '#fff', color: DANGER,
    border: 'none', borderRadius: 6,
    padding: '6px 13px', fontSize: 12.5, fontWeight: 700,
    cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
    whiteSpace: 'nowrap',
  }

  return (
    <div
      className="no-print"
      role="status"
      style={{
        background: DANGER, color: '#fff',
        padding: isMobile ? '10px 16px' : '10px 28px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, flexWrap: 'wrap',
        boxShadow: '0 2px 6px rgba(185,28,28,0.25)',
        position: 'relative', zIndex: 28,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span style={{
          flexShrink: 0,
          width: 22, height: 22, borderRadius: '50%',
          background: 'rgba(255,255,255,0.22)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 800,
        }}>!</span>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>
          {parts.join(' and ')} waiting for your approval
          {total > 0 ? ' — staff can’t proceed until you decide.' : ''}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        {editCount > 0 && (
          <button style={btn} onClick={() => onReview('admin-edit-requests')}>
            Review edits →
          </button>
        )}
        {deleteCount > 0 && (
          <button style={btn} onClick={() => onReview('admin-delete-requests')}>
            Review deletions →
          </button>
        )}
      </div>
    </div>
  )
}

/** Small red count bubble used on nav items. */
function CountBadge({ n, pulse = false }: { n: number; pulse?: boolean }) {
  if (!n) return null
  return (
    <span style={{
      display: 'inline-block',
      minWidth: 18, padding: '0 5px',
      borderRadius: 9, background: '#dc2626', color: '#fff',
      fontSize: 11, fontWeight: 800, lineHeight: '18px', textAlign: 'center',
      animation: pulse ? 'pwBadgePulse 1.8s ease-in-out infinite' : undefined,
    }}>{n}</span>
  )
}

// ── Change Password Modal ───────────────────────────────────────────────

interface ChangePwdProps {
  accessToken: string
  onClose:     () => void
  onSuccess:   () => void
}

function ChangePasswordModal({ accessToken, onClose, onSuccess }: ChangePwdProps) {
  const [currentPwd,  setCurrentPwd]  = useState('')
  const [newPwd,      setNewPwd]      = useState('')
  const [confirmPwd,  setConfirmPwd]  = useState('')
  const [error,       setError]       = useState<string | null>(null)
  const [loading,     setLoading]     = useState(false)
  const [done,        setDone]        = useState(false)

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (newPwd.length < 8) {
      setError('New password must be at least 8 characters')
      return
    }
    if (newPwd !== confirmPwd) {
      setError('New passwords do not match')
      return
    }

    setLoading(true)
    try {
      await axios.post(
        '/api/auth/change-password',
        { current_password: currentPwd, new_password: newPwd },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
      setDone(true)
      // Sign out after 2 s so the user sees the success message.
      setTimeout(onSuccess, 2000)
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })
          ?.response?.data?.error ?? 'Something went wrong. Try again.'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '9px 12px', fontSize: 14,
    border: '1px solid #d1d5db', borderRadius: 7,
    fontFamily: "'DM Sans', sans-serif",
    outline: 'none', boxSizing: 'border-box',
  }
  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 5,
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: '#fff', borderRadius: 14, padding: '32px 32px 28px',
        width: '100%', maxWidth: 380, boxShadow: '0 20px 50px rgba(15,23,42,0.18)',
        fontFamily: "'DM Sans', sans-serif",
      }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700, color: '#111827' }}>
          Change password
        </h2>
        <p style={{ margin: '0 0 22px', fontSize: 13, color: '#6b7280' }}>
          You will be signed out on all devices after changing your password.
        </p>

        {done ? (
          <div style={{
            background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8,
            padding: '14px 16px', color: '#15803d', fontSize: 14, fontWeight: 500,
          }}>
            ✓ Password changed successfully. Signing you out…
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Current password</label>
              <input
                type="password"
                value={currentPwd}
                onChange={e => setCurrentPwd(e.target.value)}
                required
                autoFocus
                style={inputStyle}
              />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>New password <span style={{ color: '#9ca3af', fontWeight: 400 }}>(min 8 characters)</span></label>
              <input
                type="password"
                value={newPwd}
                onChange={e => setNewPwd(e.target.value)}
                required
                minLength={8}
                style={inputStyle}
              />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Confirm new password</label>
              <input
                type="password"
                value={confirmPwd}
                onChange={e => setConfirmPwd(e.target.value)}
                required
                style={inputStyle}
              />
            </div>

            {error && (
              <div style={{
                background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7,
                padding: '10px 13px', color: '#b91c1c', fontSize: 13, marginBottom: 16,
              }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={onClose}
                disabled={loading}
                style={{
                  background: 'transparent', border: '1px solid #d1d5db',
                  color: '#374151', borderRadius: 7, padding: '8px 18px',
                  fontSize: 13, fontWeight: 500, cursor: 'pointer',
                  fontFamily: "'DM Sans', sans-serif",
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                style={{
                  background: loading ? '#6b7280' : TEAL,
                  border: 'none', color: '#fff', borderRadius: 7,
                  padding: '8px 22px', fontSize: 13, fontWeight: 600,
                  cursor: loading ? 'not-allowed' : 'pointer',
                  fontFamily: "'DM Sans', sans-serif",
                }}
              >
                {loading ? 'Saving…' : 'Change password'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

// ── Mobile menu ────────────────────────────────────────────────────────

function MobileMenu({
  items, badges, currentPage, userLine1, userLine2, showHome,
  onNavigate, onHome, onChangePwd, onLogout,
}: {
  items:       NavItem[]
  badges:      NavBadges
  currentPage: AppPage
  userLine1:   string
  userLine2:   string
  showHome:    boolean
  onNavigate:  (p: AppPage) => void
  onHome:      () => void
  onChangePwd: () => void
  onLogout:    () => void
}) {
  const itemBtn = (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 8,
    width: '100%', textAlign: 'left',
    background: active ? '#f0faf7' : 'transparent',
    color: active ? TEAL : '#111827',
    border: 'none', borderRadius: 8,
    padding: '12px 14px',           // generous tap target
    fontSize: 15, fontWeight: active ? 600 : 500,
    cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
  })
  return (
    <div
      className="no-print"
      style={{
        background: '#fff', borderBottom: '1px solid #e5e7eb',
        boxShadow: '0 12px 24px rgba(15,23,42,0.12)',
        padding: '8px 10px 12px',
        position: 'relative', zIndex: 29,
      }}
    >
      {showHome && (
        <button onClick={onHome} style={itemBtn(false)}>← Home</button>
      )}
      {items.map((item) => item.kind === 'link' ? (
        <button key={item.page} onClick={() => onNavigate(item.page)} style={itemBtn(currentPage === item.page)}>
          {item.label}
          <CountBadge n={badges[item.page] ?? 0} />
        </button>
      ) : (
        <div key={item.label}>
          <div style={{
            padding: '12px 14px 4px', fontSize: 11, fontWeight: 700,
            color: '#9ca3af', letterSpacing: '0.08em', textTransform: 'uppercase',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            {item.label}
            <CountBadge n={item.items.reduce((s, l) => s + (badges[l.page] ?? 0), 0)} pulse />
          </div>
          {item.items.map((leaf) => (
            <button key={leaf.page} onClick={() => onNavigate(leaf.page)} style={itemBtn(currentPage === leaf.page)}>
              {leaf.label}
              <CountBadge n={badges[leaf.page] ?? 0} />
            </button>
          ))}
        </div>
      ))}
      <div style={{ borderTop: '1px solid #eef0f3', margin: '10px 4px', paddingTop: 10 }}>
        <div style={{ padding: '0 14px 10px' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{userLine1}</div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>{userLine2}</div>
        </div>
        <button onClick={onChangePwd} style={itemBtn(false)}>Change password</button>
        <button onClick={onLogout} style={{ ...itemBtn(false), color: '#b91c1c' }}>Sign out</button>
      </div>
    </div>
  )
}

// ── Nav primitives ─────────────────────────────────────────────────────

function NavLink({
  label, active, onClick,
}: { page: AppPage; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background:  active ? 'rgba(255,255,255,0.12)' : 'transparent',
        color:       '#fff',
        border:      '1px solid ' + (active ? 'rgba(255,255,255,0.20)' : 'transparent'),
        borderRadius: 6,
        padding:     '7px 14px',
        fontSize:    13,
        fontWeight:  active ? 600 : 500,
        cursor:      'pointer',
        fontFamily:  "'DM Sans', sans-serif",
        transition:  'background 0.15s, border-color 0.15s',
      }}
    >{label}</button>
  )
}

function NavGroup({
  label, items, badges, currentPage, isOpen, onToggle, onClose, onNavigate,
}: {
  label:       string
  items:       NavLeaf[]
  badges:      NavBadges
  currentPage: AppPage
  isOpen:      boolean
  onToggle:    () => void
  onClose:     () => void
  onNavigate:  (p: AppPage) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)

  // Outside click + Escape close the dropdown.
  useEffect(() => {
    if (!isOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [isOpen, onClose])

  const childActive = items.some((i) => i.page === currentPage)
  const triggerActive = childActive || isOpen
  const groupBadge = items.reduce((s, i) => s + (badges[i.page] ?? 0), 0)

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        onClick={onToggle}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        style={{
          background:  triggerActive ? 'rgba(255,255,255,0.12)' : 'transparent',
          color:       '#fff',
          border:      '1px solid ' + (triggerActive ? 'rgba(255,255,255,0.20)' : 'transparent'),
          borderRadius: 6,
          padding:     '7px 12px 7px 14px',
          fontSize:    13,
          fontWeight:  childActive ? 600 : 500,
          cursor:      'pointer',
          fontFamily:  "'DM Sans', sans-serif",
          display:     'inline-flex',
          alignItems:  'center',
          gap:         6,
          transition:  'background 0.15s, border-color 0.15s',
        }}
      >
        {label}
        <CountBadge n={groupBadge} pulse />
        <span style={{
          fontSize: 9,
          opacity:  0.65,
          transition: 'transform 0.18s',
          transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
          display: 'inline-block',
        }}>▾</span>
      </button>

      {isOpen && (
        <div
          role="menu"
          style={{
            position:    'absolute',
            top:         'calc(100% + 8px)',
            left:        0,
            minWidth:    200,
            background:  '#fff',
            border:      '1px solid #eef0f3',
            borderRadius: 10,
            padding:     6,
            boxShadow:   '0 8px 24px rgba(15, 23, 42, 0.14), 0 2px 6px rgba(15, 23, 42, 0.08)',
            zIndex:      40,
            animation:   'navDropFade 0.16s ease',
          }}
        >
          <style>{`
            @keyframes navDropFade {
              from { opacity: 0; transform: translateY(-4px) }
              to   { opacity: 1; transform: translateY(0) }
            }
            .nav-drop-item:hover {
              background: #f0faf7 !important;
              color: ${TEAL} !important;
            }
          `}</style>
          {items.map((leaf) => {
            const active = leaf.page === currentPage
            return (
              <button
                key={leaf.page}
                role="menuitem"
                onClick={() => onNavigate(leaf.page)}
                className="nav-drop-item"
                style={{
                  display:      'flex',
                  alignItems:   'center',
                  gap:          8,
                  width:        '100%',
                  textAlign:    'left',
                  background:   active ? '#f0faf7' : 'transparent',
                  color:        active ? TEAL : '#111827',
                  border:       'none',
                  borderRadius: 7,
                  padding:      '8px 12px',
                  fontSize:     13,
                  fontWeight:   active ? 600 : 500,
                  cursor:       'pointer',
                  fontFamily:   "'DM Sans', sans-serif",
                  transition:   'background 0.12s, color 0.12s',
                }}
              >
                {leaf.label}
                <CountBadge n={badges[leaf.page] ?? 0} />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
