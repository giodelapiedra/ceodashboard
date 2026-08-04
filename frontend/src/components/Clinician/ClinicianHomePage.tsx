import React from 'react'
import logoSrc from '../../assets/physioward-logo.png'
import { useNavStore } from '../../store/nav.store'
import { useAuthStore } from '../../store/auth.store'
import { usePendingApprovalsStore } from '../../store/pendingApprovals.store'
import { CLINIC_LABEL, ClinicId, isAdLeadsEncoder } from '../../types'
import AppShell from '../shared/AppShell'

const TEAL   = '#0f6e56'
const HEADER = '#1e2547'
const SLATE  = '#475569'
const DANGER = '#b91c1c'

export default function ClinicianHomePage() {
  const { navigate } = useNavStore()
  const { user } = useAuthStore()
  const { editCount, deleteCount } = usePendingApprovalsStore()

  // Super admin gets the same choice screen but with a third card that jumps
  // into the CEO dashboard + admin tools (still reachable from the top menu too).
  const isAdmin = user?.role === 'ADMIN'

  // Ad Leads (Meta/Google Leads) is restricted to specific front-desk logins
  // (see AD_LEADS_ENCODER_EMAILS). The super admin gets a separate view-only card.
  const canEncodeAdLeads = isAdLeadsEncoder(user?.email)

  const clinicLabel = user?.clinic_id ? CLINIC_LABEL[user.clinic_id as ClinicId] : ''

  return (
    <AppShell withHeader={false} hideNav>
      <div style={{
        minHeight: 'calc(100vh - 62px)',
        background: '#f0f2f5',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 20px',
        fontFamily: "'DM Sans', sans-serif",
      }}>
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <img
            src={logoSrc}
            alt="PhysioWard"
            style={{ height: 64, width: 'auto', marginBottom: 18, display: 'block', margin: '0 auto 18px' }}
          />
          <h1 style={{
            margin: '0 0 8px',
            fontSize: 26, fontWeight: 800, color: '#111827', letterSpacing: '-0.02em',
          }}>
            Welcome back{user?.full_name ? `, ${user.full_name.split(' ')[0]}` : ''}
          </h1>
          {clinicLabel && (
            <p style={{ margin: 0, fontSize: 14, color: '#6b7280' }}>
              {clinicLabel} clinic
            </p>
          )}
        </div>

        <p style={{
          margin: '0 0 32px',
          fontSize: 15, color: '#4b5563', fontWeight: 500,
        }}>
          {isAdmin ? 'What would you like to do today?' : 'What would you like to record today?'}
        </p>

        <div style={{
          display: 'flex',
          gap: 20,
          flexWrap: 'wrap',
          justifyContent: 'center',
          maxWidth: isAdmin ? 960 : 640,
          width: '100%',
        }}>
          {/* Approval queues jump to the front of the hub — the admin lands here
              on login, so a pending request is the first thing in their eyeline. */}
          {isAdmin && editCount > 0 && (
            <ChoiceCard
              icon={<EditRequestIcon />}
              title="Edit Requests"
              description="Staff want to change existing entries. Approve to apply, reject to keep as-is."
              color={DANGER}
              urgent
              badge={editCount}
              onClick={() => navigate('admin-edit-requests')}
            />
          )}
          {isAdmin && deleteCount > 0 && (
            <ChoiceCard
              icon={<DeleteRequestIcon />}
              title="Delete Requests"
              description="Staff want entries removed. Approve to delete, reject to keep them."
              color={DANGER}
              urgent
              badge={deleteCount}
              onClick={() => navigate('admin-delete-requests')}
            />
          )}
          <ChoiceCard
            icon={<DropoutsIcon />}
            title="Patient Dropouts"
            description="Record patients who stopped treatment or did not continue care."
            color={TEAL}
            onClick={() => navigate('dropout-entry')}
          />
          <ChoiceCard
            icon={<CaseAcceptanceIcon />}
            title="Case Acceptance"
            description="Log case presentations, recommendations, and appointment bookings."
            color={HEADER}
            onClick={() => navigate('case-acceptance-entry')}
          />
          {canEncodeAdLeads && (
            <ChoiceCard
              icon={<LeadsIcon />}
              title="Meta/Google ADS Leads"
              description="Log new ad leads from Facebook & Google campaigns and track bookings."
              color={TEAL}
              onClick={() => navigate('ad-leads-entry')}
            />
          )}
          {isAdmin && (
            <ChoiceCard
              icon={<LeadsIcon />}
              title="Meta/Google ADS Leads"
              description="View all encoded ad-campaign leads (read-only)."
              color={HEADER}
              onClick={() => navigate('admin-ad-leads')}
            />
          )}
          {isAdmin && (
            <ChoiceCard
              icon={<DashboardIcon />}
              title="CEO Dashboard & Admin"
              description="View analytics, manage users, and review edit / delete requests."
              color={SLATE}
              onClick={() => navigate('dashboard')}
            />
          )}
        </div>

        <button
          onClick={() => navigate('drafts')}
          style={{
            marginTop: 32,
            background: 'transparent',
            border: '1px solid #d1d5db',
            color: '#6b7280',
            borderRadius: 8,
            padding: '9px 20px',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
            fontFamily: "'DM Sans', sans-serif",
            display: 'flex', alignItems: 'center', gap: 6,
            transition: 'border-color 0.15s, color 0.15s',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.borderColor = TEAL
            ;(e.currentTarget as HTMLButtonElement).style.color = TEAL
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.borderColor = '#d1d5db'
            ;(e.currentTarget as HTMLButtonElement).style.color = '#6b7280'
          }}
        >
          <DraftsIcon />
          My Drafts
        </button>
      </div>
    </AppShell>
  )
}

