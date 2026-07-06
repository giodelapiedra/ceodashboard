import React from 'react'
import logoSrc from '../../assets/physioward-logo.png'
import { useNavStore } from '../../store/nav.store'
import { useAuthStore } from '../../store/auth.store'
import { CLINIC_LABEL, ClinicId } from '../../types'
import AppShell from '../shared/AppShell'

const TEAL   = '#0f6e56'
const HEADER = '#1e2547'

export default function ClinicianHomePage() {
  const { navigate } = useNavStore()
  const { user } = useAuthStore()

  const clinicLabel = user?.clinic_id ? CLINIC_LABEL[user.clinic_id as ClinicId] : ''

  return (
    <AppShell withHeader={false}>
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
          What would you like to record today?
        </p>

        <div style={{
          display: 'flex',
          gap: 20,
          flexWrap: 'wrap',
          justifyContent: 'center',
          maxWidth: 640,
          width: '100%',
        }}>
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
  icon, title, description, color, onClick,
}: {
  icon:        React.ReactNode
  title:       string
  description: string
  color:       string
  onClick:     () => void
}) {
  const [hovered, setHovered] = React.useState(false)

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 280,
        background: '#fff',
        border: `2px solid ${hovered ? color : '#e5e7eb'}`,
        borderRadius: 16,
        padding: '28px 24px',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: "'DM Sans', sans-serif",
        boxShadow: hovered
          ? `0 8px 28px rgba(15,23,42,0.12)`
          : '0 2px 8px rgba(15,23,42,0.06)',
        transform: hovered ? 'translateY(-3px)' : 'translateY(0)',
        transition: 'border-color 0.18s, box-shadow 0.18s, transform 0.18s',
      }}
    >
      <div style={{
        width: 44, height: 44,
        background: hovered ? color : `${color}18`,
        borderRadius: 11,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 16,
        transition: 'background 0.18s',
        color: hovered ? '#fff' : color,
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
        Open →
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

function DraftsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  )
}
