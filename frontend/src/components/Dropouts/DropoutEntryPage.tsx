import React, { useEffect, useState, useCallback } from 'react'
import { dropoutsApi, CreateDropoutPayload, UpdateDropoutPayload } from '../../api/dropouts.api'
import { usersApi } from '../../api/users.api'
import {
  DropoutDTO, DROPOUT_STATUSES, DROPOUT_REASONS, DropoutStatus, DropoutReason,
  FRONT_STAFF_NAMES, FrontStaffName,
  User, CLINIC_LABEL, ClinicId,
} from '../../types'

const CLINIC_OPTIONS: ClinicId[] = ['newport', 'narrabeen', 'brookvale']
import { useAuthStore } from '../../store/auth.store'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/confirm.store'
import { exportDropoutsXlsx } from '../../lib/exportDropoutsXlsx'
import AppShell from '../shared/AppShell'
import Pagination from '../shared/Pagination'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'

const TEAL      = '#0f6e56'
const TEXT      = '#111827'
const TEXT_SOFT = '#4b5563'
const BORDER    = '#e5e7eb'
const DANGER    = '#b91c1c'

const SAME_DAY_WINDOW_MS = 24 * 60 * 60 * 1000

function todayISO(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

interface FormState {
  date_logged:                 string
  clinic_id:                   ClinicId | ''  // chosen by FRONT_DESK_GLOBAL per entry
  clinician_id:                string         // auto-set for CLINICIAN role
  front_staff_name:            FrontStaffName | ''  // CLINICIAN dropdown only
  patient_name:                string
  /** All recorded cancellation dates for this dropout (may be empty). */
  appointment_cancelled_dates: string[]
  /** Pending value in the date input — added to the array on click. */
  cancel_date_input:           string
  status:                      DropoutStatus | ''
  reason:                      DropoutReason | ''
  notes:                       string
}

function emptyForm(currentUser: User): FormState {
  return {
    date_logged:                 todayISO(),
    clinic_id:                   currentUser.role === 'FRONT_DESK_GLOBAL'
                                   ? ''
                                   : (currentUser.clinic_id ?? '') as ClinicId | '',
    clinician_id:                currentUser.role === 'CLINICIAN'  ? currentUser.id : '',
    front_staff_name:            '',
    patient_name:                '',
    appointment_cancelled_dates: [],
    cancel_date_input:           '',
    status:                      '',
    reason:                      '',
    notes:                       '',
  }
}

export default function DropoutEntryPage() {
  const { user } = useAuthStore()
  if (!user) return null

  const isReceptionist     = user.role === 'FRONT_DESK' || user.role === 'FRONT_DESK_GLOBAL'
  const isFrontDeskGlobal  = user.role === 'FRONT_DESK_GLOBAL'

  const [rows,    setRows]    = useState<DropoutDTO[]>([])
  const [total,   setTotal]   = useState(0)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  const [limit,  setLimit]  = useState(50)
  const [offset, setOffset] = useState(0)

  const [searchInput, setSearchInput] = useState('')
  const search = useDebouncedValue(searchInput.trim(), 300)

  // Reset to page 1 whenever search or page-size changes.
  useEffect(() => { setOffset(0) }, [search, limit])

  const [clinicians, setClinicians] = useState<User[]>([])

  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm(user))
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await dropoutsApi.list({
        limit, offset,
        search: search || undefined,
      })
      setRows(res.data)
      setTotal(res.pagination.total)
    } catch (e: any) {
      setError(e.response?.data?.error?.message || 'Failed to load dropouts')
    } finally { setLoading(false) }
  }, [limit, offset, search])

  useEffect(() => { load() }, [load])

  // Load clinician dropdown. Pinned-clinic users (FRONT_DESK / CLINICIAN) load
  // from their own clinic; ADMIN and FRONT_DESK_GLOBAL both have null
  // `user.clinic_id`, so they use `form.clinic_id` instead (set by the form
  // on create, or pre-loaded from the row on edit).
  const usesFormClinic = isFrontDeskGlobal || user.role === 'ADMIN'
  const activeClinic: ClinicId | null = usesFormClinic
    ? (form.clinic_id ? form.clinic_id : null)
    : ((user.clinic_id as ClinicId | null) ?? null)
  useEffect(() => {
    if (!activeClinic) { setClinicians([]); return }
    usersApi.staff('CLINICIAN', activeClinic).then(setClinicians).catch(() => {})
  }, [activeClinic])

  const startEdit = (row: DropoutDTO) => {
    setEditingId(row.id)
    setForm({
      date_logged:                 row.date_logged,
      clinic_id:                   row.clinic_id,
      clinician_id:                row.clinician_id,
      front_staff_name:            (FRONT_STAFF_NAMES as readonly string[]).includes(row.front_staff_name ?? '')
                                     ? (row.front_staff_name as FrontStaffName)
                                     : '',
      patient_name:                row.patient_name,
      appointment_cancelled_dates: [...row.appointment_cancelled_dates],
      cancel_date_input:           '',
      status:                      row.status ?? '',
      reason:                      row.reason ?? '',
      notes:                       row.notes ?? '',
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const addCancelDate = () => {
    const v = form.cancel_date_input
    if (!v) return
    if (form.appointment_cancelled_dates.includes(v)) {
      setForm({ ...form, cancel_date_input: '' })
      return
    }
    if (form.appointment_cancelled_dates.length >= 50) {
      setError('Up to 50 cancellation dates per entry')
      return
    }
    // Keep the array sorted ascending so chips are easy to scan.
    const next = [...form.appointment_cancelled_dates, v].sort()
    setForm({ ...form, appointment_cancelled_dates: next, cancel_date_input: '' })
  }
  const removeCancelDate = (d: string) => {
    setForm({
      ...form,
      appointment_cancelled_dates: form.appointment_cancelled_dates.filter(x => x !== d),
    })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setForm(emptyForm(user))
  }

  const onSubmit = async () => {
    setError('')

    if (usesFormClinic && !form.clinic_id) return setError('Clinic is required')
    if (!form.patient_name.trim())             return setError('Patient name is required')
    if (!form.clinician_id)                    return setError('Clinician is required')
    if (!form.status)                          return setError('Status is required')
    if (!form.reason)                          return setError('Reason is required')

    setSaving(true)
    const patientName = form.patient_name.trim()
    try {
      // Receptionist accounts have front_staff_name stamped server-side from
      // their login. Don't send a value or it would only be ignored anyway.
      const frontStaff = isReceptionist
        ? undefined
        : (form.front_staff_name || null)

      if (editingId) {
        const patch: UpdateDropoutPayload = {
          date_logged:                 form.date_logged,
          clinician_id:                form.clinician_id,
          ...(frontStaff !== undefined ? { front_staff_name: frontStaff } : {}),
          patient_name:                patientName,
          appointment_cancelled_dates: form.appointment_cancelled_dates,
          status:                      form.status as DropoutStatus,
          reason:                      form.reason as DropoutReason,
          notes:                       form.notes.trim() || null,
        }
        await dropoutsApi.update(editingId, patch)
        toast.success(`Updated dropout entry for ${patientName}`)
      } else {
        const payload: CreateDropoutPayload = {
          date_logged:                 form.date_logged,
          clinician_id:                form.clinician_id,
          ...(isFrontDeskGlobal ? { clinic_id: form.clinic_id as ClinicId } : {}),
          ...(frontStaff !== undefined ? { front_staff_name: frontStaff } : {}),
          patient_name:                patientName,
          appointment_cancelled_dates: form.appointment_cancelled_dates,
          status:                      form.status as DropoutStatus,
          reason:                      form.reason as DropoutReason,
          notes:                       form.notes.trim() || null,
        }
        await dropoutsApi.create(payload)
        toast.success(`Added dropout entry for ${patientName}`)
      }
      cancelEdit()
      await load()
    } catch (e: any) {
      const details = e.response?.data?.error?.details
      const detailsMsg = Array.isArray(details)
        ? details.map((d: any) => `${d.path}: ${d.message}`).join(', ')
        : ''
      const msg = (e.response?.data?.error?.message || 'Failed to save') + (detailsMsg ? ` — ${detailsMsg}` : '')
      setError(msg)
      toast.error(msg)
    } finally { setSaving(false) }
  }

  const [exporting, setExporting] = useState(false)
  const onExport = async () => {
    setExporting(true)
    try {
      const PAGE = 500
      const all: DropoutDTO[] = []
      let cursor = 0
      while (true) {
        const res = await dropoutsApi.list({
          limit: PAGE, offset: cursor,
          search: search || undefined,
        })
        all.push(...res.data)
        if (!res.pagination.hasMore || res.data.length === 0) break
        cursor += res.data.length
        if (cursor > 50_000) break
      }
      const today = todayISO()
      await exportDropoutsXlsx(all, {
        filename: `my_dropouts_${today}`,
      })
      toast.success(`Exported ${all.length.toLocaleString()} ${all.length === 1 ? 'entry' : 'entries'}`)
    } catch (e: any) {
      toast.error(e?.message || 'Failed to export')
    } finally { setExporting(false) }
  }

  const onDelete = async (row: DropoutDTO) => {
    const ok = await confirmDialog.destructive({
      title:        'Delete dropout entry?',
      message:      `Patient: ${row.patient_name}\nLogged: ${row.date_logged}\n\nThis cannot be undone.`,
      confirmLabel: 'Delete entry',
    })
    if (!ok) return
    try {
      await dropoutsApi.remove(row.id)
      toast.success(`Deleted dropout entry for ${row.patient_name}`)
      await load()
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || 'Failed to delete')
    }
  }

  const isEditable = (row: DropoutDTO) => {
    // ADMIN has data-correction privilege — can edit any row at any time.
    // Audit log captures the mutation so the trail is preserved.
    if (user.role === 'ADMIN') return true
    if (row.entered_by !== user.id) return false
    const ageMs = Date.now() - new Date(row.created_at).getTime()
    return ageMs <= SAME_DAY_WINDOW_MS
  }

  // ADMINs are blocked from creating entries (backend enforces). Show the
  // form only when editing an existing row — never for fresh creation.
  const showCreateForm = user.role !== 'ADMIN' || editingId !== null

  return (
    <AppShell title="Daily Patient Dropout Tracking">
      <div style={{ padding: '20px 28px' }}>
        {/* Form card — hidden for ADMINs unless they're editing an existing row */}
        {showCreateForm && (
        <div style={{
          background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10,
          padding: 18, marginBottom: 20,
        }}>
          <div style={{
            fontSize: 14, fontWeight: 600, color: TEXT, marginBottom: 14,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span>{editingId ? 'Editing entry' : 'New dropout entry'}</span>
            {editingId && (
              <button onClick={cancelEdit} style={smallBtnStyle}>Cancel edit</button>
            )}
          </div>

          {error && (
            <div style={{
              background: '#fef2f2', border: '1px solid #fecaca', color: DANGER,
              borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 12,
            }}>{error}</div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            <Field label="Date">
              <input type="date" value={form.date_logged}
                onChange={e => setForm({ ...form, date_logged: e.target.value })}
                style={inputStyle} />
            </Field>

            {usesFormClinic && (
              <Field label="Clinic">
                <select value={form.clinic_id}
                  onChange={e => setForm({
                    ...form,
                    clinic_id:    e.target.value as ClinicId | '',
                    clinician_id: '', // reset — clinician list reloads for the new clinic
                  })}
                  style={inputStyle}>
                  <option value="">— Select clinic —</option>
                  {CLINIC_OPTIONS.map(c => (
                    <option key={c} value={c}>{CLINIC_LABEL[c]}</option>
                  ))}
                </select>
              </Field>
            )}

            {user.role === 'CLINICIAN' ? (
              <Field label="Clinician">
                <input value={user.full_name || user.email} disabled style={{ ...inputStyle, background: '#f9fafb' }} />
              </Field>
            ) : (
              <Field label="Clinician">
                <select value={form.clinician_id}
                  onChange={e => setForm({ ...form, clinician_id: e.target.value })}
                  style={inputStyle}
                  disabled={usesFormClinic && !form.clinic_id}>
                  <option value="">
                    {usesFormClinic && !form.clinic_id
                      ? '— Pick a clinic first —'
                      : '— Select clinician —'}
                  </option>
                  {clinicians.map(c => (
                    <option key={c.id} value={c.id}>{c.full_name || c.email}</option>
                  ))}
                </select>
              </Field>
            )}

            {/* Front-of-staff: receptionist logins are stamped from their
                account — read-only. CLINICIAN keeps the dropdown. */}
            {isReceptionist ? (
              <Field label="Front of staff name (your login)">
                <input
                  value={user.full_name || user.email}
                  disabled
                  style={{ ...inputStyle, background: '#f9fafb' }}
                />
              </Field>
            ) : (
              <Field label="Front of staff name">
                <select value={form.front_staff_name}
                  onChange={e => setForm({ ...form, front_staff_name: e.target.value as FrontStaffName | '' })}
                  style={inputStyle}>
                  <option value="">— Select —</option>
                  {FRONT_STAFF_NAMES.map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </Field>
            )}

            <Field label="Patient name">
              <input value={form.patient_name}
                onChange={e => setForm({ ...form, patient_name: e.target.value })}
                placeholder="e.g. Jay Rowley"
                style={inputStyle} />
            </Field>

            <Field label="Appointment cancelled dates (optional)" full>
              <CancelledDatesPicker
                dates={form.appointment_cancelled_dates}
                input={form.cancel_date_input}
                onInputChange={v => setForm({ ...form, cancel_date_input: v })}
                onAdd={addCancelDate}
                onRemove={removeCancelDate}
              />
            </Field>

            <Field label="Status">
              <select value={form.status}
                onChange={e => setForm({ ...form, status: e.target.value as DropoutStatus | '' })}
                style={inputStyle}>
                <option value="">— Select status —</option>
                {DROPOUT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>

            <Field label="Reason for cancelling">
              <select value={form.reason}
                onChange={e => setForm({ ...form, reason: e.target.value as DropoutReason | '' })}
                style={inputStyle}>
                <option value="">— Select reason —</option>
                {DROPOUT_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>

            <Field label="Notes" full>
              <textarea value={form.notes}
                onChange={e => setForm({ ...form, notes: e.target.value })}
                rows={2}
                placeholder="Anything worth noting…"
                style={{ ...inputStyle, resize: 'vertical', minHeight: 38 }} />
            </Field>
          </div>

          <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={onSubmit} disabled={saving} style={primaryBtnStyle}>
              {saving ? 'Saving…' : editingId ? 'Update entry' : 'Add entry'}
            </button>
          </div>
        </div>
        )}

        {/* Table */}
        <div style={{
          background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10,
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 16px', background: '#f9fafb', borderBottom: `1px solid ${BORDER}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            flexWrap: 'wrap',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>
              {user.role === 'CLINICIAN'
                ? 'My entries'
                : isFrontDeskGlobal
                  ? 'Entries — All clinics'
                  : `Entries — ${user.clinic_id ? CLINIC_LABEL[user.clinic_id as ClinicId] : ''}`}
              <span style={{ color: TEXT_SOFT, fontWeight: 400, marginLeft: 8 }}>
                ({total.toLocaleString()}{search ? ` matching "${search}"` : ''})
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ position: 'relative' }}>
                <input
                  type="text"
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  placeholder="Search patient or notes…"
                  style={{
                    ...inputStyle, paddingRight: searchInput ? 26 : 12,
                    width: 260, fontSize: 12,
                  }}
                />
                {searchInput && (
                  <button
                    onClick={() => setSearchInput('')}
                    title="Clear search"
                    style={{
                      position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      color: '#9ca3af', fontSize: 14, padding: 2,
                    }}
                  >×</button>
                )}
              </div>
              <button
                onClick={onExport}
                disabled={exporting || total === 0}
                style={smallBtnStyle}
                title="Download all your entries as Excel"
              >
                {exporting ? 'Exporting…' : `Download Excel`}
              </button>
            </div>
          </div>

          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
              No entries yet. Add your first dropout above.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 1100 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    <Th>Date</Th>
                    {isFrontDeskGlobal && <Th>Clinic</Th>}
                    <Th>Front of staff</Th>
                    <Th>Clinician</Th>
                    <Th>Patient</Th>
                    <Th>Appts cancelled</Th>
                    <Th>Status</Th>
                    <Th>Reason</Th>
                    <Th>Notes</Th>
                    <Th align="right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                      <Td>{r.date_logged}</Td>
                      {isFrontDeskGlobal && <Td>{CLINIC_LABEL[r.clinic_id]}</Td>}
                      <Td>{r.front_staff_name || <Dim>—</Dim>}</Td>
                      <Td>{r.clinician_name || <Dim>—</Dim>}</Td>
                      <Td><strong>{r.patient_name}</strong></Td>
                      <Td><CancelledDatesCell dates={r.appointment_cancelled_dates} /></Td>
                      <Td>{r.status ? <StatusPill status={r.status} /> : <Dim>—</Dim>}</Td>
                      <Td>{r.reason || <Dim>—</Dim>}</Td>
                      <Td><span style={{ color: TEXT_SOFT }}>{r.notes || <Dim>—</Dim>}</span></Td>
                      <Td align="right">
                        {isEditable(r) ? (
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <button onClick={() => startEdit(r)} style={smallBtnStyle}>Edit</button>
                            <button onClick={() => onDelete(r)} style={{ ...smallBtnStyle, color: DANGER, borderColor: '#fecaca' }}>Delete</button>
                          </div>
                        ) : <Dim>—</Dim>}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!loading && total > 0 && (
            <Pagination
              total={total}
              limit={limit}
              offset={offset}
              onChange={setOffset}
              onLimitChange={(n) => { setLimit(n); setOffset(0) }}
            />
          )}
        </div>
      </div>
    </AppShell>
  )
}

/**
 * Multi-date picker: a date input + Add button, plus a chip list of the
 * dates already added. Each chip has an × to remove it.
 */
function CancelledDatesPicker({
  dates, input, onInputChange, onAdd, onRemove,
}: {
  dates:         string[]
  input:         string
  onInputChange: (v: string) => void
  onAdd:         () => void
  onRemove:      (d: string) => void
}) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="date"
          value={input}
          onChange={e => onInputChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onAdd() } }}
          style={{ ...inputStyle, flex: '0 0 200px' }}
        />
        <button type="button" onClick={onAdd} disabled={!input} style={smallBtnStyle}>
          + Add date
        </button>
      </div>
      {dates.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {dates.map(d => (
            <span key={d} style={{
              background: '#f0faf7', color: TEAL, border: '1px solid #cdebde',
              borderRadius: 999, padding: '3px 4px 3px 10px',
              fontSize: 12, fontWeight: 500,
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}>
              {d}
              <button
                type="button"
                onClick={() => onRemove(d)}
                title="Remove date"
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: TEAL, fontSize: 14, lineHeight: 1, padding: '0 4px',
                }}
              >×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function CancelledDatesCell({ dates }: { dates: string[] }) {
  if (!dates || dates.length === 0) return <Dim>—</Dim>
  if (dates.length === 1) return <span>{dates[0]}</span>
  return (
    <span title={dates.join(', ')}>
      {dates[0]} <span style={{ color: TEXT_SOFT }}>(+{dates.length - 1})</span>
    </span>
  )
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, gridColumn: full ? '1 / -1' : undefined }}>
      <span style={{ fontSize: 12, color: TEXT_SOFT, fontWeight: 500 }}>{label}</span>
      {children}
    </label>
  )
}
function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th style={{
      padding: '10px 14px', textAlign: align, fontSize: 11, fontWeight: 600,
      color: TEXT_SOFT, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
    }}>{children}</th>
  )
}
function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <td style={{ padding: '10px 14px', textAlign: align, color: TEXT, verticalAlign: 'top' }}>{children}</td>
}
function Dim({ children }: { children: React.ReactNode }) {
  return <span style={{ color: '#9ca3af' }}>{children}</span>
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

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', border: `1px solid ${BORDER}`,
  borderRadius: 7, fontSize: 13, fontFamily: "'DM Sans', sans-serif",
  color: TEXT, boxSizing: 'border-box', background: '#fff',
}
const primaryBtnStyle: React.CSSProperties = {
  background: TEAL, color: '#fff', border: 'none', borderRadius: 7,
  padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  fontFamily: "'DM Sans', sans-serif",
}
const smallBtnStyle: React.CSSProperties = {
  background: '#fff', color: TEXT, border: `1px solid ${BORDER}`,
  borderRadius: 6, padding: '5px 10px', fontSize: 12, fontWeight: 500,
  cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
}