// ── Choice Card ─────────────────────────────────────────────────────────────

function ChoiceCard({
  icon, title, description, color, onClick, urgent = false, badge,
}: {
  icon:        React.ReactNode
  title:       string
  description: string
  color:       string
  onClick:     () => void
  /** Keeps the coloured border + tinted background on at all times (approval queues). */
  urgent?:     boolean
  /** Red count bubble in the top-right corner. */
  badge?:      number
}) {
  const [hovered, setHovered] = React.useState(false)

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        width: 280,
        background: urgent ? '#fffafa' : '#fff',
        border: `2px solid ${hovered || urgent ? color : '#e5e7eb'}`,
        borderRadius: 16,
        padding: '28px 24px',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: "'DM Sans', sans-serif",
        boxShadow: hovered
          ? `0 8px 28px rgba(15,23,42,0.12)`
          : urgent ? '0 4px 18px rgba(185,28,28,0.16)' : '0 2px 8px rgba(15,23,42,0.06)',
        transform: hovered ? 'translateY(-3px)' : 'translateY(0)',
        transition: 'border-color 0.18s, box-shadow 0.18s, transform 0.18s',
      }}
    >
      {badge ? (
        <span style={{
          position: 'absolute', top: 14, right: 14,
          minWidth: 26, height: 26, padding: '0 8px',
          borderRadius: 13, background: '#dc2626', color: '#fff',
          fontSize: 13, fontWeight: 800, lineHeight: '26px', textAlign: 'center',
          animation: 'pwCardBadgePulse 1.8s ease-in-out infinite',
        }}>{badge}</span>
      ) : null}
      <style>{`
        @keyframes pwCardBadgePulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(220,38,38,0.5) }
          50%      { box-shadow: 0 0 0 8px rgba(220,38,38,0) }
        }
      `}</style>
      <div style={{
        width: 44, height: 44,
        background: hovered || urgent ? color : `${color}18`,
        borderRadius: 11,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 16,
        transition: 'background 0.18s',
        color: hovered || urgent ? '#fff' : color,
      }}>
        {icon}
      </div>
      <div style={{
        fontSize: 17, fontWeight: 700, color: '#111827', marginBottom: 8,
        letterSpacing: '-0.01em',
      }}>
        {title}
      </div>
      <div style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.55 }}>
        {description}
      </div>
      <div style={{
        marginTop: 20,
        fontSize: 13, fontWeight: 600,
        color: color,
        display: 'flex', alignItems: 'center', gap: 4,
      }}>
        {urgent ? 'Review now →' : 'Open →'}
      </div>
    </button>
  )
}

// ── Icons ────────────────────────────────────────────────────────────────────

function DropoutsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="17" y1="8" x2="23" y2="8" />
    </svg>
  )
}

function CaseAcceptanceIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="13" y2="17" />
      <polyline points="9 9 10 9 11 11" />
    </svg>
  )
}

function DashboardIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  )
}

function LeadsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 11l19-9-9 19-2-8-8-2z" />
    </svg>
  )
}

function EditRequestIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  )
}

function DeleteRequestIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  )
}

function DraftsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  )
}
