import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import {
  caseAcceptanceApi,
  CreateCaseAcceptancePayload, UpdateCaseAcceptancePayload,
  CaseAcceptanceSummary,
} from '../../api/caseAcceptance.api'
import { draftsApi, DraftDTO } from '../../api/drafts.api'
import { deleteRequestsApi } from '../../api/deleteRequests.api'
import { editRequestsApi } from '../../api/editRequests.api'
import { usersApi } from '../../api/users.api'
import {
  CaseAcceptanceDTO,
  FRONT_STAFF_NAMES, FrontStaffName,
  User, CLINIC_LABEL, ClinicId,
} from '../../types'

const CLINIC_OPTIONS: ClinicId[] = ['newport', 'narrabeen', 'brookvale']
import { useAuthStore } from '../../store/auth.store'
import { useDraftResumeStore } from '../../store/draftResume.store'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/confirm.store'
import { promptDialog } from '../../store/prompt.store'
import AppShell from '../shared/AppShell'
import Pagination from '../shared/Pagination'
import DraftsPanel from '../shared/DraftsPanel'
import DraftBlockerModal from '../shared/DraftBlockerModal'
import DateRangePicker, { DateRangeValue } from '../shared/DateRangePicker'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { usePaginationParams } from '../../hooks/usePaginationParams'

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

  const { limit, offset, setOffset, setLimit, resetPage } = usePaginationParams()

  const [searchInput, setSearchInput] = useState('')
  const search = useDebouncedValue(searchInput.trim(), 300)

  const [dateRange, setDateRange] = useState<DateRangeValue>(() => loadPersistedRange())
  useEffect(() => {
    try { localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(dateRange)) } catch { /* quota or private mode — ignore */ }
  }, [dateRange])

  const [summary, setSummary] = useState<CaseAcceptanceSummary | null>(null)
  const [exporting, setExporting] = useState(false)
  const [clinicianFilter, setClinicianFilter] = useState('')

  useEffect(() => { resetPage() }, [search, dateRange, clinicianFilter, resetPage])

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

  // Saved drafts (this user's own, server-side so they survive logout). ADMIN
  // can't create entries, so drafts don't apply to them.
  const isAdmin = user.role === 'ADMIN'
  const [activeTab, setActiveTab] = useState<'encode' | 'entries'>('encode')
  const [drafts, setDrafts] = useState<DraftDTO<FormState>[]>([])
  // The draft currently loaded into the form (null = composing a fresh entry).
  const [draftId, setDraftId] = useState<string | null>(null)
  const [savingDraft, setSavingDraft] = useState(false)
  const [showDraftBlocker, setShowDraftBlocker] = useState(false)

  const reloadDrafts = useCallback(async () => {
    if (isAdmin) return
    try { setDrafts(await draftsApi.list<FormState>('case_acceptance')) }
    catch { /* drafts are a convenience — never block the page on them */ }
  }, [isAdmin])
  useEffect(() => { reloadDrafts() }, [reloadDrafts])

  // Entry ids this user already has a pending delete request for — swaps the
  // Delete button for a "Delete requested" badge. (ADMIN deletes directly.)
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(new Set())
  const reloadPending = useCallback(async () => {
    if (isAdmin) return
    try {
      const refs = await deleteRequestsApi.mine()
      setPendingDeletes(new Set(refs.filter(r => r.entity_type === 'case_acceptance').map(r => r.entity_id)))
    } catch { /* non-fatal */ }
  }, [isAdmin])
  useEffect(() => { reloadPending() }, [reloadPending])

  // Entry ids this user already has a pending EDIT request for — swaps the
  // Edit button for an "Edit pending" badge. (ADMIN edits directly.)
  const [pendingEdits, setPendingEdits] = useState<Set<string>>(new Set())
  const reloadPendingEdits = useCallback(async () => {
    if (isAdmin) return
    try {
      const refs = await editRequestsApi.mine()
      setPendingEdits(new Set(refs.filter(r => r.entity_type === 'case_acceptance').map(r => r.entity_id)))
    } catch { /* non-fatal */ }
  }, [isAdmin])
  useEffect(() => { reloadPendingEdits() }, [reloadPendingEdits])

  // Recently rejected edit requests — shown as dismissible banners.
  const [rejectedEdits, setRejectedEdits] = useState<import('../../api/editRequests.api').EditRequestDTO[]>([])
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('pw:edit-rejected:dismissed') || '[]')) }
    catch { return new Set() }
  })
  useEffect(() => {
    if (isAdmin) return
    editRequestsApi.myRejected().then(list => {
      // One banner per entry — keep only the latest rejection (list arrives
      // newest-first). Repeated rejections of the same entry used to stack
      // as duplicate banners.
      const latestPerEntity = new Map<string, typeof list[number]>()
      for (const r of list.filter(x => x.entity_type === 'case_acceptance')) {
        if (!latestPerEntity.has(r.entity_id)) latestPerEntity.set(r.entity_id, r)
      }
      setRejectedEdits([...latestPerEntity.values()])
    }).catch(() => {})
  }, [isAdmin])
  const dismissRejected = (id: string) => {
    const next = new Set(dismissedIds).add(id)
    setDismissedIds(next)
    try { localStorage.setItem('pw:edit-rejected:dismissed', JSON.stringify([...next])) } catch { /* quota */ }
  }
  const visibleRejections = rejectedEdits.filter(r => !dismissedIds.has(r.id))

  // Original row being edited — used to compute the diff patch for edit requests.
  const editingRowRef = useRef<CaseAcceptanceDTO | null>(null)

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
    editingRowRef.current = row
    setEditingId(row.id)
    setDraftId(null)  // editing a real entry is unrelated to drafts
    if (isClinician) setActiveTab('encode')
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
    editingRowRef.current = null
    setEditingId(null)
    setDraftId(null)
    setForm(emptyForm(user))
    if (isClinician) setActiveTab('entries')
  }

  // Save the current form as a draft (create the first time, overwrite after).
  // Drafts are only for fresh entries — never while editing an existing row.
  const onSaveDraft = async () => {
    setError('')
    // A draft still needs the core identifying fields — the rest (incl. notes)
    // may be left for later. Stops an empty/half-blank draft from being saved.
    if (picksClinic && !form.clinic_id) return setError('Clinic is required')
    if (!form.patient_name.trim())      return setError('Patient name is required')
    setSavingDraft(true)
    try {
      const meta = {
        clinic_id:    form.clinic_id || null,
        patient_name: form.patient_name.trim() || null,
        form_data:    form,
      }
      if (draftId) {
        await draftsApi.update<FormState>(draftId, meta)
        toast.success('Draft updated')
      } else {
        const created = await draftsApi.create<FormState>({ kind: 'case_acceptance', ...meta })
        setDraftId(created.id)
        toast.success('Draft saved — finish it anytime, even after logging out')
      }
      await reloadDrafts()
    } catch (e: any) {
      const msg = e.response?.data?.error?.message || 'Failed to save draft'
      setError(msg); toast.error(msg)
    } finally { setSavingDraft(false) }
  }

  // Load a saved draft back into the form. Merge over emptyForm so any field
  // added since the draft was saved still has a sane default.
  const resumeDraft = (d: DraftDTO<FormState>) => {
    setEditingId(null)
    setForm({ ...emptyForm(user), ...d.form_data })
    setDraftId(d.id)
    if (isClinician) setActiveTab('encode')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const deleteDraft = async (d: DraftDTO<FormState>) => {
    try {
      await draftsApi.remove(d.id)
      if (draftId === d.id) { setDraftId(null); setForm(emptyForm(user)) }
      await reloadDrafts()
      toast.success('Draft deleted')
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || 'Failed to delete draft')
    }
  }

  // "Resume" from the My Drafts tab hands the draft off via the store — load it
  // into the form once on arrival, then clear the hand-off.
  const { pending, clear: clearPending } = useDraftResumeStore()
  useEffect(() => {
    if (pending && pending.kind === 'case_acceptance') {
      resumeDraft(pending as unknown as DraftDTO<FormState>)
      clearPending()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  const onSubmit = async () => {
    setError('')

    // Block new entry creation when unfinished drafts exist and the user is
    // NOT currently resuming one of them.
    if (!editingId && !draftId && drafts.length > 0) {
      setShowDraftBlocker(true)
      return
    }

    if (picksClinic && !form.clinic_id)        return setError('Clinic is required')
    if (!form.patient_name.trim())             return setError('Patient name is required')
    if (!form.clinician_id)                    return setError('Clinician is required')
    if (!isReceptionist && !form.front_staff_name)
                                               return setError('Front of staff name is required')
    if (!form.transition_notes.trim())         return setError('Transition notes are required — explain what was discussed and any objections')

    const recs   = parseInt(form.case_recommendations, 10)
    const booked = parseInt(form.appointments_booked,  10)
    if (!Number.isFinite(recs)   || recs   < 0) return setError('Case recommendations must be a non-negative integer')
    if (!Number.isFinite(booked) || booked < 0) return setError('Appointments booked must be a non-negative integer')
    if (booked > recs)                          return setError('Booked cannot exceed case recommendations')

    // New entry with a patient name that already exists → warn, don't block.
    // It can legitimately be the same client with a new case.
    if (!editingId) {
      const name = form.patient_name.trim()
      let dupes: CaseAcceptanceDTO[] = []
      try {
        const res = await caseAcceptanceApi.list({ search: name, limit: 50 })
        dupes = res.data.filter(d => d.patient_name.trim().toLowerCase() === name.toLowerCase())
      } catch { /* best-effort — never block saving because the check failed */ }
      if (dupes.length > 0) {
        const latest = dupes.map(d => d.date_logged).sort().slice(-1)[0]
        const ok = await confirmDialog.ask({
          title:        'Same patient name already logged',
          message:      `"${name}" already has ${dupes.length === 1 ? 'a case entry' : `${dupes.length} case entries`} (latest: ${latest}).\n\nIf this is the same client with a new case, adding another entry is fine. Add this entry?`,
          confirmLabel: 'Yes, add entry',
          cancelLabel:  'Cancel',
        })
        if (!ok) return
      }
    }

    // Non-admin editing an existing row → submit an edit request for admin approval.
    if (editingId && !isAdmin) {
      const reason = await promptDialog.ask({
        title:        'Why are you editing this entry?',
        message:      `Patient: ${form.patient_name.trim()}\n\nProvide a reason so the admin can review and approve your changes.`,
        placeholder:  'e.g. Wrong patient name, incorrect date, updated treatment notes…',
        confirmLabel: 'Submit for approval',
      })
      if (reason === null) return  // user cancelled

      setSaving(true)
      try {
        // Build a diff patch — only include fields that actually changed.
        const original = editingRowRef.current!
        const patch: Record<string, unknown> = {}

        const patient    = form.patient_name.trim()
        const transition = form.transition_notes.trim() || null
        const notes      = form.notes.trim() || null
        const tp  = triToBool(form.treatment_plan_provided)
        const po  = triToBool(form.prepay_offered)
        const pa  = triToBool(form.prepay_accepted)
        const frontStaff = isReceptionist ? undefined : (form.front_staff_name || null)

        if (!isReceptionist && frontStaff !== original.front_staff_name)
          patch.front_staff_name = frontStaff
        if (form.clinician_id !== original.clinician_id)
          patch.clinician_id = form.clinician_id
        if (patient !== original.patient_name)
          patch.patient_name = patient
        if (form.date_logged !== original.date_logged)
          patch.date_logged = form.date_logged
        if (tp !== original.treatment_plan_provided)
          patch.treatment_plan_provided = tp
        if (recs !== original.case_recommendations)
          patch.case_recommendations = recs
        if (booked !== original.appointments_booked)
          patch.appointments_booked = booked
        if (po !== original.prepay_offered)
          patch.prepay_offered = po
        if (pa !== original.prepay_accepted)
          patch.prepay_accepted = pa
        if (transition !== original.transition_notes)
          patch.transition_notes = transition
        if (notes !== original.notes)
          patch.notes = notes

        if (Object.keys(patch).length === 0) {
          setSaving(false)
          return setError('No changes detected — edit something before submitting')
        }

        await editRequestsApi.create({
          entity_type: 'case_acceptance',
          entity_id:   editingId,
          reason:      reason.trim() || 'No reason provided',
          patch,
        })
        toast.success(`Edit request submitted — waiting for admin approval`)
        cancelEdit()
        await load()
        await reloadPendingEdits()
      } catch (e: any) {
        const msg = e.response?.data?.error?.message || 'Failed to submit edit request'
        setError(msg); toast.error(msg)
      } finally { setSaving(false) }
      return
    }

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
        // Only ADMIN reaches here (non-admin was handled above).
        const patch: UpdateCaseAcceptancePayload = shared
        await caseAcceptanceApi.update(editingId, patch)
        toast.success(`Updated case entry for ${patientName}`)
      } else {
        const payload: CreateCaseAcceptancePayload = {
          ...shared,
          ...((isClinician || isFrontDeskGlobal) ? { clinic_id: form.clinic_id as ClinicId } : {}),
        }
        await caseAcceptanceApi.create(payload)
        toast.success(`Added case entry for ${patientName}`)
      }
      if (!editingId && draftId) {
        try { await draftsApi.remove(draftId) } catch { /* best-effort cleanup */ }
      }
      cancelEdit()
      await load()
      await reloadDrafts()
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

  // Non-admin asks an admin to delete their own entry (no direct delete).
  const onRequestDelete = async (row: CaseAcceptanceDTO) => {
    const reason = await promptDialog.ask({
      title:        'Request entry deletion',
      message:      `Patient: ${row.patient_name}\nLogged: ${row.date_logged}\n\nThis will be sent to an admin for approval. You may add a reason.`,
      placeholder:  'Reason (optional)',
      confirmLabel: 'Send request',
    })
    if (reason === null) return // cancelled
    try {
      await deleteRequestsApi.create({ entity_type: 'case_acceptance', entity_id: row.id, reason: reason || null })
      toast.success('Delete request sent — waiting for admin approval')
      await reloadPending()
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || 'Failed to send delete request')
    }
  }

  const isEditable = (row: CaseAcceptanceDTO) => {
    if (user.role === 'ADMIN') return true
    // Clinician can act on entries where they are the clinician on the record
    // (covers imports and entries made by front desk on their behalf),
    // OR entries they personally submitted.
    if (user.role === 'CLINICIAN') return row.clinician_id === user.id || row.entered_by === user.id
    return row.entered_by === user.id
  }

  // ADMINs are blocked from creating entries (backend enforces). Show the
  // form only when editing an existing row — never for fresh creation.
  const showCreateForm = user.role !== 'ADMIN' || editingId !== null

  return (
    <AppShell title="Daily Case Recommendation & Acceptance Tracker">
      <div style={{ padding: '20px 28px' }}>
        {isClinician && (
          <SubTabs active={activeTab} total={total} onChange={setActiveTab} />
        )}
        {/* Form card — hidden for ADMINs unless they're editing an existing row */}
        {(!isClinician || activeTab === 'encode') && showCreateForm && (
        <div style={{
          background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10,
          padding: 18, marginBottom: 20,
        }}>
          <div style={{
            fontSize: 14, fontWeight: 600, color: TEXT, marginBottom: 14,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span>
              {editingId && !isAdmin
                ? 'Editing entry — changes will be sent for admin approval'
                : editingId
                  ? 'Editing entry'
                  : draftId
                    ? 'Resuming saved draft'
                    : 'New case entry'}
            </span>
            {(editingId || draftId) && (
              <button onClick={cancelEdit} style={smallBtnStyle}>
                {editingId ? 'Cancel edit' : 'Clear'}
              </button>
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
                <Field label="Front of staff name *">
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
              <Field label="Transition (TP explained / objections) *">
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
                  placeholder="Optional — anything worth noting…"
                  style={{ ...inputStyle, resize: 'vertical', minHeight: 60 }} />
              </Field>
            </div>

          </div>

          <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {/* Save draft is only for new entries — not while editing a real row. */}
            {!editingId && (
              <button
                onClick={onSaveDraft}
                disabled={savingDraft || saving}
                title="Save your progress — the rest can be added later"
                style={{
                  ...draftBtnStyle,
                  ...(savingDraft || saving ? disabledBtnStyle : {}),
                }}
              >
                {savingDraft ? 'Saving…' : draftId ? 'Update draft' : 'Save draft'}
              </button>
            )}
            <button onClick={onSubmit} disabled={saving} style={primaryBtnStyle}>
              {saving
                ? 'Saving…'
                : editingId && !isAdmin
                  ? 'Submit for approval'
                  : editingId
                    ? 'Update entry'
                    : 'Add entry'}
            </button>
          </div>
        </div>
        )}

        {/* Saved drafts — this user's own, resume anytime (even after re-login) */}
        {(!isClinician || activeTab === 'encode') && !isAdmin && (
          <DraftsPanel
            drafts={drafts}
            onResume={resumeDraft}
            onDelete={deleteDraft}
            busy={saving || savingDraft}
          />
        )}

        {/* Rejected edit notifications */}
        {(!isClinician || activeTab === 'entries') && visibleRejections.map(r => (
          <div key={r.id} style={{
            background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 10,
            padding: '12px 16px', marginBottom: 12,
            display: 'flex', alignItems: 'flex-start', gap: 12,
          }}>
            <span style={{ fontSize: 18, lineHeight: 1, marginTop: 1 }}>⚠️</span>
            <div style={{ flex: 1, fontSize: 13 }}>
              <strong style={{ color: '#92400e' }}>Edit request rejected</strong>
              <span style={{ color: '#78350f', marginLeft: 8 }}>
                Patient: {r.patient_name || '—'} · {r.entry_date || '—'}
              </span>
              <div style={{ color: '#92400e', marginTop: 4 }}>
                <strong>Admin reason:</strong> {r.rejection_reason || 'No reason provided'}
              </div>
              <div style={{ color: '#78350f', fontSize: 12, marginTop: 2 }}>
                Your edit reason: {r.reason}
              </div>
            </div>
            <button
              onClick={() => dismissRejected(r.id)}
              title="Dismiss"
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: '#92400e', fontSize: 18, lineHeight: 1, padding: 2, flexShrink: 0,
              }}
            >×</button>
          </div>
        ))}

        {/* Summary cards — always visible, scoped to the active filter */}
        {(!isClinician || activeTab === 'entries') && <SummaryCards summary={summary} />}

        {/* Table */}
        {(!isClinician || activeTab === 'entries') && (
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
                      <Td align="center"><PrepayPill v={r.prepay_offered} /></Td>
                      <Td align="center"><PrepayPill v={r.prepay_accepted} /></Td>
                      <Td><span style={{ color: TEXT_SOFT }}>{r.transition_notes || <Dim>—</Dim>}</span></Td>
                      <Td><span style={{ color: TEXT_SOFT }}>{r.notes || <Dim>—</Dim>}</span></Td>
                      <Td align="right">
                        {isEditable(r) ? (
                          <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end', alignItems: 'center' }}>
                            {isAdmin || !pendingEdits.has(r.id) ? (
                              <ActionBtn
                                label="Edit"
                                variant={isAdmin ? 'primary' : 'outline'}
                                onClick={() => startEdit(r)}
                              />
                            ) : (
                              <StatusChip label="Edit pending" color="blue" title="Your edit is waiting for admin approval" />
                            )}
                            {isAdmin ? (
                              <ActionBtn label="Delete" variant="danger" onClick={() => onDelete(r)} />
                            ) : pendingDeletes.has(r.id) ? (
                              <StatusChip label="Delete requested" color="amber" title="Waiting for admin approval" />
                            ) : (
                              <ActionBtn label="Request delete" variant="danger-ghost" onClick={() => onRequestDelete(r)} />
                            )}
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
              onLimitChange={setLimit}
            />
          )}
        </div>
        )}
      </div>

      {showDraftBlocker && (
        <DraftBlockerModal
          drafts={drafts}
          onResume={(d) => { resumeDraft(d); setShowDraftBlocker(false) }}
          onClose={() => setShowDraftBlocker(false)}
        />
      )}
    </AppShell>
  )
}

function ActionBtn({
  label, variant, onClick,
}: {
  label:   string
  variant: 'primary' | 'outline' | 'danger' | 'danger-ghost'
  onClick: () => void
}) {
  const [hov, setHov] = React.useState(false)
  const base: React.CSSProperties = {
    border: 'none', borderRadius: 6, padding: '4px 11px',
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap',
    transition: 'background 0.13s, color 0.13s, border-color 0.13s',
    display: 'inline-flex', alignItems: 'center',
  }
  const styles: Record<string, React.CSSProperties> = {
    primary:        { ...base, background: hov ? '#0a5a45' : TEAL,  color: '#fff', border: 'none' },
    outline:        { ...base, background: hov ? '#f0faf7' : '#fff', color: TEAL,  border: `1px solid ${hov ? TEAL : '#a7d9c8'}` },
    danger:         { ...base, background: hov ? '#991b1b' : DANGER, color: '#fff', border: 'none' },
    'danger-ghost': { ...base, background: hov ? '#fef2f2' : 'transparent', color: DANGER, border: `1px solid ${hov ? DANGER : '#fca5a5'}` },
  }
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={styles[variant]}
    >{label}</button>
  )
}

function StatusChip({ label, color, title }: { label: string; color: 'blue' | 'amber'; title?: string }) {
  const c = color === 'blue'
    ? { bg: '#eff6ff', fg: '#1d4ed8', bd: '#bfdbfe' }
    : { bg: '#fffbeb', fg: '#92400e', bd: '#fde68a' }
  return (
    <span title={title} style={{
      background: c.bg, color: c.fg, border: `1px solid ${c.bd}`,
      borderRadius: 6, padding: '4px 10px',
      fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
      fontFamily: "'DM Sans', sans-serif",
    }}>{label}</span>
  )
}

function SubTabs({
  active, total, onChange,
}: { active: 'encode' | 'entries'; total: number; onChange: (t: 'encode' | 'entries') => void }) {
  return (
    <div style={{
      display: 'flex', gap: 0, marginBottom: 16,
      borderBottom: '2px solid #e5e7eb',
    }}>
      {(['encode', 'entries'] as const).map(t => {
        const label = t === 'encode' ? 'Encode' : `My Entries (${total.toLocaleString()})`
        const isActive = active === t
        return (
          <button
            key={t}
            onClick={() => onChange(t)}
            style={{
              background: 'transparent', border: 'none',
              borderBottom: isActive ? '2px solid #0f6e56' : '2px solid transparent',
              marginBottom: -2,
              padding: '8px 18px',
              fontSize: 14, fontWeight: isActive ? 700 : 500,
              color: isActive ? '#0f6e56' : '#6b7280',
              cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >{label}</button>
        )
      })}
    </div>
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
      // pct() returns '0' when the denominator is 0, so show a real 0% (counts
      // toward averages) instead of a muted dash when there are no entries.
      sub:   `${pct(summary!.prepayOffered, summary!.total)}% of entries`,
    },
    {
      label: 'Prepay accepted',
      value: summary!.prepayAccepted.toLocaleString(),
      sub:   `${pct(summary!.prepayAccepted, summary!.prepayOffered)}% of offers`,
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

// Prepay columns only: keep YES/NO for a real true/false, but show a muted
// "0" (instead of a blank dash) when the value is empty/not recorded.
function PrepayPill({ v }: { v: boolean | null }) {
  if (v === null || v === undefined) return <Dim>0</Dim>
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
// Secondary action — outlined teal, sits beside the primary "Add entry".
const draftBtnStyle: React.CSSProperties = {
  background: '#fff', color: TEAL, border: `1px solid ${TEAL}`,
  borderRadius: 7, padding: '9px 18px', fontSize: 13, fontWeight: 600,
  cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
}
const disabledBtnStyle: React.CSSProperties = {
  background: '#f3f4f6', color: TEXT_SOFT, borderColor: BORDER, cursor: 'not-allowed',
}
// Shown in place of the delete button once a delete request is pending.
const pendingBadgeStyle: React.CSSProperties = {
  background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a',
  borderRadius: 6, padding: '5px 10px', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap',
}
// Shown in place of the edit button once an edit request is pending.
const pendingEditBadgeStyle: React.CSSProperties = {
  background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe',
  borderRadius: 6, padding: '5px 10px', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap',
}
