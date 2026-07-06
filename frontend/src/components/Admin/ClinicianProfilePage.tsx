import React, { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { usersApi } from '../../api/users.api'
import { dropoutsApi, DropoutSummary } from '../../api/dropouts.api'
import { caseAcceptanceApi, CaseAcceptanceSummary } from '../../api/caseAcceptance.api'
import {
  User, DropoutDTO, CaseAcceptanceDTO,
  CLINIC_LABEL, ROLE_LABEL, ClinicId, Role,
  isCrossClinicRole, DropoutStatus, DropoutReason,
  DROPOUT_STATUSES, DROPOUT_REASONS,
} from '../../types'
import AppShell from '../shared/AppShell'
import Pagination from '../shared/Pagination'
import DateRangePicker from '../shared/DateRangePicker'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/confirm.store'
import { promptDialog } from '../../store/prompt.store'
import { useNavStore } from '../../store/nav.store'

const TEAL      = '#0f6e56'
const TEXT      = '#111827'
const TEXT_SOFT = '#4b5563'
const BORDER    = '#e5e7eb'
const DANGER    = '#b91c1c'

const ROLES: Role[]       = ['ADMIN', 'CLINICIAN', 'FRONT_DESK', 'FRONT_DESK_GLOBAL', 'ADSPEND']
const CLINICS: ClinicId[] = ['newport', 'narrabeen', 'brookvale']
const PAGE_SIZE = 50

type ProfileTab = 'dropouts' | 'case-acceptance'
type TpFilter   = '' | 'Y' | 'N'

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function daysAgoISO(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function pct(n: number, d: number): string {
  if (d <= 0) return '0'
  return ((n / d) * 100).toFixed(1)
}

export default function ClinicianProfilePage() {
  const [searchParams] = useSearchParams()
  const clinicianId = searchParams.get('clinician_id') ?? ''
  const { navigate } = useNavStore()

  const [user,        setUser]        = useState<User | null>(null)
  const [loadingUser, setLoadingUser] = useState(true)
  const [userError,   setUserError]   = useState('')

  const [showEdit,   setShowEdit]   = useState(false)
  const [editName,   setEditName]   = useState('')
  const [editRole,   setEditRole]   = useState<Role>('CLINICIAN')
  const [editClinic, setEditClinic] = useState<ClinicId | null>(null)
  const [saving,     setSaving]     = useState(false)

  const [tab, setTab] = useState<ProfileTab>('dropouts')

  // ── Dropout filters ───────────────────────────────────────────────────────
  const [dDateFrom,     setDDateFrom]     = useState(daysAgoISO(30))
  const [dDateTo,       setDDateTo]       = useState(todayISO())
  const [dStatus,       setDStatus]       = useState<DropoutStatus | ''>('')
  const [dReason,       setDReason]       = useState<DropoutReason | ''>('')
  const [dSearchInput,  setDSearchInput]  = useState('')
  const dSearch = useDebouncedValue(dSearchInput.trim(), 300)

  const [dropoutSummary,  setDropoutSummary]  = useState<DropoutSummary | null>(null)
  const [dropouts,        setDropouts]        = useState<DropoutDTO[]>([])
  const [dropoutsTotal,   setDropoutsTotal]   = useState(0)
  const [dropoutsOffset,  setDropoutsOffset]  = useState(0)
  const [loadingDropouts, setLoadingDropouts] = useState(false)

  // ── CA filters ────────────────────────────────────────────────────────────
  const [caDateFrom,    setCaDateFrom]    = useState(daysAgoISO(30))
  const [caDateTo,      setCaDateTo]      = useState(todayISO())
  const [caTpFilter,    setCaTpFilter]    = useState<TpFilter>('')
  const [caSearchInput, setCaSearchInput] = useState('')
  const caSearch = useDebouncedValue(caSearchInput.trim(), 300)

  const [caSummary,  setCaSummary]  = useState<CaseAcceptanceSummary | null>(null)
  const [caEntries,  setCaEntries]  = useState<CaseAcceptanceDTO[]>([])
  const [caTotal,    setCaTotal]    = useState(0)
  const [caOffset,   setCaOffset]   = useState(0)
  const [loadingCa,  setLoadingCa]  = useState(false)

  // ── Load user ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!clinicianId) {
      setUserError('No clinician ID provided')
      setLoadingUser(false)
      return
    }
    setLoadingUser(true)
    usersApi.get(clinicianId)
      .then(u => {
        setUser(u)
        setEditName(u.full_name ?? '')
        setEditRole(u.role)
        setEditClinic(u.clinic_id)
        setLoadingUser(false)
      })
      .catch(e => {
        setUserError(e.response?.data?.error?.message ?? 'Failed to load user')
        setLoadingUser(false)
      })
  }, [clinicianId])

  // ── Reset dropout page when filters change ────────────────────────────────
  useEffect(() => { setDropoutsOffset(0) }, [dDateFrom, dDateTo, dStatus, dReason, dSearch])

  // ── Reset CA page when filters change ────────────────────────────────────
  useEffect(() => { setCaOffset(0) }, [caDateFrom, caDateTo, caTpFilter, caSearch])

  // ── Dropout params ────────────────────────────────────────────────────────
  const dropoutParams = {
    clinician_id: clinicianId,
    date_from:    dDateFrom || undefined,
    date_to:      dDateTo   || undefined,
    status:       dStatus   || undefined,
    reason:       dReason   || undefined,
    search:       dSearch   || undefined,
  }

  // ── CA params ─────────────────────────────────────────────────────────────
  const caParams = {
    clinician_id: clinicianId,
    date_from:    caDateFrom || undefined,
    date_to:      caDateTo   || undefined,
    tp_provided:  caTpFilter === '' ? undefined : caTpFilter === 'Y',
    search:       caSearch   || undefined,
  }

  // ── Load dropout summary ──────────────────────────────────────────────────
  useEffect(() => {
    if (!clinicianId) return
    let cancelled = false
    dropoutsApi.summary(dropoutParams)
      .then(s => { if (!cancelled) setDropoutSummary(s) })
      .catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicianId, dDateFrom, dDateTo, dStatus, dReason, dSearch])

  // ── Load dropouts list ────────────────────────────────────────────────────
  const loadDropouts = useCallback(async (offset: number) => {
    if (!clinicianId) return
    setLoadingDropouts(true)
    try {
      const res = await dropoutsApi.list({ ...dropoutParams, limit: PAGE_SIZE, offset })
      setDropouts(res.data)
      setDropoutsTotal(res.pagination.total)
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message ?? 'Failed to load dropouts')
    } finally { setLoadingDropouts(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicianId, dDateFrom, dDateTo, dStatus, dReason, dSearch])

  useEffect(() => { loadDropouts(dropoutsOffset) }, [loadDropouts, dropoutsOffset])

  // ── Load CA summary ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!clinicianId) return
    let cancelled = false
    caseAcceptanceApi.summary(caParams)
      .then(s => { if (!cancelled) setCaSummary(s) })
      .catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicianId, caDateFrom, caDateTo, caTpFilter, caSearch])

  // ── Load CA list ──────────────────────────────────────────────────────────
  const loadCa = useCallback(async (offset: number) => {
    if (!clinicianId) return
    setLoadingCa(true)
    try {
      const res = await caseAcceptanceApi.list({ ...caParams, limit: PAGE_SIZE, offset })
      setCaEntries(res.data)
      setCaTotal(res.pagination.total)
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message ?? 'Failed to load case acceptances')
    } finally { setLoadingCa(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicianId, caDateFrom, caDateTo, caTpFilter, caSearch])

  useEffect(() => { loadCa(caOffset) }, [loadCa, caOffset])

  // ── Edit profile ──────────────────────────────────────────────────────────
  const onSaveEdit = async () => {
    if (!user || !clinicianId) return
    setSaving(true)
    try {
      const updated = await usersApi.update(clinicianId, {
        full_name: editName.trim() || undefined,
        role:      editRole,
        clinic_id: isCrossClinicRole(editRole) ? null : editClinic,
      })
      setUser(updated)
      setShowEdit(false)
      toast.success('Profile updated')
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message ?? 'Failed to update profile')
    } finally { setSaving(false) }
  }

  const onResetPassword = async () => {
    if (!user || !clinicianId) return
    const pwd = await promptDialog.ask({
      title:        'Reset password',
      message:      `Set a new password for ${user.full_name ?? user.email}. They will be signed out of all sessions.`,
      inputType:    'password',
      placeholder:  'At least 8 characters',
      confirmLabel: 'Reset password',
      validate:     (v) => v.length < 8 ? 'Password must be at least 8 characters' : null,
    })
    if (pwd === null) return
    try {
      await usersApi.resetPassword(clinicianId, pwd)
      toast.success('Password reset successfully')
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message ?? 'Failed to reset password')
    }
  }

  const onDeactivate = async () => {
    if (!user || !clinicianId) return
    const ok = await confirmDialog.destructive({
      title:        'Deactivate user?',
      message:      `${user.full_name ?? user.email} will be signed out of all sessions and unable to log in.\n\nYou can reactivate them later.`,
      confirmLabel: 'Deactivate',
    })
    if (!ok) return
    try {
      const updated = await usersApi.deactivate(clinicianId)
      setUser(updated)
      toast.success(`Deactivated ${user.full_name ?? user.email}`)
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message ?? 'Failed to deactivate')
    }
  }

  const onReactivate = async () => {
    if (!user || !clinicianId) return
    try {
      const updated = await usersApi.reactivate(clinicianId)
      setUser(updated)
      toast.success(`Reactivated ${user.full_name ?? user.email}`)
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message ?? 'Failed to reactivate')
    }
  }

  const onDeleteDropout = async (d: DropoutDTO) => {
    const ok = await confirmDialog.destructive({
      title:        'Delete dropout entry?',
      message:      `Delete the dropout entry for ${d.patient_name} (${d.date_logged})?\n\nThis cannot be undone.`,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    try {
      await dropoutsApi.remove(d.id)
      toast.success('Entry deleted')
      await loadDropouts(dropoutsOffset)
      dropoutsApi.summary(dropoutParams).then(setDropoutSummary).catch(() => {})
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message ?? 'Failed to delete')
    }
  }

  const onDeleteCa = async (c: CaseAcceptanceDTO) => {
    const ok = await confirmDialog.destructive({
      title:        'Delete case acceptance entry?',
      message:      `Delete the entry for ${c.patient_name} (${c.date_logged})?\n\nThis cannot be undone.`,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    try {
      await caseAcceptanceApi.remove(c.id)
      toast.success('Entry deleted')
      await loadCa(caOffset)
      caseAcceptanceApi.summary(caParams).then(setCaSummary).catch(() => {})
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message ?? 'Failed to delete')
    }
  }

  // ── Loading / error ───────────────────────────────────────────────────────
  if (loadingUser) {
    return (
      <AppShell title="Clinician Profile">
        <div style={{ padding: '40px 28px', textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
      </AppShell>
    )
  }

  if (userError || !user) {
    return (
      <AppShell title="Clinician Profile">
        <div style={{ padding: '20px 28px' }}>
          <BackBtn onClick={() => navigate('admin-users')} />
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca', color: DANGER,
            borderRadius: 8, padding: '12px 16px', fontSize: 13, marginTop: 16,
          }}>
            {userError || 'User not found'}
          </div>
        </div>
      </AppShell>
    )
  }

  const isClinician = user.role === 'CLINICIAN'
  const initials    = (user.full_name ?? user.email).slice(0, 2).toUpperCase()
  const ds = dropoutSummary
  const cs = caSummary

  return (
    <AppShell title="">
      <div style={{ padding: '20px 28px', fontFamily: "'DM Sans', sans-serif" }}>
        <BackBtn onClick={() => navigate('admin-users')} />

        {/* ── Profile card ─────────────────────────────────────────────── */}
        <div style={{
          background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12,
          padding: '24px', marginTop: 12, marginBottom: 20,
          display: 'flex', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap',
        }}>
          <div style={{
            width: 56, height: 56, borderRadius: 12, flexShrink: 0,
            background: isClinician ? TEAL : '#64748b',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 700, fontSize: 18,
          }}>{initials}</div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: TEXT, lineHeight: 1.2 }}>
              {user.full_name || <span style={{ color: '#9ca3af' }}>No name</span>}
            </div>
            <div style={{ fontSize: 13, color: TEXT_SOFT, marginTop: 3 }}>{user.email}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{
                background: '#f0faf7', color: TEAL, border: '1px solid #cdebde',
                padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600,
              }}>{ROLE_LABEL[user.role]}</span>
              {user.clinic_id && (
                <span style={{
                  background: '#f0f9ff', color: '#0369a1', border: '1px solid #bae6fd',
                  padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                }}>{CLINIC_LABEL[user.clinic_id]}</span>
              )}
              <span style={{
                background: user.is_active ? '#f0fdf4' : '#f9fafb',
                color:      user.is_active ? '#15803d' : '#9ca3af',
                border:     `1px solid ${user.is_active ? '#bbf7d0' : '#e5e7eb'}`,
                padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600,
              }}>{user.is_active ? 'Active' : 'Inactive'}</span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
            <button onClick={() => setShowEdit(true)} style={actionBtnStyle}>Edit profile</button>
            <button onClick={onResetPassword} style={actionBtnStyle}>Reset password</button>
            {user.is_active
              ? <button onClick={onDeactivate} style={{ ...actionBtnStyle, color: DANGER, borderColor: '#fecaca' }}>Deactivate</button>
              : <button onClick={onReactivate} style={actionBtnStyle}>Reactivate</button>
            }
          </div>
        </div>

        {/* ── Edit modal ────────────────────────────────────────────────── */}
        {showEdit && (
          <div
            style={{
              position: 'fixed', inset: 0, zIndex: 100,
              background: 'rgba(15,23,42,0.5)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onClick={e => { if (e.target === e.currentTarget) setShowEdit(false) }}
          >
            <div style={{
              background: '#fff', borderRadius: 14, padding: '28px 28px 24px',
              width: 420, boxShadow: '0 20px 50px rgba(15,23,42,0.2)',
              fontFamily: "'DM Sans', sans-serif",
            }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: TEXT, marginBottom: 20 }}>Edit profile</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Field label="Full name">
                  <input value={editName} onChange={e => setEditName(e.target.value)} style={modalInputStyle} placeholder="e.g. Jane Smith" />
                </Field>
                <Field label="Role">
                  <select value={editRole} onChange={e => setEditRole(e.target.value as Role)} style={modalInputStyle}>
                    {ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                </Field>
                <Field label="Clinic">
                  <select
                    value={isCrossClinicRole(editRole) ? '' : (editClinic ?? '')}
                    onChange={e => setEditClinic((e.target.value as ClinicId) || null)}
                    disabled={isCrossClinicRole(editRole)}
                    style={{ ...modalInputStyle, background: isCrossClinicRole(editRole) ? '#f9fafb' : '#fff' }}
                  >
                    {isCrossClinicRole(editRole)
                      ? <option value="">— Cross-clinic account —</option>
                      : CLINICS.map(c => <option key={c} value={c}>{CLINIC_LABEL[c]}</option>)}
                  </select>
                </Field>
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22 }}>
                <button onClick={() => setShowEdit(false)} style={cancelBtnStyle}>Cancel</button>
                <button onClick={onSaveEdit} disabled={saving} style={{
                  background: saving ? '#6b7280' : TEAL, border: 'none', color: '#fff',
                  borderRadius: 7, padding: '8px 22px', fontSize: 13, fontWeight: 600,
                  cursor: saving ? 'not-allowed' : 'pointer', fontFamily: "'DM Sans', sans-serif",
                }}>{saving ? 'Saving…' : 'Save changes'}</button>
              </div>
            </div>
          </div>
        )}

        {/* ── Non-clinician notice ─────────────────────────────────────── */}
        {!isClinician && (
          <div style={{
            background: '#f9fafb', border: `1px solid ${BORDER}`, borderRadius: 10,
            padding: '24px', textAlign: 'center', color: TEXT_SOFT, fontSize: 13,
          }}>
            Dropout and case acceptance data is only available for Clinician accounts.
          </div>
        )}

        {/* ── Tabs ─────────────────────────────────────────────────────── */}
        {isClinician && (
          <>
            <div style={{
              display: 'flex', gap: 4, marginBottom: 16,
              background: '#fff', padding: 4, borderRadius: 8,
              border: `1px solid ${BORDER}`, width: 'fit-content',
            }}>
              {([['dropouts', 'Patient Dropouts'], ['case-acceptance', 'Case Acceptance']] as [ProfileTab, string][]).map(([id, label]) => (
                <button key={id} onClick={() => setTab(id)} style={{
                  background:  tab === id ? TEAL : 'transparent',
                  color:       tab === id ? '#fff' : TEXT_SOFT,
                  border: 'none', borderRadius: 6, padding: '7px 18px',
                  fontSize: 13, fontWeight: 600, cursor: 'pointer',
                  fontFamily: "'DM Sans', sans-serif",
                }}>{label}</button>
              ))}
            </div>

            {/* ── Dropout tab ──────────────────────────────────────────── */}
            {tab === 'dropouts' && (
              <>
                {/* Filters */}
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                  <Field label="Search">
                    <div style={{ position: 'relative' }}>
                      <input
                        value={dSearchInput}
                        onChange={e => setDSearchInput(e.target.value)}
                        placeholder="Patient name or notes…"
                        style={{ ...filterInputStyle, paddingRight: dSearchInput ? 26 : 12, minWidth: 210 }}
                      />
                      {dSearchInput && (
                        <button onClick={() => setDSearchInput('')} style={clearXStyle}>×</button>
                      )}
                    </div>
                  </Field>
                  <Field label="Date range">
                    <DateRangePicker
                      value={{ from: dDateFrom, to: dDateTo }}
                      onChange={r => { setDDateFrom(r.from); setDDateTo(r.to) }}
                      maxRangeDays={366}
                    />
                  </Field>
                  <Field label="Status">
                    <select value={dStatus} onChange={e => setDStatus(e.target.value as DropoutStatus | '')} style={filterInputStyle}>
                      <option value="">All</option>
                      {DROPOUT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </Field>
                  <Field label="Reason">
                    <select value={dReason} onChange={e => setDReason(e.target.value as DropoutReason | '')} style={filterInputStyle}>
                      <option value="">All</option>
                      {DROPOUT_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </Field>
                </div>

                {/* Summary cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
                  <SummaryCard label="Total entries"         value={ds?.total ?? 0}                                    highlight />
                  <SummaryCard label="Cancelled (no rebook)" value={ds?.byStatus['Cancelled - not rescheduled'] ?? 0} />
                  <SummaryCard label="No future bookings"    value={ds?.byStatus['No Future Bookings'] ?? 0} />
                  <SummaryCard label="Re-scheduled"          value={ds?.byStatus['Re-scheduled'] ?? 0} />
                </div>

                {/* Table */}
                <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
                  {loadingDropouts ? (
                    <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
                  ) : dropouts.length === 0 ? (
                    <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No entries match these filters.</div>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 900 }}>
                        <thead>
                          <tr style={{ background: '#f9fafb' }}>
                            <Th>Date</Th>
                            <Th>Clinic</Th>
                            <Th>Front of staff</Th>
                            <Th>Patient</Th>
                            <Th>Appts cancelled</Th>
                            <Th>Status</Th>
                            <Th>Reason</Th>
                            <Th>Notes</Th>
                            <Th align="right">Actions</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {dropouts.map(d => (
                            <tr key={d.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                              <Td>{d.date_logged}</Td>
                              <Td>{CLINIC_LABEL[d.clinic_id] ?? d.clinic_id}</Td>
                              <Td>{d.front_staff_name || <Dim>—</Dim>}</Td>
                              <Td><strong>{d.patient_name}</strong></Td>
                              <Td>
                                {d.appointment_cancelled_dates.length === 0
                                  ? <Dim>—</Dim>
                                  : d.appointment_cancelled_dates.length === 1
                                    ? d.appointment_cancelled_dates[0]
                                    : (
                                      <span title={d.appointment_cancelled_dates.join(', ')}>
                                        {d.appointment_cancelled_dates[0]}{' '}
                                        <span style={{ color: TEXT_SOFT }}>(+{d.appointment_cancelled_dates.length - 1})</span>
                                      </span>
                                    )}
                              </Td>
                              <Td>{d.status ? <StatusPill status={d.status} /> : <Dim>—</Dim>}</Td>
                              <Td>{d.reason || <Dim>—</Dim>}</Td>
                              <Td><span style={{ color: TEXT_SOFT }}>{d.notes || <Dim>—</Dim>}</span></Td>
                              <Td align="right">
                                <button
                                  onClick={() => onDeleteDropout(d)}
                                  style={{ ...smallBtnStyle, color: DANGER, borderColor: '#fecaca' }}
                                >Delete</button>
                              </Td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {!loadingDropouts && dropoutsTotal > 0 && (
                    <Pagination
                      total={dropoutsTotal} limit={PAGE_SIZE} offset={dropoutsOffset}
                      onChange={setDropoutsOffset} onLimitChange={() => {}}
                    />
                  )}
                </div>
              </>
            )}

            {/* ── Case Acceptance tab ───────────────────────────────────── */}
            {tab === 'case-acceptance' && (
              <>
                {/* Filters */}
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                  <Field label="Search">
                    <div style={{ position: 'relative' }}>
                      <input
                        value={caSearchInput}
                        onChange={e => setCaSearchInput(e.target.value)}
                        placeholder="Patient name or notes…"
                        style={{ ...filterInputStyle, paddingRight: caSearchInput ? 26 : 12, minWidth: 210 }}
                      />
                      {caSearchInput && (
                        <button onClick={() => setCaSearchInput('')} style={clearXStyle}>×</button>
                      )}
                    </div>
                  </Field>
                  <Field label="Date range">
                    <DateRangePicker
                      value={{ from: caDateFrom, to: caDateTo }}
                      onChange={r => { setCaDateFrom(r.from); setCaDateTo(r.to) }}
                      maxRangeDays={366}
                    />
                  </Field>
                  <Field label="TP Provided">
                    <select value={caTpFilter} onChange={e => setCaTpFilter(e.target.value as TpFilter)} style={filterInputStyle}>
                      <option value="">All</option>
                      <option value="Y">Yes</option>
                      <option value="N">No</option>
                    </select>
                  </Field>
                </div>

                {/* Summary cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 16 }}>
                  <SummaryCard label="Entries"  value={cs?.total ?? 0} highlight />
                  <SummaryCard
                    label="Recs"
                    value={cs?.totalRecommendations ?? 0}
                    sub={cs && cs.totalRecommendations > 0 ? `${pct(cs.totalBooked, cs.totalRecommendations)}% booked` : ''}
                  />
                  <SummaryCard
                    label="Booked"
                    value={cs?.totalBooked ?? 0}
                    sub={cs?.caseAcceptancePct != null ? `${cs.caseAcceptancePct.toFixed(1)}% acceptance` : ''}
                  />
                  <SummaryCard
                    label="Acceptance"
                    value={cs?.caseAcceptancePct == null ? '—' : `${cs.caseAcceptancePct.toFixed(1)}%`}
                    sub={cs ? `${cs.totalBooked} / ${cs.totalRecommendations}` : ''}
                  />
                  <SummaryCard
                    label="Prepay offered"
                    value={cs?.prepayOffered ?? 0}
                    sub={cs ? `${pct(cs.prepayOffered, cs.total)}% of entries` : ''}
                  />
                  <SummaryCard
                    label="Prepay accepted"
                    value={cs?.prepayAccepted ?? 0}
                    sub={cs ? `${pct(cs.prepayAccepted, cs.prepayOffered)}% of offers` : ''}
                  />
                </div>

                {/* Table */}
                <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
                  {loadingCa ? (
                    <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
                  ) : caEntries.length === 0 ? (
                    <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No entries match these filters.</div>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 1100 }}>
                        <thead>
                          <tr style={{ background: '#f9fafb' }}>
                            <Th>Date</Th>
                            <Th>Clinic</Th>
                            <Th>Front of staff</Th>
                            <Th>Patient</Th>
                            <Th align="center">TP</Th>
                            <Th align="right">Recs</Th>
                            <Th align="right">Booked</Th>
                            <Th align="right">Acceptance</Th>
                            <Th align="center">Prepay offered</Th>
                            <Th align="center">Prepay accepted</Th>
                            <Th>Transition notes</Th>
                            <Th>Notes</Th>
                            <Th align="right">Actions</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {caEntries.map(c => (
                            <tr key={c.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                              <Td>{c.date_logged}</Td>
                              <Td>{CLINIC_LABEL[c.clinic_id] ?? c.clinic_id}</Td>
                              <Td>{c.front_staff_name || <Dim>—</Dim>}</Td>
                              <Td><strong>{c.patient_name}</strong></Td>
                              <Td align="center"><YnPill v={c.treatment_plan_provided} /></Td>
                              <Td align="right">{c.case_recommendations}</Td>
                              <Td align="right">{c.appointments_booked}</Td>
                              <Td align="right">
                                {c.case_acceptance_pct === null ? <Dim>—</Dim> : `${c.case_acceptance_pct.toFixed(2)}%`}
                              </Td>
                              <Td align="center"><PrepayPill v={c.prepay_offered} /></Td>
                              <Td align="center"><PrepayPill v={c.prepay_accepted} /></Td>
                              <Td><span style={{ color: TEXT_SOFT }}>{c.transition_notes || <Dim>—</Dim>}</span></Td>
                              <Td><span style={{ color: TEXT_SOFT }}>{c.notes || <Dim>—</Dim>}</span></Td>
                              <Td align="right">
                                <button
                                  onClick={() => onDeleteCa(c)}
                                  style={{ ...smallBtnStyle, color: DANGER, borderColor: '#fecaca' }}
                                >Delete</button>
                              </Td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {!loadingCa && caTotal > 0 && (
                    <Pagination
                      total={caTotal} limit={PAGE_SIZE} offset={caOffset}
                      onChange={setCaOffset} onLimitChange={() => {}}
                    />
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </AppShell>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      background: 'transparent', border: `1px solid ${BORDER}`,
      color: TEXT_SOFT, borderRadius: 7, padding: '7px 14px',
      fontSize: 13, fontWeight: 500, cursor: 'pointer',
      fontFamily: "'DM Sans', sans-serif",
      display: 'inline-flex', alignItems: 'center', gap: 6,
    }}>← Back to User Management</button>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: TEXT_SOFT, fontWeight: 500 }}>{label}</span>
      {children}
    </label>
  )
}

function SummaryCard({ label, value, sub, highlight }: {
  label: string; value: number | string; sub?: string; highlight?: boolean
}) {
  return (
    <div style={{
      background: highlight ? '#f0faf7' : '#fff',
      border: `1px solid ${highlight ? '#cdebde' : BORDER}`,
      borderRadius: 10, padding: '14px 16px',
    }}>
      <div style={{ fontSize: 11, color: TEXT_SOFT, fontWeight: 500, letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: highlight ? TEAL : TEXT, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: TEXT_SOFT, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
  return (
    <th style={{
      padding: '10px 14px', textAlign: align, fontSize: 11, fontWeight: 600,
      color: TEXT_SOFT, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
    }}>{children}</th>
  )
}

function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
  return <td style={{ padding: '10px 14px', textAlign: align, color: TEXT, verticalAlign: 'top' }}>{children}</td>
}

function Dim({ children }: { children?: React.ReactNode }) {
  return <span style={{ color: '#9ca3af' }}>{children ?? '—'}</span>
}

function StatusPill({ status }: { status: DropoutStatus }) {
  const colors: Record<DropoutStatus, { bg: string; fg: string; bd: string }> = {
    'Re-scheduled':                { bg: '#ecfdf5', fg: '#065f46', bd: '#a7f3d0' },
    'Cancelled - not rescheduled': { bg: '#fef9c3', fg: '#854d0e', bd: '#fde68a' },
    'No Future Bookings':          { bg: '#fee2e2', fg: '#991b1b', bd: '#fecaca' },
    'Completed Treatment Plan':    { bg: '#e0f2fe', fg: '#075985', bd: '#bae6fd' },
  }
  const c = colors[status]
  return (
    <span style={{
      background: c.bg, color: c.fg, border: `1px solid ${c.bd}`,
      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
    }}>{status}</span>
  )
}

function YnPill({ v }: { v: boolean | null }) {
  if (v === null || v === undefined) return <Dim>—</Dim>
  return (
    <span style={{
      background: v ? '#ecfdf5' : '#fef2f2', color: v ? '#065f46' : '#991b1b',
      border: `1px solid ${v ? '#a7f3d0' : '#fecaca'}`,
      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
    }}>{v ? 'YES' : 'NO'}</span>
  )
}

function PrepayPill({ v }: { v: boolean | null }) {
  if (v === null || v === undefined) return <Dim>0</Dim>
  return (
    <span style={{
      background: v ? '#ecfdf5' : '#fef2f2', color: v ? '#065f46' : '#991b1b',
      border: `1px solid ${v ? '#a7f3d0' : '#fecaca'}`,
      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
    }}>{v ? 'YES' : 'NO'}</span>
  )
}

const actionBtnStyle: React.CSSProperties = {
  background: '#fff', color: TEXT, border: `1px solid ${BORDER}`,
  borderRadius: 7, padding: '8px 14px', fontSize: 13, fontWeight: 500,
  cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
}
const cancelBtnStyle: React.CSSProperties = {
  background: 'transparent', border: `1px solid ${BORDER}`,
  color: TEXT_SOFT, borderRadius: 7, padding: '8px 18px',
  fontSize: 13, fontWeight: 500, cursor: 'pointer',
  fontFamily: "'DM Sans', sans-serif",
}
const smallBtnStyle: React.CSSProperties = {
  background: '#fff', color: TEXT, border: `1px solid ${BORDER}`,
  borderRadius: 6, padding: '5px 10px', fontSize: 12, fontWeight: 500,
  cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
}
const filterInputStyle: React.CSSProperties = {
  padding: '7px 10px', border: `1px solid ${BORDER}`,
  borderRadius: 7, fontSize: 13, fontFamily: "'DM Sans', sans-serif",
  color: TEXT, background: '#fff',
}
const modalInputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', border: `1px solid ${BORDER}`,
  borderRadius: 7, fontSize: 13, fontFamily: "'DM Sans', sans-serif",
  color: TEXT, boxSizing: 'border-box',
}
const clearXStyle: React.CSSProperties = {
  position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
  background: 'transparent', border: 'none', cursor: 'pointer',
  color: '#9ca3af', fontSize: 14, padding: 2,
}
