import React, { useEffect, useState, useCallback } from 'react'
import { usersApi, CreateUserPayload } from '../../api/users.api'
import { User, Role, ROLE_LABEL, ClinicId, CLINIC_LABEL, isCrossClinicRole } from '../../types'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/confirm.store'
import { promptDialog } from '../../store/prompt.store'
import AppShell from '../shared/AppShell'
import { useNavStore } from '../../store/nav.store'

const TEAL      = '#0f6e56'
const TEAL_DARK = '#0a5040'
const TEXT      = '#111827'
const TEXT_SOFT = '#4b5563'
const BORDER    = '#e5e7eb'
const DANGER    = '#b91c1c'

const ROLES: Role[] = ['ADMIN', 'CLINICIAN', 'FRONT_DESK', 'FRONT_DESK_GLOBAL', 'ADSPEND']
const CLINICS: ClinicId[] = ['newport', 'narrabeen', 'brookvale']

interface FormState {
  email:     string
  password:  string
  full_name: string
  role:      Role
  clinic_id: ClinicId | null
}

const EMPTY_FORM: FormState = {
  email:     '',
  password:  '',
  full_name: '',
  role:      'CLINICIAN',
  clinic_id: 'newport',
}

export default function UserManagementPage() {
  const { navigate } = useNavStore()
  const [users, setUsers]       = useState<User[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm]         = useState<FormState>(EMPTY_FORM)

  // Filters
  const [filterClinic, setFilterClinic] = useState<ClinicId | ''>('')
  const [filterRole,   setFilterRole]   = useState<Role | ''>('')
  const [showInactive, setShowInactive] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const rows = await usersApi.list({
        clinic_id: filterClinic || undefined,
        role:      filterRole   || undefined,
        active:    showInactive ? undefined : true,
      })
      setUsers(rows)
    } catch (e: any) {
      setError(e.response?.data?.error?.message || 'Failed to load users')
    } finally { setLoading(false) }
  }, [filterClinic, filterRole, showInactive])

  useEffect(() => { load() }, [load])

  const onCreate = async () => {
    setCreating(true); setError('')
    const fullName = form.full_name.trim() || form.email.trim()
    try {
      const payload: CreateUserPayload = {
        email:     form.email.trim(),
        password:  form.password,
        full_name: form.full_name.trim(),
        role:      form.role,
        clinic_id: isCrossClinicRole(form.role) ? null : form.clinic_id,
      }
      await usersApi.create(payload)
      toast.success(`Created ${ROLE_LABEL[payload.role]} account for ${fullName}`)
      setForm(EMPTY_FORM)
      setShowCreate(false)
      await load()
    } catch (e: any) {
      const details = e.response?.data?.error?.details
      const detailsMsg = Array.isArray(details)
        ? details.map((d: any) => `${d.path}: ${d.message}`).join(', ')
        : ''
      const msg = (e.response?.data?.error?.message || 'Failed to create user') + (detailsMsg ? ` — ${detailsMsg}` : '')
      setError(msg)
      toast.error(msg)
    } finally { setCreating(false) }
  }

  const onResetPassword = async (u: User) => {
    const pwd = await promptDialog.ask({
      title:        'Reset password',
      message:      `Set a new password for ${u.full_name || u.email}.\nThey will be signed out of all sessions.`,
      inputType:    'password',
      placeholder:  'At least 8 characters',
      confirmLabel: 'Reset password',
      validate:     (v) => v.length < 8 ? 'Password must be at least 8 characters' : null,
    })
    if (pwd === null) return
    try {
      await usersApi.resetPassword(u.id, pwd)
      toast.success(`Password reset for ${u.full_name || u.email}.`)
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || 'Failed to reset password')
    }
  }

  const onDeactivate = async (u: User) => {
    const ok = await confirmDialog.destructive({
      title:        'Deactivate user?',
      message:      `${u.full_name || u.email} will be signed out of all sessions and unable to log in.\n\nYou can reactivate them later.`,
      confirmLabel: 'Deactivate',
    })
    if (!ok) return
    try {
      await usersApi.deactivate(u.id)
      toast.success(`Deactivated ${u.full_name || u.email}`)
      await load()
    } catch (e: any) { toast.error(e.response?.data?.error?.message || 'Failed to deactivate') }
  }

  const onReactivate = async (u: User) => {
    try {
      await usersApi.reactivate(u.id)
      toast.success(`Reactivated ${u.full_name || u.email}`)
      await load()
    } catch (e: any) { toast.error(e.response?.data?.error?.message || 'Failed to reactivate') }
  }

  return (
    <AppShell title="User Management">
      <div className="pw-page" style={{ padding: '20px 28px' }}>
        {/* Toolbar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
          flexWrap: 'wrap',
        }}>
          <select
            value={filterClinic}
            onChange={(e) => setFilterClinic(e.target.value as ClinicId | '')}
            style={selectStyle}
          >
            <option value="">All clinics</option>
            {CLINICS.map(c => <option key={c} value={c}>{CLINIC_LABEL[c]}</option>)}
          </select>

          <select
            value={filterRole}
            onChange={(e) => setFilterRole(e.target.value as Role | '')}
            style={selectStyle}
          >
            <option value="">All roles</option>
            {ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>

          <label style={{ fontSize: 13, color: TEXT_SOFT, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            Show inactive
          </label>

          <div style={{ flex: 1 }} />

          <button onClick={() => setShowCreate(s => !s)} style={primaryBtnStyle}>
            {showCreate ? 'Cancel' : '+ Add user'}
          </button>
        </div>

        {error && <ErrorBanner message={error} />}

        {showCreate && (
          <CreateForm
            value={form}
            onChange={setForm}
            onSubmit={onCreate}
            submitting={creating}
          />
        )}

        {/* Table */}
        <div style={{
          background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10,
          overflow: 'hidden',
        }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
          ) : users.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No users found.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 760 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <Th>Name</Th>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Clinic</Th>
                  <Th>Status</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                    <Td>
                      {u.role === 'CLINICIAN' ? (
                        <button
                          onClick={() => navigate('admin-clinician-profile', { clinicianId: u.id })}
                          style={{
                            background: 'none', border: 'none', padding: 0,
                            color: TEAL, fontWeight: 600, fontSize: 13,
                            cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                            textDecoration: 'underline', textUnderlineOffset: 3,
                          }}
                        >{u.full_name || <span style={{ color: '#9ca3af' }}>—</span>}</button>
                      ) : (
                        u.full_name || <span style={{ color: '#9ca3af' }}>—</span>
                      )}
                    </Td>
                    <Td><span style={{ color: TEXT_SOFT }}>{u.email}</span></Td>
                    <Td><Pill text={ROLE_LABEL[u.role]} /></Td>
                    <Td>{u.clinic_id ? CLINIC_LABEL[u.clinic_id] : <span style={{ color: '#9ca3af' }}>—</span>}</Td>
                    <Td>
                      {u.is_active
                        ? <span style={{ color: TEAL, fontWeight: 500 }}>Active</span>
                        : <span style={{ color: '#9ca3af' }}>Inactive</span>}
                    </Td>
                    <Td align="right">
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button onClick={() => onResetPassword(u)} style={smallBtnStyle}>Reset PW</button>
                        {u.is_active
                          ? <button onClick={() => onDeactivate(u)} style={{ ...smallBtnStyle, color: DANGER, borderColor: '#fecaca' }}>Deactivate</button>
                          : <button onClick={() => onReactivate(u)} style={smallBtnStyle}>Reactivate</button>}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}

