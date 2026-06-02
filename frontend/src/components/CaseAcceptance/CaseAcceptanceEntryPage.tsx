import React, { useEffect, useState, useCallback, useMemo } from 'react'
import {
  caseAcceptanceApi,
  CreateCaseAcceptancePayload, UpdateCaseAcceptancePayload,
  CaseAcceptanceSummary,
} from '../../api/caseAcceptance.api'
import { usersApi } from '../../api/users.api'
import {
  CaseAcceptanceDTO,
  FRONT_STAFF_NAMES, FrontStaffName,
  User, CLINIC_LABEL, ClinicId,
} from '../../types'

const CLINIC_OPTIONS: ClinicId[] = ['newport', 'narrabeen', 'brookvale']
import { useAuthStore } from '../../store/auth.store'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/confirm.store'
import AppShell from '../shared/AppShell'
import Pagination from '../shared/Pagination'
import DateRangePicker, { DateRangeValue } from '../shared/DateRangePicker'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'

// Default filter — last 30 days, persisted to localStorage so the user's
// last pick survives reload.
const FILTER_STORAGE_KEY = 'pw:case-acceptance:filter'
function defaultDateRange(): DateRangeValue {
  const to   = new Date()
  const from = new Date(); from.setDate(from.getDate() - 29)
  const iso  = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
  return { from: iso(from), to: iso(to) }
}
function loadPersistedRange(): DateRangeValue {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY)
    if (!raw) return defaultDateRange()
    const parsed = JSON.parse(raw)
    if (typeof parsed?.from === 'string' && typeof parsed?.to === 'string') return parsed
  } catch { /* fall through */ }
  return defaultDateRange()
}

const TEAL      = '#0f6e56'
const TEXT      = '#111827'
const TEXT_SOFT = '#4b5563'
const BORDER    = '#e5e7eb'
const DANGER    = '#b91c1c'

const SAME_DAY_WINDOW_MS = 24 * 60 * 60 * 1000

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Tri-state form value for nullable booleans: '' | 'Y' | 'N'. */
type Tri = '' | 'Y' | 'N'
function triToBool(t: Tri): boolean | null {
  if (t === 'Y') return true
  if (t === 'N') return false
  return null
}
function boolToTri(b: boolean | null | undefined): Tri {
  if (b === true)  return 'Y'
  if (b === false) return 'N'
  return ''
}

interface FormState {
  date_logged:              string
  clinic_id:                ClinicId | ''
  clinician_id:             string
  front_staff_name:         FrontStaffName | ''  // CLINICIAN dropdown only
  patient_name:             string
  treatment_plan_provided:  Tri
  case_recommendations:     string  // controlled input — kept as string
  appointments_booked:      string
  prepay_offered:           Tri
  prepay_accepted:          Tri
  transition_notes:         string
  notes:                    string
}

function emptyForm(currentUser: User): FormState {
  // CLINICIAN + FRONT_DESK_GLOBAL pick clinic per entry (clinicians rotate
  // between sites); FRONT_DESK is pinned to scope by the server.
  const picksClinic =
    currentUser.role === 'FRONT_DESK_GLOBAL' || currentUser.role === 'CLINICIAN'
  return {
    date_logged:             todayISO(),
    clinic_id:               picksClinic
                               ? ''
                               : (currentUser.clinic_id ?? '') as ClinicId | '',
    clinician_id:            currentUser.role === 'CLINICIAN' ? currentUser.id : '',
    front_staff_name:        '',
    patient_name:            '',
    treatment_plan_provided: '',
    case_recommendations:    '0',
    appointments_booked:     '0',
    prepay_offered:          '',
    prepay_accepted:         '',
    transition_notes:        '',
    notes:                   '',
  }
}

