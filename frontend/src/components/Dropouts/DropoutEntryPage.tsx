import React, { useEffect, useState, useCallback, useRef } from 'react'
import { dropoutsApi, CreateDropoutPayload, UpdateDropoutPayload, DropoutSummary } from '../../api/dropouts.api'
import { draftsApi, DraftDTO } from '../../api/drafts.api'
import { deleteRequestsApi } from '../../api/deleteRequests.api'
import { editRequestsApi } from '../../api/editRequests.api'
import { usersApi } from '../../api/users.api'
import {
  DropoutDTO, DROPOUT_STATUSES, DROPOUT_REASONS, DropoutStatus, DropoutReason,
  FRONT_STAFF_NAMES, FrontStaffName,
  User, CLINIC_LABEL, ClinicId,
} from '../../types'

const CLINIC_OPTIONS: ClinicId[] = ['newport', 'narrabeen', 'brookvale']
import { useAuthStore } from '../../store/auth.store'
import { useDraftResumeStore } from '../../store/draftResume.store'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/confirm.store'
import { promptDialog } from '../../store/prompt.store'
import { exportDropoutsXlsx } from '../../lib/exportDropoutsXlsx'
import AppShell from '../shared/AppShell'
import Pagination from '../shared/Pagination'
import DateRangePicker from '../shared/DateRangePicker'
import DraftsPanel from '../shared/DraftsPanel'
import DraftBlockerModal from '../shared/DraftBlockerModal'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { usePaginationParams } from '../../hooks/usePaginationParams'

const TEAL      = '#0f6e56'
const TEXT      = '#111827'
const TEXT_SOFT = '#4b5563'
const BORDER    = '#e5e7eb'
const DANGER    = '#b91c1c'