// ── Sub-components ─────────────────────────────────────────────

function CreateForm({
  value, onChange, onSubmit, submitting,
}: {
  value: FormState
  onChange: (v: FormState) => void
  onSubmit: () => void
  submitting: boolean
}) {
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    onChange({ ...value, [k]: v })

  return (
    <div style={{
      background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10,
      padding: 18, marginBottom: 16,
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: TEXT, marginBottom: 12 }}>
        New user
      </div>
      <div className="pw-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
        <Field label="Full name">
          <input value={value.full_name} onChange={e => set('full_name', e.target.value)} style={inputStyle} placeholder="e.g. Caitlin Smith" />
        </Field>
        <Field label="Email">
          <input type="email" value={value.email} onChange={e => set('email', e.target.value)} style={inputStyle} placeholder="caitlin@physioward.com.au" />
        </Field>
        <Field label="Role">
          <select value={value.role} onChange={e => set('role', e.target.value as Role)} style={inputStyle}>
            {ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </Field>
        <Field label="Clinic">
          <select
            value={isCrossClinicRole(value.role) ? '' : (value.clinic_id ?? '')}
            onChange={e => set('clinic_id', (e.target.value || null) as ClinicId | null)}
            disabled={isCrossClinicRole(value.role)}
            style={inputStyle}
          >
            {isCrossClinicRole(value.role)
              ? <option value="">— Cross-clinic account —</option>
              : CLINICS.map(c => <option key={c} value={c}>{CLINIC_LABEL[c]}</option>)}
          </select>
        </Field>
        <Field label="Initial password (min 8)">
          <input type="text" value={value.password} onChange={e => set('password', e.target.value)} style={inputStyle} placeholder="They can change later" />
        </Field>
      </div>
      <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={onSubmit} disabled={submitting} style={primaryBtnStyle}>
          {submitting ? 'Creating…' : 'Create user'}
        </button>
      </div>
    </div>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div style={{
      background: '#fef2f2', border: '1px solid #fecaca', color: DANGER,
      borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 12,
    }}>
      {message}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 12, color: TEXT_SOFT, fontWeight: 500 }}>{label}</span>
      {children}
    </label>
  )
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th style={{
      padding: '10px 14px', textAlign: align, fontSize: 11, fontWeight: 600,
      color: TEXT_SOFT, letterSpacing: '0.06em', textTransform: 'uppercase',
    }}>
      {children}
    </th>
  )
}

function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <td style={{ padding: '11px 14px', textAlign: align, color: TEXT }}>{children}</td>
}

function Pill({ text }: { text: string }) {
  return (
    <span style={{
      background: '#f0faf7', color: TEAL, border: '1px solid #cdebde',
      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
    }}>{text}</span>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', border: `1px solid ${BORDER}`,
  borderRadius: 7, fontSize: 13, fontFamily: "'DM Sans', sans-serif",
  color: TEXT, boxSizing: 'border-box', background: '#fff',
}
const selectStyle: React.CSSProperties = { ...inputStyle, width: 'auto', minWidth: 140 }
const primaryBtnStyle: React.CSSProperties = {
  background: TEAL, color: '#fff', border: 'none', borderRadius: 7,
  padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  fontFamily: "'DM Sans', sans-serif",
}
const smallBtnStyle: React.CSSProperties = {
  background: '#fff', color: TEXT, border: `1px solid ${BORDER}`,
  borderRadius: 6, padding: '5px 10px', fontSize: 12, fontWeight: 500,
  cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
}
// Suppress unused warning
void TEAL_DARK
