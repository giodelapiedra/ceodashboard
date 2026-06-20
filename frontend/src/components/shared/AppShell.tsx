import React, { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { useAuthStore } from '../../store/auth.store'
import { useNavStore, AppPage } from '../../store/nav.store'
import { Role, ROLE_LABEL, CLINIC_LABEL, ClinicId } from '../../types'

const TEAL    = '#0f6e56'
const HEADER  = '#1e2547'

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
    { kind: 'group', label: 'Admin', items: [
      { page: 'admin-users',         label: 'User Management' },
      { page: 'admin-activity-log',  label: 'Activity Log'    },
      { page: 'ad-spend-entry',      label: 'Ad Spend'        },
    ]},
  ],
  CLINICIAN: [
    { kind: 'link', page: 'dropout-entry',         label: 'Patient Dropouts' },
    { kind: 'link', page: 'case-acceptance-entry', label: 'Case Acceptance'  },
    { kind: 'link', page: 'drafts',                label: 'My Drafts'        },
  ],
  FRONT_DESK: [
    { kind: 'link', page: 'dropout-entry',         label: 'Patient Dropouts' },
    { kind: 'link', page: 'case-acceptance-entry', label: 'Case Acceptance'  },
    { kind: 'link', page: 'drafts',                label: 'My Drafts'        },
  ],
  FRONT_DESK_GLOBAL: [
    { kind: 'link', page: 'dropout-entry',         label: 'Patient Dropouts' },
    { kind: 'link', page: 'case-acceptance-entry', label: 'Case Acceptance'  },
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
  title?:     string
}

export default function AppShell({ children, withHeader = true, title }: Props) {
  const { user, logout, accessToken } = useAuthStore()
  const { page, navigate } = useNavStore()

  // Single open-group state — opening one group auto-closes any other.
  const [openGroup, setOpenGroup]         = useState<string | null>(null)
  const [showChangePwd, setShowChangePwd] = useState(false)

  if (!user) return <>{children}</>

  const items = NAV_TREE[user.role] ?? []

  return (
    <div style={{ minHeight: '100vh', background: '#f0f2f5', fontFamily: "'DM Sans', sans-serif" }}>
      <header
        className="no-print"
        style={{
          background: HEADER, color: '#fff',
          padding: '14px 28px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          position: 'relative',
          zIndex: 30,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 32, height: 32, background: TEAL, borderRadius: 8,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 700, fontSize: 12, letterSpacing: 1,
            }}>PW</div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>PhysioWard</div>
          </div>

          <nav style={{ display: 'flex', gap: 4 }}>
            {items.map((item) => item.kind === 'link' ? (
              <NavLink
                key={item.page}
                page={item.page}
                label={item.label}
                active={page === item.page}
                onClick={() => { setOpenGroup(null); navigate(item.page) }}
              />
            ) : (
              <NavGroup
                key={item.label}
                label={item.label}
                items={item.items}
                currentPage={page}
                isOpen={openGroup === item.label}
                onToggle={() => setOpenGroup(openGroup === item.label ? null : item.label)}
                onClose={() => setOpenGroup(null)}
                onNavigate={(p) => { setOpenGroup(null); navigate(p) }}
              />
            ))}
          </nav>
        </div>

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
      </header>

      {showChangePwd && (
        <ChangePasswordModal
          accessToken={accessToken!}
          onClose={() => setShowChangePwd(false)}
          onSuccess={logout}
        />
      )}

      {withHeader && title && (
        <div style={{ padding: '20px 28px 0' }}>
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
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: '#fff', borderRadius: 14, padding: '32px 32px 28px',
        width: 380, boxShadow: '0 20px 50px rgba(15,23,42,0.18)',
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
  label, items, currentPage, isOpen, onToggle, onClose, onNavigate,
}: {
  label:       string
  items:       NavLeaf[]
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
                  display:      'block',
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
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