function todayISO(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}
function daysAgoISO(days: number): string {
  const d = new Date(); d.setDate(d.getDate() - days)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
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
  // FRONT_DESK_GLOBAL and CLINICIAN both pick clinic per entry (clinicians
  // rotate between sites, so we don't pre-fill from their primary clinic).
  // FRONT_DESK is pinned to their own clinic by the server.
  const picksClinic =
    currentUser.role === 'FRONT_DESK_GLOBAL' || currentUser.role === 'CLINICIAN'
  return {
    date_logged:                 todayISO(),
    clinic_id:                   picksClinic
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
  const isClinician        = user.role === 'CLINICIAN'
  // CLINICIAN + FRONT_DESK_GLOBAL pick the entry's clinic per-entry. ADMIN
  // can only edit (not create), but the form pre-loads clinic_id from the
  // edited row so they see the dropdown too.
  const picksClinic        = isClinician || isFrontDeskGlobal || user.role === 'ADMIN'

  const [rows,    setRows]    = useState<DropoutDTO[]>([])
  const [total,   setTotal]   = useState(0)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [summary, setSummary] = useState<DropoutSummary>({ total: 0, byStatus: {}, byReason: {}, byClinic: {}, byDay: [] })

  const { limit, offset, setOffset, setLimit, resetPage } = usePaginationParams()

  const [searchInput, setSearchInput] = useState('')
  const search = useDebouncedValue(searchInput.trim(), 300)

  const [dateFrom,       setDateFrom]       = useState(daysAgoISO(30))
  const [dateTo,         setDateTo]         = useState(todayISO())
  const [statusFilter,   setStatusFilter]   = useState<DropoutStatus | ''>('')
  const [reasonFilter,   setReasonFilter]   = useState<DropoutReason | ''>('')
  const [clinicianFilter, setClinicianFilter] = useState('')

  useEffect(() => { resetPage() }, [search, dateFrom, dateTo, statusFilter, reasonFilter, clinicianFilter, resetPage])

  const [clinicians, setClinicians] = useState<User[]>([])

  const isAdmin = user.role === 'ADMIN'
  const [activeTab, setActiveTab] = useState<'encode' | 'entries'>('encode')

  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm(user))
  const [saving, setSaving] = useState(false)

  // Original row being edited — used to compute the diff patch for edit requests.
  const editingRowRef = useRef<DropoutDTO | null>(null)

  // Entry ids this user already has a pending EDIT request for — swaps the
  // Edit button for an "Edit pending" badge. (ADMIN edits directly.)
  const [pendingEdits, setPendingEdits] = useState<Set<string>>(new Set())
  const reloadPendingEdits = useCallback(async () => {
    if (isAdmin) return
    try {
      const refs = await editRequestsApi.mine()
      setPendingEdits(new Set(refs.filter(r => r.entity_type === 'dropout').map(r => r.entity_id)))
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
      for (const r of list.filter(x => x.entity_type === 'dropout')) {
        if (!latestPerEntity.has(r.entity_id)) latestPerEntity.set(r.entity_id, r)
      }
      setRejectedEdits([...latestPerEntity.values()])
    }).catch(() => {})
  }, [isAdmin])
  const dismissRejected = (id: string) => {
    const next = new Set(dismissedIds).add(id)
    setDismissedIds(next)
    try { localStorage.setItem('pw:edit-rejected:dismissed', JSON.stringify([...next])) } catch { /* quota */ }
    // Persist server-side too — localStorage alone brought the banner back on
    // other devices / cleared storage for the whole 30-day window.
    editRequestsApi.ackRejected(id).catch(() => { /* banner already hidden locally */ })
  }
  const visibleRejections = rejectedEdits.filter(r => !dismissedIds.has(r.id))

  // Saved drafts (this user's own, server-side so they survive logout). ADMIN
  // can't create entries, so drafts don't apply to them.
  const [drafts, setDrafts] = useState<DraftDTO<FormState>[]>([])
  // The draft currently loaded into the form (null = composing a fresh entry).
  const [draftId, setDraftId] = useState<string | null>(null)
  const [savingDraft, setSavingDraft] = useState(false)
  const [showDraftBlocker, setShowDraftBlocker] = useState(false)

  const reloadDrafts = useCallback(async () => {
    if (isAdmin) return
    try { setDrafts(await draftsApi.list<FormState>('dropout')) }
    catch { /* drafts are a convenience — never block the page on them */ }
  }, [isAdmin])
  useEffect(() => { reloadDrafts() }, [reloadDrafts])

  // Entry ids this user already has a pending delete request for — used to
  // swap the Delete button for a "Delete requested" badge. (ADMIN deletes
  // directly, so it doesn't apply to them.)
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(new Set())
  const reloadPending = useCallback(async () => {
    if (isAdmin) return
    try {
      const refs = await deleteRequestsApi.mine()
      setPendingDeletes(new Set(refs.filter(r => r.entity_type === 'dropout').map(r => r.entity_id)))
    } catch { /* non-fatal */ }
  }, [isAdmin])
  useEffect(() => { reloadPending() }, [reloadPending])

  const filterParams = {
    date_from:    dateFrom     || undefined,
    date_to:      dateTo       || undefined,
    status:       statusFilter || undefined,
    reason:       reasonFilter || undefined,
    clinician_id: clinicianFilter || undefined,
    search:       search       || undefined,
  }

  // Guards against out-of-order responses: changing a filter while on page ≥ 2
  // fires a stale-offset fetch alongside the reset-to-page-1 fetch, and the
  // slower one used to win, showing an empty table.
  const loadSeq = useRef(0)
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    setLoading(true); setError('')
    try {
      const [res, sum] = await Promise.all([
        dropoutsApi.list({ ...filterParams, limit, offset }),
        dropoutsApi.summary(filterParams),
      ])
      if (seq !== loadSeq.current) return  // superseded by a newer load
      setRows(res.data)
      setTotal(res.pagination.total)
      setSummary(sum)
    } catch (e: any) {
      if (seq === loadSeq.current)
        setError(e.response?.data?.error?.message || 'Failed to load dropouts')
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, statusFilter, reasonFilter, clinicianFilter, search, limit, offset])

  useEffect(() => { load() }, [load])

  // Clinician dropdown shows EVERY active clinician across all clinics —
  // physios rotate between sites, so the picker can't be scoped to one
  // clinic. The fetch happens once on mount; the user's clinic choice
  // doesn't gate which clinicians are visible.
  useEffect(() => {
    usersApi.staff('CLINICIAN').then(setClinicians).catch(() => {})
  }, [])

  const startEdit = (row: DropoutDTO) => {
    editingRowRef.current = row
    setEditingId(row.id)
    setDraftId(null)  // editing a real entry is unrelated to drafts
    setForm({
      date_logged:                 row.date_logged,
      clinic_id:                   row.clinic_id,
      clinician_id:                row.clinician_id,
      // Keep the stored name even when it isn't one of the dropdown options
      // (receptionist entries stamp the account's full name) — coercing it to
      // '' here used to wipe the field on any unrelated edit.
      front_staff_name:            (row.front_staff_name ?? '') as FrontStaffName | '',
      patient_name:                row.patient_name,
      appointment_cancelled_dates: [...row.appointment_cancelled_dates],
      cancel_date_input:           '',
      status:                      row.status ?? '',
      reason:                      row.reason ?? '',
      notes:                       row.notes ?? '',
    })
    if (isClinician) setActiveTab('encode')
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
    editingRowRef.current = null
    setEditingId(null)
    setDraftId(null)
    setForm(emptyForm(user))
    // After finishing/cancelling an edit, send clinician back to entries tab
    // so they can see their list and the Edit/Request Delete buttons again.
    if (isClinician) setActiveTab('entries')
  }

  // Save the current form as a draft (create the first time, overwrite after).
  // Drafts are only for fresh entries — never while editing an existing row.
  const onSaveDraft = async () => {
    setError('')
    // A draft still needs the core fields — only Notes may be left for later.
    // This is what stops an empty/half-blank draft from being saved.
    if (picksClinic && !form.clinic_id) return setError('Clinic is required')
    if (!form.patient_name.trim())      return setError('Patient name is required')
    if (!form.status)                   return setError('Status is required')
    if (!form.reason)                   return setError('Reason is required')
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
        const created = await draftsApi.create<FormState>({ kind: 'dropout', ...meta })
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
    if (pending && pending.kind === 'dropout') {
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
    if (!form.status)                          return setError('Status is required')
    if (!form.reason)                          return setError('Reason is required')

    // A cancellation date typed into the picker but never "+ Add"-ed would
    // otherwise be silently dropped on save — merge it in here.
    const cancelDates =
      form.cancel_date_input && !form.appointment_cancelled_dates.includes(form.cancel_date_input)
        ? [...form.appointment_cancelled_dates, form.cancel_date_input].sort()
        : form.appointment_cancelled_dates

    // New entry with a patient name that already exists → warn, don't block.
    // The same client can legitimately drop out more than once.
    if (!editingId) {
      const name = form.patient_name.trim()
      let dupes: DropoutDTO[] = []
      try {
        const res = await dropoutsApi.list({ search: name, limit: 50 })
        dupes = res.data.filter(d => d.patient_name.trim().toLowerCase() === name.toLowerCase())
      } catch { /* best-effort — never block saving because the check failed */ }
      if (dupes.length > 0) {
        const latest = dupes.map(d => d.date_logged).sort().slice(-1)[0]
        const ok = await confirmDialog.ask({
          title:        'Same patient name already logged',
          message:      `"${name}" already has ${dupes.length === 1 ? 'a dropout entry' : `${dupes.length} dropout entries`} (latest: ${latest}).\n\nIf this is the same client dropping out again, adding another entry is fine. Add this entry?`,
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
        placeholder:  'e.g. Wrong patient name, incorrect date, wrong status…',
        confirmLabel: 'Submit for approval',
      })
      if (reason === null) return  // user cancelled

      setSaving(true)
      try {
        const original = editingRowRef.current!
        const patch: Record<string, unknown> = {}

        const patientName = form.patient_name.trim()
        const notes       = form.notes.trim() || null
        const frontStaff  = isReceptionist ? undefined : (form.front_staff_name || null)

        if (!isReceptionist && frontStaff !== original.front_staff_name)
          patch.front_staff_name = frontStaff
        if (form.clinician_id !== original.clinician_id)
          patch.clinician_id = form.clinician_id
        if (patientName !== original.patient_name)
          patch.patient_name = patientName
        if (form.date_logged !== original.date_logged)
          patch.date_logged = form.date_logged
        // Array comparison — check if sorted lists differ
        const origDates = [...original.appointment_cancelled_dates].sort().join(',')
        const newDates  = [...cancelDates].sort().join(',')
        if (newDates !== origDates)
          patch.appointment_cancelled_dates = cancelDates
        if (form.status && form.status !== original.status)
          patch.status = form.status
        if (form.reason && form.reason !== original.reason)
          patch.reason = form.reason
        // Normalize '' vs null so untouched empty notes don't register as a change.
        if (notes !== (original.notes || null))
          patch.notes = notes

        if (Object.keys(patch).length === 0) {
          setSaving(false)
          return setError('No changes detected — edit something before submitting')
        }

        await editRequestsApi.create({
          entity_type: 'dropout',
          entity_id:   editingId,
          reason:      reason.trim() || 'No reason provided',
          patch,
        })
        toast.success('Edit request submitted — waiting for admin approval')
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
          appointment_cancelled_dates: cancelDates,
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
          // CLINICIAN + FRONT_DESK_GLOBAL pick clinic per entry; FRONT_DESK
          // is pinned server-side from scope.
          ...((isClinician || isFrontDeskGlobal) ? { clinic_id: form.clinic_id as ClinicId } : {}),
          ...(frontStaff !== undefined ? { front_staff_name: frontStaff } : {}),
          patient_name:                patientName,
          appointment_cancelled_dates: cancelDates,
          status:                      form.status as DropoutStatus,
          reason:                      form.reason as DropoutReason,
          notes:                       form.notes.trim() || null,
        }
        await dropoutsApi.create(payload)
        toast.success(`Added dropout entry for ${patientName}`)
      }
      // If this entry was promoted from a saved draft, discard the draft now.
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

  const [exporting, setExporting] = useState(false)
  const onExport = async () => {
    setExporting(true)
    try {
      const PAGE = 500
      const all: DropoutDTO[] = []
      let cursor = 0
      while (true) {
        const res = await dropoutsApi.list({ ...filterParams, limit: PAGE, offset: cursor })
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

  // Non-admin asks an admin to delete their own entry (no direct delete).
  const onRequestDelete = async (row: DropoutDTO) => {
    const reason = await promptDialog.ask({
      title:        'Request entry deletion',
      message:      `Patient: ${row.patient_name}\nLogged: ${row.date_logged}\n\nThis will be sent to an admin for approval. You may add a reason.`,
      placeholder:  'Reason (optional)',
      confirmLabel: 'Send request',
    })
    if (reason === null) return // cancelled
    try {
      await deleteRequestsApi.create({ entity_type: 'dropout', entity_id: row.id, reason: reason || null })
      toast.success('Delete request sent — waiting for admin approval')
      await reloadPending()
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || 'Failed to send delete request')
    }
  }

  const isEditable = (row: DropoutDTO) => {
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
    <AppShell title="Daily Patient Dropout Tracking">
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
                    : 'New dropout entry'}
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

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            <Field label="Date">
              <input type="date" value={form.date_logged}
                onChange={e => setForm({ ...form, date_logged: e.target.value })}
                style={inputStyle} />
            </Field>

            {picksClinic && (
              <Field label="Clinic">
                <select value={form.clinic_id}
                  // On edit, clinic is locked (the audit/scope rules apply to
                  // the entry's original clinic). On create, the picker is
                  // free.
                  onChange={e => setForm({ ...form, clinic_id: e.target.value as ClinicId | '' })}
                  disabled={editingId !== null}
                  style={{ ...inputStyle, ...(editingId ? { background: '#f9fafb' } : {}) }}>
                  <option value="">— Select clinic —</option>
                  {CLINIC_OPTIONS.map(c => (
                    <option key={c} value={c}>{CLINIC_LABEL[c]}</option>
                  ))}
                </select>
              </Field>
            )}

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
                  {/* Stamped names (receptionist full names) aren't in the fixed
                      list — render them so the select shows the stored value. */}
                  {form.front_staff_name && !(FRONT_STAFF_NAMES as readonly string[]).includes(form.front_staff_name) && (
                    <option value={form.front_staff_name}>{form.front_staff_name}</option>
                  )}
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
            {/* Save draft is only for new entries — not while editing a real row. */}
            {!editingId && (
              <button
                onClick={onSaveDraft}
                disabled={savingDraft || saving}
                title="Save your progress — Notes can be added later"
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

        {/* Saved drafts — this user's own, resume anytime (even after re-login) */}
        {(!isClinician || activeTab === 'encode') && !isAdmin && (
          <DraftsPanel
            drafts={drafts}
            onResume={resumeDraft}
            onDelete={deleteDraft}
            busy={saving || savingDraft}
          />
        )}

        {/* Filters */}
        {(!isClinician || activeTab === 'entries') && (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: TEXT_SOFT, fontWeight: 500 }}>Search</span>
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder="Patient name or notes…"
                style={{ ...inputStyle, paddingRight: searchInput ? 26 : 12, minWidth: 220 }}
              />
              {searchInput && (
                <button onClick={() => setSearchInput('')} title="Clear search" style={{
                  position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: '#9ca3af', fontSize: 14, padding: 2,
                }}>×</button>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: TEXT_SOFT, fontWeight: 500 }}>Date range</span>
            <DateRangePicker
              value={{ from: dateFrom, to: dateTo }}
              onChange={r => { setDateFrom(r.from); setDateTo(r.to) }}
              maxRangeDays={366}
            />
          </div>
          {isFrontDeskGlobal && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, color: TEXT_SOFT, fontWeight: 500 }}>Clinician</span>
              <select value={clinicianFilter} onChange={e => setClinicianFilter(e.target.value)} style={inputStyle}>
                <option value="">All Clinicians</option>
                {clinicians.map(c => <option key={c.id} value={c.id}>{c.full_name || c.email}</option>)}
              </select>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: TEXT_SOFT, fontWeight: 500 }}>Status</span>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as DropoutStatus | '')} style={inputStyle}>
              <option value="">All</option>
              {DROPOUT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: TEXT_SOFT, fontWeight: 500 }}>Reason</span>
            <select value={reasonFilter} onChange={e => setReasonFilter(e.target.value as DropoutReason | '')} style={inputStyle}>
              <option value="">All</option>
              {DROPOUT_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>
        )}

        {/* Summary cards */}
        {(!isClinician || activeTab === 'entries') && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10,
          marginBottom: 16,
        }}>
          <SummaryCard label="Total entries"         value={summary.total} highlight />
          <SummaryCard label="Cancelled (no rebook)" value={summary.byStatus['Cancelled - not rescheduled'] ?? 0} />
          <SummaryCard label="No future bookings"    value={summary.byStatus['No Future Bookings'] ?? 0} />
          <SummaryCard label="Re-scheduled"          value={summary.byStatus['Re-scheduled'] ?? 0} />
        </div>
        )}

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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                onClick={onExport}
                disabled={exporting || total === 0}
                style={smallBtnStyle}
                title="Download filtered entries as Excel"
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

function SummaryCard({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div style={{
      background: highlight ? '#f0faf7' : '#fff',
      border: `1px solid ${highlight ? '#cdebde' : BORDER}`,
      borderRadius: 10, padding: '14px 16px',
    }}>
      <div style={{ fontSize: 11, color: TEXT_SOFT, fontWeight: 500, letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: highlight ? TEAL : TEXT, marginTop: 4 }}>{value}</div>
    </div>
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
    primary:        { ...base, background: hov ? '#0a5a45' : TEAL,  color: '#fff',   border: 'none' },
    outline:        { ...base, background: hov ? '#f0faf7' : '#fff', color: TEAL,     border: `1px solid ${hov ? TEAL : '#a7d9c8'}` },
    danger:         { ...base, background: hov ? '#991b1b' : DANGER, color: '#fff',   border: 'none' },
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