export default function CaseAcceptanceEntryPage() {
  const { user } = useAuthStore()
  if (!user) return null

  const isReceptionist    = user.role === 'FRONT_DESK' || user.role === 'FRONT_DESK_GLOBAL'
  const isFrontDeskGlobal = user.role === 'FRONT_DESK_GLOBAL'
  const isClinician       = user.role === 'CLINICIAN'
  // CLINICIAN + FRONT_DESK_GLOBAL pick the entry's clinic per-entry. ADMIN
  // can only edit; the clinic pre-loads from the row.
  const picksClinic       = isClinician || isFrontDeskGlobal || user.role === 'ADMIN'

  const [rows,    setRows]    = useState<CaseAcceptanceDTO[]>([])
  const [total,   setTotal]   = useState(0)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  const [limit,  setLimit]  = useState(50)
  const [offset, setOffset] = useState(0)

  const [searchInput, setSearchInput] = useState('')
  const search = useDebouncedValue(searchInput.trim(), 300)

  const [dateRange, setDateRange] = useState<DateRangeValue>(() => loadPersistedRange())
  useEffect(() => {
    try { localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(dateRange)) } catch { /* quota or private mode — ignore */ }
  }, [dateRange])

  const [summary, setSummary] = useState<CaseAcceptanceSummary | null>(null)
  const [exporting, setExporting] = useState(false)
  const [clinicianFilter, setClinicianFilter] = useState('')

  useEffect(() => { setOffset(0) }, [search, limit, dateRange, clinicianFilter])

  // Filter object reused across list / summary / export — keeps the table,
  // cards, and downloaded file always agreeing.
  const filter = useMemo(() => ({
    date_from:    dateRange.from,
    date_to:      dateRange.to,
    clinician_id: clinicianFilter || undefined,
  }), [dateRange, clinicianFilter])

  const [clinicians, setClinicians] = useState<User[]>([])

  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm(user))
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [listRes, summaryRes] = await Promise.all([
        caseAcceptanceApi.list({
          ...filter,
          limit, offset,
          search: search || undefined,
        }),
        caseAcceptanceApi.summary({
          ...filter,
          search: search || undefined,
        }),
      ])
      setRows(listRes.data)
      setTotal(listRes.pagination.total)
      setSummary(summaryRes)
    } catch (e: any) {
      setError(e.response?.data?.error?.message || 'Failed to load entries')
    } finally { setLoading(false) }
  }, [filter, limit, offset, search])

  useEffect(() => { load() }, [load])

  const onExport = async () => {
    if (exporting) return
    setExporting(true)
    try {
      await caseAcceptanceApi.exportXlsx({
        ...filter,
        search: search || undefined,
      })
      toast.success('Export downloaded')
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || 'Export failed')
    } finally { setExporting(false) }
  }

  // Clinician dropdown shows every active clinician cross-clinic — physios
  // rotate between sites. Fetched once on mount; clinic choice doesn't gate
  // which names are visible.
  useEffect(() => {
    usersApi.staff('CLINICIAN').then(setClinicians).catch(() => {})
  }, [])

  const startEdit = (row: CaseAcceptanceDTO) => {
    setEditingId(row.id)
    setForm({
      date_logged:             row.date_logged,
      clinic_id:               row.clinic_id,
      clinician_id:            row.clinician_id,
      front_staff_name:        (FRONT_STAFF_NAMES as readonly string[]).includes(row.front_staff_name ?? '')
                                 ? (row.front_staff_name as FrontStaffName)
                                 : '',
      patient_name:            row.patient_name,
      treatment_plan_provided: boolToTri(row.treatment_plan_provided),
      case_recommendations:    String(row.case_recommendations),
      appointments_booked:     String(row.appointments_booked),
      prepay_offered:          boolToTri(row.prepay_offered),
      prepay_accepted:         boolToTri(row.prepay_accepted),
      transition_notes:        row.transition_notes ?? '',
      notes:                   row.notes ?? '',
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setForm(emptyForm(user))
  }

  const onSubmit = async () => {
    setError('')

    if (picksClinic && !form.clinic_id)        return setError('Clinic is required')
    if (!form.patient_name.trim())             return setError('Patient name is required')
    if (!form.clinician_id)                    return setError('Clinician is required')

    const recs   = parseInt(form.case_recommendations, 10)
    const booked = parseInt(form.appointments_booked,  10)
    if (!Number.isFinite(recs)   || recs   < 0) return setError('Case recommendations must be a non-negative integer')
    if (!Number.isFinite(booked) || booked < 0) return setError('Appointments booked must be a non-negative integer')
    if (booked > recs)                          return setError('Booked cannot exceed case recommendations')

    setSaving(true)
    const patientName = form.patient_name.trim()
    try {
      const frontStaff = isReceptionist
        ? undefined
        : (form.front_staff_name || null)

      const shared = {
        date_logged:             form.date_logged,
        clinician_id:            form.clinician_id,
        ...(frontStaff !== undefined ? { front_staff_name: frontStaff } : {}),
        patient_name:            patientName,
        treatment_plan_provided: triToBool(form.treatment_plan_provided),
        case_recommendations:    recs,
        appointments_booked:     booked,
        prepay_offered:          triToBool(form.prepay_offered),
        prepay_accepted:         triToBool(form.prepay_accepted),
        transition_notes:        form.transition_notes.trim() || null,
        notes:                   form.notes.trim() || null,
      }

      if (editingId) {
        const patch: UpdateCaseAcceptancePayload = shared
        await caseAcceptanceApi.update(editingId, patch)
        toast.success(`Updated case entry for ${patientName}`)
      } else {
        const payload: CreateCaseAcceptancePayload = {
          ...shared,
          // CLINICIAN + FRONT_DESK_GLOBAL pick clinic per entry. FRONT_DESK
          // is pinned by scope server-side.
          ...((isClinician || isFrontDeskGlobal) ? { clinic_id: form.clinic_id as ClinicId } : {}),
        }
        await caseAcceptanceApi.create(payload)
        toast.success(`Added case entry for ${patientName}`)
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

  const onDelete = async (row: CaseAcceptanceDTO) => {
    const ok = await confirmDialog.destructive({
      title:        'Delete case entry?',
      message:      `Patient: ${row.patient_name}\nLogged: ${row.date_logged}\n\nThis cannot be undone.`,
      confirmLabel: 'Delete entry',
    })
    if (!ok) return
    try {
      await caseAcceptanceApi.remove(row.id)
      toast.success(`Deleted case entry for ${row.patient_name}`)
      await load()
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || 'Failed to delete')
    }
  }

  const isEditable = (row: CaseAcceptanceDTO) => {
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
    <AppShell title="Daily Case Recommendation & Acceptance Tracker">
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
            <span>{editingId ? 'Editing entry' : 'New case entry'}</span>
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

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* ── Row 1: Date / Clinic / Clinician ── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <Field label="Date">
                <input type="date" value={form.date_logged}
                  onChange={e => setForm({ ...form, date_logged: e.target.value })}
                  style={inputStyle} />
              </Field>

              {picksClinic ? (
                <Field label="Clinic">
                  <select value={form.clinic_id}
                    onChange={e => setForm({ ...form, clinic_id: e.target.value as ClinicId | '' })}
                    disabled={editingId !== null}
                    style={{ ...inputStyle, ...(editingId ? { background: '#f9fafb' } : {}) }}>
                    <option value="">— Select clinic —</option>
                    {CLINIC_OPTIONS.map(c => (
                      <option key={c} value={c}>{CLINIC_LABEL[c]}</option>
                    ))}
                  </select>
                </Field>
              ) : <div />}

              {isClinician ? (
                <Field label="Clinician">
                  <input value={user.full_name || user.email} disabled style={{ ...inputStyle, background: '#f9fafb' }} />
                </Field>
              ) : (
                <Field label="Clinician">
                  <select value={form.clinician_id}
                    onChange={e => setForm({ ...form, clinician_id: e.target.value })}
                    style={inputStyle}>
                    <option value="">— Select clinician —</option>
                    {clinicians.map(c => (
                      <option key={c.id} value={c.id}>{c.full_name || c.email}</option>
                    ))}
                  </select>
                </Field>
              )}
            </div>

            {/* ── Row 2: Front staff / Patient name ── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
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
                  placeholder="e.g. Andrew Hicks"
                  style={inputStyle} />
              </Field>

              <div />
            </div>

            {/* ── Row 3: TP provided / Case recommendations / Appointments booked ── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <Field label="Treatment plan provided">
                <TriSelect value={form.treatment_plan_provided}
                  onChange={v => setForm({ ...form, treatment_plan_provided: v })} />
              </Field>

              <Field label="Case recommendations">
                <input type="number" min={0} max={1000} value={form.case_recommendations}
                  onChange={e => setForm({ ...form, case_recommendations: e.target.value })}
                  style={inputStyle} />
              </Field>

              <Field label="Appointments booked">
                <input type="number" min={0} max={1000} value={form.appointments_booked}
                  onChange={e => setForm({ ...form, appointments_booked: e.target.value })}
                  style={inputStyle} />
              </Field>
            </div>

            {/* ── Row 4: Prepay offered / Prepay accepted ── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <Field label="Prepay offered">
                <TriSelect value={form.prepay_offered}
                  onChange={v => setForm({ ...form, prepay_offered: v })} />
              </Field>

              <Field label="Prepay accepted">
                <TriSelect value={form.prepay_accepted}
                  onChange={v => setForm({ ...form, prepay_accepted: v })} />
              </Field>

              <div />
            </div>

            {/* ── Row 5: Transition notes / Notes ── */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
              <Field label="Transition (TP explained / objections)">
                <textarea value={form.transition_notes}
                  onChange={e => setForm({ ...form, transition_notes: e.target.value })}
                  rows={3}
                  placeholder="What was explained, any objections…"
                  style={{ ...inputStyle, resize: 'vertical', minHeight: 60 }} />
              </Field>

              <Field label="Notes (if not booked all appts, why?)">
                <textarea value={form.notes}
                  onChange={e => setForm({ ...form, notes: e.target.value })}
                  rows={3}
                  placeholder="Anything worth noting…"
                  style={{ ...inputStyle, resize: 'vertical', minHeight: 60 }} />
              </Field>
            </div>

          </div>

          <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={onSubmit} disabled={saving} style={primaryBtnStyle}>
              {saving ? 'Saving…' : editingId ? 'Update entry' : 'Add entry'}
            </button>
          </div>
        </div>
        )}

        {/* Summary cards — always visible, scoped to the active filter */}
        <SummaryCards summary={summary} />

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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <DateRangePicker value={dateRange} onChange={setDateRange} />
              <select
                value={clinicianFilter}
                onChange={e => setClinicianFilter(e.target.value)}
                style={{ ...inputStyle, width: 'auto', minWidth: 160, fontSize: 12, padding: '7px 10px' }}
              >
                <option value="">All Clinicians</option>
                {clinicians.map(c => (
                  <option key={c.id} value={c.id}>{c.full_name}</option>
                ))}
              </select>
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
                disabled={exporting || loading || total === 0}
                title={total === 0 ? 'No entries to export' : 'Download XLSX of current filter'}
                style={{
                  ...smallBtnStyle,
                  padding: '8px 14px', fontSize: 12, fontWeight: 600,
                  background: exporting || loading || total === 0 ? '#f3f4f6' : TEAL,
                  color: exporting || loading || total === 0 ? TEXT_SOFT : '#fff',
                  borderColor: exporting || loading || total === 0 ? BORDER : TEAL,
                  cursor: exporting || loading || total === 0 ? 'not-allowed' : 'pointer',
                }}
              >{exporting ? 'Exporting…' : '↓ Export XLSX'}</button>
            </div>
          </div>

          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
              No entries yet. Add your first case above.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 1300 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    <Th>Date</Th>
                    {isFrontDeskGlobal && <Th>Clinic</Th>}
                    <Th>Front of staff</Th>
                    <Th>Clinician</Th>
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
                  {rows.map(r => (
                    <tr key={r.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                      <Td>{r.date_logged}</Td>
                      {isFrontDeskGlobal && <Td>{CLINIC_LABEL[r.clinic_id]}</Td>}
                      <Td>{r.front_staff_name || <Dim>—</Dim>}</Td>
                      <Td>{r.clinician_name || <Dim>—</Dim>}</Td>
                      <Td><strong>{r.patient_name}</strong></Td>
                      <Td align="center"><YnPill v={r.treatment_plan_provided} /></Td>
                      <Td align="right">{r.case_recommendations}</Td>
                      <Td align="right">{r.appointments_booked}</Td>
                      <Td align="right">{r.case_acceptance_pct === null ? <Dim>—</Dim> : `${r.case_acceptance_pct.toFixed(2)}%`}</Td>
                      <Td align="center"><YnPill v={r.prepay_offered ?? false} /></Td>
                      <Td align="center"><YnPill v={r.prepay_accepted} /></Td>
                      <Td><span style={{ color: TEXT_SOFT }}>{r.transition_notes || <Dim>—</Dim>}</span></Td>
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

function pct(n: number, d: number): string {
  if (d <= 0) return '0'
  return ((n / d) * 100).toFixed(1)
}

function SummaryCards({ summary }: { summary: CaseAcceptanceSummary | null }) {
  const loaded = summary !== null
  const cards: { label: string; value: string; sub?: string; highlight?: boolean }[] = loaded ? [
    {
      label:     'Entries',
      value:     summary!.total.toLocaleString(),
      highlight: true,
    },
    {
      label: 'Recs',
      value: summary!.totalRecommendations.toLocaleString(),
      sub:   summary!.totalRecommendations > 0
               ? `${pct(summary!.totalBooked, summary!.totalRecommendations)}% booked`
               : '',
    },
    {
      label: 'Booked',
      value: summary!.totalBooked.toLocaleString(),
      sub:   summary!.caseAcceptancePct !== null
               ? `${summary!.caseAcceptancePct.toFixed(1)}% acceptance`
               : '',
    },
    {
      label: 'Acceptance',
      value: summary!.caseAcceptancePct === null ? '—' : `${summary!.caseAcceptancePct.toFixed(1)}%`,
      sub:   `${summary!.totalBooked.toLocaleString()} / ${summary!.totalRecommendations.toLocaleString()}`,
    },
    {
      label: 'Prepay offered',
      value: summary!.prepayOffered.toLocaleString(),
      sub:   summary!.total > 0
               ? `${pct(summary!.prepayOffered, summary!.total)}% of entries`
               : '—',
    },
    {
      label: 'Prepay accepted',
      value: summary!.prepayAccepted.toLocaleString(),
      sub:   summary!.prepayOffered > 0
               ? `${pct(summary!.prepayAccepted, summary!.prepayOffered)}% of offers`
               : 'No offers yet',
    },
  ] : [
    { label: 'Entries',          value: '—', highlight: true },
    { label: 'Recs',             value: '—' },
    { label: 'Booked',           value: '—' },
    { label: 'Acceptance',       value: '—' },
    { label: 'Prepay offered',   value: '—' },
    { label: 'Prepay accepted',  value: '—' },
  ]
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12,
      marginBottom: 16,
    }}>
      {cards.map((c) => (
        <div key={c.label} style={{
          background: c.highlight ? '#f0faf7' : '#fff',
          border: `1px solid ${c.highlight ? '#cdebde' : BORDER}`,
          borderRadius: 10,
          padding: '14px 18px',
        }}>
          <div style={{ fontSize: 11, color: TEXT_SOFT, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {c.label}
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, color: c.highlight ? TEAL : TEXT, marginTop: 4, fontFamily: "'DM Sans', sans-serif" }}>
            {c.value}
          </div>
          {c.sub && (
            <div style={{ fontSize: 12, color: TEXT_SOFT, marginTop: 2 }}>{c.sub}</div>
          )}
        </div>
      ))}
    </div>
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
function TriSelect({ value, onChange }: { value: Tri; onChange: (v: Tri) => void }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value as Tri)} style={inputStyle}>
      <option value="">—</option>
      <option value="Y">Yes</option>
      <option value="N">No</option>
    </select>
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
function Dim({ children }: { children: React.ReactNode }) {
  return <span style={{ color: '#9ca3af' }}>{children}</span>
}

function YnPill({ v }: { v: boolean | null }) {
  if (v === null || v === undefined) return <Dim>—</Dim>
  const yes = v === true
  return (
    <span style={{
      background:   yes ? '#ecfdf5' : '#fef2f2',
      color:        yes ? '#065f46' : '#991b1b',
      border: `1px solid ${yes ? '#a7f3d0' : '#fecaca'}`,
      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
    }}>{yes ? 'YES' : 'NO'}</span>
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
