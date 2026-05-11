import React, { useEffect, useRef, useState } from 'react'
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
    ]},
  ],
  CLINICIAN: [
    { kind: 'link', page: 'dropout-entry',         label: 'Patient Dropouts' },
    { kind: 'link', page: 'case-acceptance-entry', label: 'Case Acceptance'  },
  ],
  FRONT_DESK: [
    { kind: 'link', page: 'dropout-entry',         label: 'Patient Dropouts' },
    { kind: 'link', page: 'case-acceptance-entry', label: 'Case Acceptance'  },
  ],
  FRONT_DESK_GLOBAL: [
    { kind: 'link', page: 'dropout-entry',         label: 'Patient Dropouts' },
    { kind: 'link', page: 'case-acceptance-entry', label: 'Case Acceptance'  },
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
  const { user, logout } = useAuthStore()
  const { page, navigate } = useNavStore()

  // Single open-group state — opening one group auto-closes any other.
  const [openGroup, setOpenGroup] = useState<string | null>(null)

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
