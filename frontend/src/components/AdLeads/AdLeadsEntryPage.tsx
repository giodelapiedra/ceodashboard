import React, { useEffect, useState, useCallback, useRef } from 'react'
import {
  adLeadsApi, CreateAdLeadPayload, UpdateAdLeadPayload, AdLeadSummary,
} from '../../api/adLeads.api'
import { DuplicateReport, OnDuplicate, duplicateReportFromError } from '../../api/duplicates'
import { editRequestsApi, EditRequestDTO } from '../../api/editRequests.api'
import { deleteRequestsApi } from '../../api/deleteRequests.api'
import { AdLeadDTO, AD_LEAD_PLATFORMS, AdLeadPlatform, BELLA_CONTACT_OPTIONS } from '../../types'
import { useAuthStore } from '../../store/auth.store'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/confirm.store'
import { promptDialog } from '../../store/prompt.store'
import { duplicateDialog, DuplicateField } from '../../store/duplicate.store'
import AppShell from '../shared/AppShell'
import Pagination from '../shared/Pagination'
import DateRangePicker from '../shared/DateRangePicker'
import PatientNameInput from '../shared/PatientNameInput'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { usePaginationParams } from '../../hooks/usePaginationParams'

const TEAL      = '#0f6e56'
const TEXT      = '#111827'
const TEXT_SOFT = '#4b5563'
const BORDER    = '#e5e7eb'
const DANGER    = '#b91c1c'

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// One field per visible column in the Meta/Google ADS Leads tab (gayang-gaya).
interface LeadForm {
  patient_name:  string   // Prospective Patient Name
  platform:      AdLeadPlatform | ''  // Platform Source
  campaign_name: string   // Campaign Name
  date_added:    string   // Date Added
  booked:        boolean   // Booked?
  bella_called:  string   // Bella Called?
  bella_sms:     string   // Bella SMS?
  bella_remarks: string   // Bella Remarks
}

/** Placeholder for blank values in the duplicate diff table. */
const DASH = '—'

/**
 * The values that will actually be stored. The natural-key fields (patient,
 * platform, date added, clinic) are identical by definition when we hit a
 * duplicate, so they live in the dialog subtitle — only what can differ here
 * gets a diff row.
 */
interface AdLeadValues {
  campaign_name: string | null
  booked:        boolean
  bella_called:  string | null
  bella_sms:     string | null
  bella_remarks: string | null
}

function adLeadDiffFields(existing: AdLeadDTO, incoming: AdLeadValues): DuplicateField[] {
  return [
    { label: 'Campaign',      existing: existing.campaign_name || DASH, incoming: incoming.campaign_name || DASH },
    { label: 'Booked?',       existing: existing.booked ? 'Yes' : 'No', incoming: incoming.booked ? 'Yes' : 'No' },
    { label: 'Bella called',  existing: existing.bella_called  || DASH, incoming: incoming.bella_called  || DASH },
    { label: 'Bella SMS',     existing: existing.bella_sms     || DASH, incoming: incoming.bella_sms     || DASH },
    { label: 'Bella remarks', existing: existing.bella_remarks || DASH, incoming: incoming.bella_remarks || DASH },
  ]
}

/** Only the fields that actually changed — an edit request should ask the
 *  admin to approve the difference, not re-state the whole row. */
function adLeadPatchFrom(existing: AdLeadDTO, incoming: AdLeadValues): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (incoming.campaign_name !== (existing.campaign_name ?? null)) patch.campaign_name = incoming.campaign_name
  if (incoming.booked        !== existing.booked)                  patch.booked        = incoming.booked
  if (incoming.bella_called  !== (existing.bella_called  ?? null)) patch.bella_called  = incoming.bella_called
  if (incoming.bella_sms     !== (existing.bella_sms     ?? null)) patch.bella_sms     = incoming.bella_sms
  if (incoming.bella_remarks !== (existing.bella_remarks ?? null)) patch.bella_remarks = incoming.bella_remarks
  return patch
}

function emptyForm(): LeadForm {
  return {
    patient_name: '', platform: '', campaign_name: '', date_added: todayISO(),
    booked: false, bella_called: '', bella_sms: '', bella_remarks: '',
  }
}

function formFromRow(row: AdLeadDTO): LeadForm {
  return {
    patient_name:  row.patient_name,
    platform:      (AD_LEAD_PLATFORMS as readonly string[]).includes(row.platform)
                     ? (row.platform as AdLeadPlatform) : AD_LEAD_PLATFORMS[0],
    campaign_name: row.campaign_name ?? '',
    date_added:    row.date_added,
    booked:        row.booked,
    bella_called:  row.bella_called ?? '',
    bella_sms:     row.bella_sms ?? '',
    bella_remarks: row.bella_remarks ?? '',
  }
}

export default function AdLeadsEntryPage() {
  const { user } = useAuthStore()
  if (!user) return null

  const isAdmin = user.role === 'ADMIN'
  // Brookvale-only feature: FRONT_DESK is pinned server-side; everyone else
  // (FRONT_DESK_GLOBAL / ADMIN) sends the clinic explicitly.
  const createClinic = user.role === 'FRONT_DESK' ? undefined : 'brookvale'

  // Tabs (Encode | All Entries) — admin lands on the full view, encoders on Encode.
  const [activeTab, setActiveTab] = useState<'encode' | 'entries'>(isAdmin ? 'entries' : 'encode')

  // ── Form (create / edit) ──
  const [form, setForm]           = useState<LeadForm>(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving]       = useState(false)
  const [formErr, setFormErr]     = useState('')
  const [showFollowUp, setShowFollowUp] = useState(false)
  // Original row being edited — used to compute the diff patch for edit requests.
  const editingRowRef = useRef<AdLeadDTO | null>(null)

  const resetForm = () => {
    editingRowRef.current = null
    setForm(emptyForm()); setEditingId(null); setFormErr(''); setShowFollowUp(false)
  }

  const startEdit = (row: AdLeadDTO) => {
    editingRowRef.current = row
    setEditingId(row.id); setForm(formFromRow(row)); setFormErr('')
    setShowFollowUp(!!(row.bella_called || row.bella_sms || row.bella_remarks))
    setActiveTab('encode')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // ── Approval-flow state (non-admin only) ──
  // Lead ids this user has an open EDIT request for → swaps Edit for a badge.
  const [pendingEdits, setPendingEdits] = useState<Set<string>>(new Set())
  const reloadPendingEdits = useCallback(async () => {
    if (isAdmin) return
    try {
      const refs = await editRequestsApi.mine()
      setPendingEdits(new Set(refs.filter(r => r.entity_type === 'ad_lead').map(r => r.entity_id)))
    } catch { /* non-fatal */ }
  }, [isAdmin])
  useEffect(() => { reloadPendingEdits() }, [reloadPendingEdits])

  // Lead ids this user has an open DELETE request for → swaps Delete for a badge.
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(new Set())
  const reloadPendingDeletes = useCallback(async () => {
    if (isAdmin) return
    try {
      const refs = await deleteRequestsApi.mine()
      setPendingDeletes(new Set(refs.filter(r => r.entity_type === 'ad_lead').map(r => r.entity_id)))
    } catch { /* non-fatal */ }
  }, [isAdmin])
  useEffect(() => { reloadPendingDeletes() }, [reloadPendingDeletes])

  // Recently rejected edit requests — shown as dismissible banners.
  const [rejectedEdits, setRejectedEdits] = useState<EditRequestDTO[]>([])
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('pw:ad-lead-edit-rejected:dismissed') || '[]')) }
    catch { return new Set() }
  })
  useEffect(() => {
    if (isAdmin) return
    editRequestsApi.myRejected().then(list => {
      // One banner per lead — keep only the latest rejection (list is newest-first).
      const latestPerEntity = new Map<string, EditRequestDTO>()
      for (const r of list.filter(x => x.entity_type === 'ad_lead')) {
        if (!latestPerEntity.has(r.entity_id)) latestPerEntity.set(r.entity_id, r)
      }
      setRejectedEdits([...latestPerEntity.values()])
    }).catch(() => {})
  }, [isAdmin])
  const dismissRejected = (id: string) => {
    const next = new Set(dismissedIds).add(id)
    setDismissedIds(next)
    try { localStorage.setItem('pw:ad-lead-edit-rejected:dismissed', JSON.stringify([...next])) } catch { /* quota */ }
    editRequestsApi.ackRejected(id).catch(() => { /* banner already hidden locally */ })
  }
  const visibleRejections = rejectedEdits.filter(r => !dismissedIds.has(r.id))

  // ── List ──
  const [rows, setRows]       = useState<AdLeadDTO[]>([])
  const [total, setTotal]     = useState(0)
  const [summary, setSummary] = useState<AdLeadSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [listErr, setListErr] = useState('')
  const { limit, offset, setOffset, setLimit, resetPage } = usePaginationParams()
  const [searchInput, setSearchInput] = useState('')
  const search = useDebouncedValue(searchInput.trim(), 300)
  // Date range is unset by default — leads go back to the first import, so
  // all-time is the useful default view. "All dates" clears back to it.
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [platformFilter, setPlatformFilter] = useState<AdLeadPlatform | ''>('')
  const [bookedFilter, setBookedFilter]     = useState<'' | 'true' | 'false'>('')

  const hasFilters = !!(search || dateFrom || dateTo || platformFilter || bookedFilter)
  const clearFilters = () => {
    setSearchInput(''); setDateFrom(''); setDateTo('')
    setPlatformFilter(''); setBookedFilter('')
  }

  useEffect(() => { resetPage() }, [search, dateFrom, dateTo, platformFilter, bookedFilter, resetPage])

  // Guards against out-of-order responses: changing a filter while on page ≥ 2
  // fires a stale-offset fetch alongside the reset-to-page-1 fetch, and the
  // slower one used to win, showing an empty table.
  const loadSeq = useRef(0)
  const loadEntries = useCallback(async () => {
    const seq = ++loadSeq.current
    setLoading(true); setListErr('')
    try {
      // A name search spans all dates — see the note in DropoutEntryPage.
      const searching = search.length > 0
      const common = {
        search:    search   || undefined,
        date_from: searching ? undefined : (dateFrom || undefined),
        date_to:   searching ? undefined : (dateTo   || undefined),
        platform:  platformFilter || undefined,
        booked:    bookedFilter === '' ? undefined : bookedFilter === 'true',
      }
      const [listRes, sumRes] = await Promise.all([
        adLeadsApi.list({ ...common, limit, offset }),
        adLeadsApi.summary(common),
      ])
      if (seq !== loadSeq.current) return  // superseded by a newer load
      setRows(listRes.data); setTotal(listRes.pagination.total); setSummary(sumRes)
    } catch (e: any) {
      if (seq === loadSeq.current)
        setListErr(e.response?.data?.error?.message || 'Failed to load leads')
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [limit, offset, search, dateFrom, dateTo, platformFilter, bookedFilter])

  useEffect(() => { loadEntries() }, [loadEntries])

  // ── Nookal "total paid" — persisted on the lead rows, MANUAL sync only ──
  // Page loads read the stored nookal_* columns (zero Nookal calls). The Sync
  // button resolves ALL booked leads against Nookal on the server, saves the
  // totals, then this list reloads. Slow by design (~30s for 100+ names).
  const [paidSyncing, setPaidSyncing] = useState(false)
  const syncNookalPaid = async () => {
    setPaidSyncing(true)
    try {
      const s = await adLeadsApi.syncNookalPaid()
      await loadEntries()
      const extras = [
        s.multiple  ? `${s.multiple} multiple matches` : '',
        s.not_found ? `${s.not_found} not in Nookal`   : '',
        s.errors    ? `${s.errors} failed`             : '',
      ].filter(Boolean).join(', ')
      toast.success(`Synced ${s.names} booked patient${s.names === 1 ? '' : 's'} — ${s.matched} matched${extras ? ` (${extras})` : ''}`)
    } catch {
      toast.error('Nookal sync failed — try again')
    } finally { setPaidSyncing(false) }
  }
  const lastSyncedAt = rows.reduce<string | null>(
    (max, r) => (r.nookal_synced_at && (!max || r.nookal_synced_at > max) ? r.nookal_synced_at : max), null)

  /**
   * Show the duplicate dialog for an exact match and turn the answer into the
   * next action:
   *   'allow'     → POST it as a genuinely separate lead
   *   'overwrite' → POST with on_duplicate=overwrite (own lead, or admin)
   *   'handled'   → an edit request was filed instead; nothing left to do
   *   null        → user backed out, save nothing
   */
  const resolveDuplicate = async (
    report:   DuplicateReport<AdLeadDTO>,
    incoming: AdLeadValues
  ): Promise<'allow' | 'overwrite' | 'handled' | null> => {
    const existing = report.exact!
    const owner    = existing.entered_by_name || 'another user'

    const choice = await duplicateDialog.ask({
      title:         'This lead is already logged',
      subtitle:      [existing.patient_name, existing.platform, existing.date_added].join('  ·  '),
      existingMeta:  `Saved by ${owner} on ${new Date(existing.created_at).toLocaleString()}`,
      fields:        adLeadDiffFields(existing, incoming),
      primaryLabel:  report.can_overwrite ? 'Overwrite existing lead' : 'Send update for approval',
      primaryNote:   report.can_overwrite
        ? 'Overwriting replaces the saved values. The old ones stay in the audit log.'
        : `${owner} logged that lead, so an admin has to approve the change.`,
      separateLabel: 'Not a duplicate — save separately',
    })

    if (choice === 'cancel')   return null
    if (choice === 'separate') return 'allow'
    if (report.can_overwrite)  return 'overwrite'

    // No direct write → file an edit request against the lead that exists,
    // rather than adding a second one.
    const patch = adLeadPatchFrom(existing, incoming)
    if (Object.keys(patch).length === 0) {
      toast.error('Nothing to change — your entry matches the saved lead exactly')
      return null
    }

    const reason = await promptDialog.ask({
      title:        'Why should this lead be changed?',
      message:      `Patient: ${existing.patient_name}\n\nThe admin reviews this together with your changes.`,
      placeholder:  'e.g. Lead booked in after the first entry',
      confirmLabel: 'Submit for approval',
    })
    if (reason === null) return null

    try {
      await editRequestsApi.create({
        entity_type: 'ad_lead',
        entity_id:   existing.id,
        reason:      reason.trim() || 'Duplicate lead — corrected values',
        patch,
      })
      toast.success('Edit request submitted — waiting for admin approval')
      return 'handled'
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || 'Failed to submit edit request')
      return null
    }
  }

  const onSubmit = async () => {
    setFormErr('')
    if (!form.patient_name.trim()) { setFormErr('Prospective Patient Name is required'); return }
    if (!form.platform)            { setFormErr('Platform Source is required'); return }
    if (!form.date_added)          { setFormErr('Date Added is required'); return }

    const common = {
      patient_name:  form.patient_name.trim(),
      platform:      form.platform,
      campaign_name: form.campaign_name.trim() || null,
      date_added:    form.date_added,
      booked:        form.booked,
      bella_called:  form.bella_called.trim() || null,
      bella_sms:     form.bella_sms.trim() || null,
      bella_remarks: form.bella_remarks.trim() || null,
    }

    // Non-admin editing an existing lead → submit an edit request for admin
    // approval instead of applying the change directly (same flow as
    // dropout / case-acceptance).
    if (editingId && !isAdmin) {
      const original = editingRowRef.current
      if (!original) { setFormErr('Lost track of the lead being edited — reopen it and try again'); return }

      // Build a diff patch: only the fields that actually changed.
      const patch: Record<string, unknown> = {}
      if (common.patient_name  !== original.patient_name)          patch.patient_name  = common.patient_name
      if (common.platform      !== original.platform)              patch.platform      = common.platform
      if (common.campaign_name !== (original.campaign_name ?? null)) patch.campaign_name = common.campaign_name
      if (common.date_added    !== original.date_added)            patch.date_added    = common.date_added
      if (common.booked        !== original.booked)                patch.booked        = common.booked
      if (common.bella_called  !== (original.bella_called ?? null)) patch.bella_called  = common.bella_called
      if (common.bella_sms     !== (original.bella_sms ?? null))    patch.bella_sms     = common.bella_sms
      if (common.bella_remarks !== (original.bella_remarks ?? null)) patch.bella_remarks = common.bella_remarks

      if (Object.keys(patch).length === 0) {
        setFormErr('No changes detected — edit something before submitting')
        return
      }

      const reason = await promptDialog.ask({
        title:        'Why are you editing this lead?',
        message:      `Patient: ${common.patient_name}\n\nProvide a reason so the admin can review and approve your changes.`,
        placeholder:  'e.g. Wrong platform, corrected name, booked status changed…',
        confirmLabel: 'Submit for approval',
      })
      if (reason === null) return  // cancelled

      setSaving(true)
      try {
        await editRequestsApi.create({
          entity_type: 'ad_lead',
          entity_id:   editingId,
          reason:      reason.trim() || 'No reason provided',
          patch,
        })
        toast.success('Edit request submitted — waiting for admin approval')
        resetForm()
        await loadEntries()
        await reloadPendingEdits()
        setActiveTab('entries')
      } catch (e: any) {
        const msg = e.response?.data?.error?.message || 'Failed to submit edit request'
        setFormErr(msg); toast.error(msg)
      } finally { setSaving(false) }
      return
    }

    // The values that will actually be stored — the duplicate diff and any
    // edit-request patch are both computed from these.
    const incoming: AdLeadValues = {
      campaign_name: common.campaign_name,
      booked:        common.booked,
      bella_called:  common.bella_called,
      bella_sms:     common.bella_sms,
      bella_remarks: common.bella_remarks,
    }

    // New lead → look for an existing one with the same natural key. This is
    // only a pre-flight for the UI: the POST re-checks under a lock, so a
    // failed check here must never block the save.
    let onDuplicate: OnDuplicate | undefined
    if (!editingId) {
      let report: DuplicateReport<AdLeadDTO> | null = null
      try {
        report = await adLeadsApi.checkDuplicate({
          clinic_id:    createClinic,
          patient_name: common.patient_name,
          platform:     common.platform,
          date_added:   common.date_added,
        })
      } catch { /* best-effort — the POST re-checks under a lock */ }

      if (report?.exact) {
        const decision = await resolveDuplicate(report, incoming)
        if (decision === null) return
        if (decision === 'handled') {
          resetForm(); await loadEntries(); await reloadPendingEdits(); setActiveTab('entries'); return
        }
        onDuplicate = decision
      } else if (report && report.similar.length > 0) {
        // Tier 2: same person within two weeks on another platform or date.
        // Usually a re-run of the same Meta/Google export — worth a look, but
        // a genuine second lead is common enough not to block it.
        const near  = report.similar[0]
        const extra = report.similar.length - 1
        const ok = await confirmDialog.ask({
          title:   'Same person logged nearby',
          message:
            `"${near.patient_name}" is already logged as a ${near.platform} lead on ${near.date_added}` +
            `${extra > 0 ? ` (and ${extra} more within two weeks)` : ''}.` +
            `\n\nDouble-check the platform and date. Add this lead?`,
          confirmLabel: 'Yes, add lead',
          cancelLabel:  'Let me check',
        })
        if (!ok) return
      }
    }

    setSaving(true)
    try {
      if (editingId) {
        await adLeadsApi.update(editingId, common as UpdateAdLeadPayload)
        toast.success('Lead updated')
      } else {
        const payload: CreateAdLeadPayload = { clinic_id: createClinic, ...common }

        let overwrote = onDuplicate === 'overwrite'
        try {
          await adLeadsApi.create({ ...payload, ...(onDuplicate ? { on_duplicate: onDuplicate } : {}) })
        } catch (e: any) {
          // Someone keyed the same lead between the pre-flight check and this
          // POST — the server won that race. Show the same dialog and retry.
          const raced = duplicateReportFromError<AdLeadDTO>(e)
          if (!raced) throw e

          const decision = await resolveDuplicate(raced, incoming)
          if (decision === null) return
          if (decision === 'handled') {
            resetForm(); await loadEntries(); await reloadPendingEdits(); setActiveTab('entries'); return
          }
          overwrote = decision === 'overwrite'
          await adLeadsApi.create({ ...payload, on_duplicate: decision })
        }

        toast.success(overwrote ? 'Overwrote the existing lead' : 'Lead saved')
      }
      resetForm()
      await loadEntries()
      setActiveTab('entries')
    } catch (e: any) {
      const msg = e.response?.data?.error?.message || 'Failed to save'
      setFormErr(msg); toast.error(msg)
    } finally { setSaving(false) }
  }

  // ADMIN deletes directly.
  const onDelete = async (row: AdLeadDTO) => {
    const ok = await confirmDialog.destructive({
      title:        'Delete lead?',
      message:      `${row.patient_name} · ${row.platform}\nDate Added: ${row.date_added}\n\nThis cannot be undone.`,
      confirmLabel: 'Delete lead',
    })
    if (!ok) return
    try {
      await adLeadsApi.remove(row.id)
      toast.success('Deleted')
      if (editingId === row.id) resetForm()
      await loadEntries()
    } catch (e: any) { toast.error(e.response?.data?.error?.message || 'Failed to delete') }
  }

  // Non-admin asks the super admin to delete their own lead (no direct delete).
  const onRequestDelete = async (row: AdLeadDTO) => {
    const reason = await promptDialog.ask({
      title:        'Request lead deletion',
      message:      `${row.patient_name} · ${row.platform}\nDate Added: ${row.date_added}\n\nThis will be sent to the admin for approval. You may add a reason.`,
      placeholder:  'Reason (optional)',
      confirmLabel: 'Send request',
    })
    if (reason === null) return // cancelled
    try {
      await deleteRequestsApi.create({ entity_type: 'ad_lead', entity_id: row.id, reason: reason || null })
      toast.success('Delete request sent — waiting for admin approval')
      await reloadPendingDeletes()
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || 'Failed to send delete request')
    }
  }

  // Ad-leads are a shared team inbox — every row the server returns is already
  // within this user's clinic scope (FRONT_DESK = own clinic, FRONT_DESK_GLOBAL
  // = all). So any front-desk user may edit-request / delete-request any visible
  // lead, not just ones they personally encoded. ADMIN edits directly.
  const isEditable = (_row: AdLeadDTO) =>
    isAdmin || user.role === 'FRONT_DESK' || user.role === 'FRONT_DESK_GLOBAL'

  return (
    <AppShell title="Meta/Google ADS Leads" hideNav>
      <div className="pw-page" style={{ padding: '20px 28px' }}>

        <SubTabs active={activeTab} total={total} onChange={setActiveTab} />

        {/* ── Encode tab ── */}
        {activeTab === 'encode' && (
          <div style={{ background: '#fff', border: `1px solid ${editingId ? TEAL : BORDER}`, borderRadius: 10, padding: 22 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: editingId ? TEAL : TEXT, marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{editingId && !isAdmin ? 'Editing lead — changes will be sent for admin approval' : editingId ? 'Editing lead' : 'New lead entry'}</span>
              {editingId && <button onClick={resetForm} style={smallBtnStyle}>Cancel edit</button>}
            </div>

            {formErr && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: DANGER, borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 14 }}>
                {formErr}
              </div>
            )}

            <div className="pw-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              <Field label="Prospective Patient Name *">
                <PatientNameInput value={form.patient_name}
                  onChange={v => setForm(f => ({ ...f, patient_name: v }))}
                  placeholder="e.g. Jane Smith" style={inputStyle} />
              </Field>
              <Field label="Platform Source *">
                <select value={form.platform} onChange={e => setForm(f => ({ ...f, platform: e.target.value as AdLeadPlatform }))} style={inputStyle}>
                  <option value="">— Select —</option>
                  {AD_LEAD_PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>
              <Field label="Campaign Name">
                <input value={form.campaign_name} onChange={e => setForm(f => ({ ...f, campaign_name: e.target.value }))}
                  placeholder="e.g. M 03/27 Athlete_Back Pain" style={inputStyle} />
              </Field>
              <Field label="Date Added *">
                <input type="date" value={form.date_added} onChange={e => setForm(f => ({ ...f, date_added: e.target.value }))} style={inputStyle} />
              </Field>
            </div>

            {/* Booked? */}
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 14, cursor: 'pointer', fontSize: 13, color: TEXT, fontWeight: 500 }}>
              <input type="checkbox" checked={form.booked} onChange={e => setForm(f => ({ ...f, booked: e.target.checked }))} style={{ width: 16, height: 16 }} />
              Booked? (lead booked an appointment)
            </label>

            {/* Follow-up (Bella) */}
            <div style={{ marginTop: 16 }}>
              <button onClick={() => setShowFollowUp(s => !s)} style={{ ...smallBtnStyle, color: TEAL, borderColor: '#cdebde' }}>
                {showFollowUp ? '− Hide follow-up' : '+ Add follow-up (Bella Called / Followed up / Remarks)'}
              </button>
            </div>
            {showFollowUp && (
              <div className="pw-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 14 }}>
                <Field label="Bella Called?">
                  <select value={form.bella_called} onChange={e => setForm(f => ({ ...f, bella_called: e.target.value }))} style={inputStyle}>
                    <option value="">—</option>
                    <option value="Y">Y</option>
                    <option value="N">N</option>
                  </select>
                </Field>
                <Field label="Bella followed up?">
                  <select value={form.bella_sms} onChange={e => setForm(f => ({ ...f, bella_sms: e.target.value }))} style={inputStyle}>
                    <option value="">—</option>
                    {BELLA_CONTACT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="Bella Remarks">
                  <input value={form.bella_remarks} onChange={e => setForm(f => ({ ...f, bella_remarks: e.target.value }))} style={inputStyle} />
                </Field>
              </div>
            )}

            <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={onSubmit} disabled={saving} style={{ ...primaryBtnStyle, fontSize: 14, padding: '10px 26px', opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Saving…' : editingId && !isAdmin ? 'Submit for approval' : editingId ? 'Update lead' : 'Add entry'}
              </button>
            </div>
          </div>
        )}

        {/* ── All Entries tab ── */}
        {activeTab === 'entries' && (
          <>
            {/* Rejected edit-request notifications */}
            {visibleRejections.map(r => (
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
                <button onClick={() => dismissRejected(r.id)} title="Dismiss" style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: '#92400e', fontSize: 18, lineHeight: 1, padding: 2, flexShrink: 0,
                }}>×</button>
              </div>
            ))}

            {/* Filters — same shape as Daily Patient Dropout Tracking */}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
              <div style={filterCol}>
                <span style={filterLabel}>Search</span>
                <div style={{ position: 'relative' }}>
                  <input
                    type="text"
                    value={searchInput}
                    onChange={e => setSearchInput(e.target.value)}
                    placeholder="Patient name or campaign…"
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
              <div style={filterCol}>
                <span style={filterLabel}>Date range</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <DateRangePicker
                    value={{ from: dateFrom, to: dateTo }}
                    onChange={r => { setDateFrom(r.from); setDateTo(r.to) }}
                    maxRangeDays={366}
                  />
                  {(dateFrom || dateTo) && (
                    <button
                      onClick={() => { setDateFrom(''); setDateTo('') }}
                      title="Show leads from every date"
                      style={{ ...smallBtnStyle, color: TEXT_SOFT, whiteSpace: 'nowrap' }}
                    >All dates</button>
                  )}
                </div>
              </div>
              <div style={filterCol}>
                <span style={filterLabel}>Platform</span>
                <select value={platformFilter} onChange={e => setPlatformFilter(e.target.value as AdLeadPlatform | '')} style={{ ...inputStyle, minWidth: 170 }}>
                  <option value="">All platforms</option>
                  {AD_LEAD_PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div style={filterCol}>
                <span style={filterLabel}>Booked</span>
                <select value={bookedFilter} onChange={e => setBookedFilter(e.target.value as '' | 'true' | 'false')} style={{ ...inputStyle, minWidth: 140 }}>
                  <option value="">All leads</option>
                  <option value="true">Booked only</option>
                  <option value="false">Not booked</option>
                </select>
              </div>
              {hasFilters && (
                <button onClick={clearFilters} style={{ ...smallBtnStyle, padding: '9px 14px', color: TEXT_SOFT }}>
                  Reset filters
                </button>
              )}
            </div>

            <SummaryCards summary={summary} />

            <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', background: '#f9fafb', borderBottom: `1px solid ${BORDER}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>
                  Leads
                  <span style={{ color: TEXT_SOFT, fontWeight: 400, marginLeft: 8 }}>
                    ({total.toLocaleString()}{search ? ` matching "${search}"` : ''})
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {lastSyncedAt && !paidSyncing && (
                    <span style={{ fontSize: 11, color: TEXT_SOFT, whiteSpace: 'nowrap' }}>
                      Paid synced {new Date(lastSyncedAt).toLocaleString()}
                    </span>
                  )}
                  <button
                    onClick={syncNookalPaid}
                    disabled={paidSyncing || loading}
                    title="Resolve ALL booked leads against Nookal and save their Paid totals — takes a little while"
                    style={{
                      background: paidSyncing ? '#9ca3af' : TEAL, color: '#fff', border: 'none',
                      borderRadius: 7, padding: '7px 16px', fontSize: 12, fontWeight: 700,
                      cursor: paidSyncing || loading ? 'not-allowed' : 'pointer',
                      fontFamily: "'DM Sans',sans-serif", whiteSpace: 'nowrap',
                    }}
                  >
                    {paidSyncing ? 'Syncing… (may take ~30s)' : 'Sync Paid (Nookal)'}
                  </button>
                </div>
              </div>

              {listErr && <div style={{ margin: 16, background: '#fef2f2', border: '1px solid #fecaca', color: DANGER, borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>{listErr}</div>}

              {loading ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
              ) : rows.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No leads match these filters.</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 980 }}>
                    <thead>
                      <tr style={{ background: '#f9fafb' }}>
                        <Th>Date Added</Th><Th>Patient</Th><Th>Platform</Th><Th>Campaign</Th>
                        <Th>Booked?</Th><Th>Paid (Nookal)</Th><Th>Bella Called?</Th><Th>Bella followed up?</Th><Th>Remarks</Th><Th align="right">Actions</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.id} style={{ borderTop: `1px solid ${BORDER}`, background: editingId === r.id ? '#f0faf7' : undefined }}>
                          <Td>{r.date_added}</Td>
                          <Td><strong>{r.patient_name}</strong></Td>
                          <Td><Pill text={r.platform} /></Td>
                          <Td><span style={{ color: TEXT_SOFT }}>{r.campaign_name || <Dim>—</Dim>}</span></Td>
                          <Td>{r.booked ? <span style={{ color: TEAL, fontWeight: 700 }}>✓ Booked</span> : <Dim>—</Dim>}</Td>
                          <Td>{r.booked ? <NookalPaidCell row={r} syncing={paidSyncing} /> : <Dim>—</Dim>}</Td>
                          <Td><span style={{ color: TEXT_SOFT }}>{r.bella_called || <Dim>—</Dim>}</span></Td>
                          <Td><span style={{ color: TEXT_SOFT }}>{r.bella_sms || <Dim>—</Dim>}</span></Td>
                          <Td><span style={{ color: TEXT_SOFT, fontSize: 12 }}>{r.bella_remarks || <Dim>—</Dim>}</span></Td>
                          <Td align="right">
                            {isEditable(r) ? (
                              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                                {isAdmin || !pendingEdits.has(r.id) ? (
                                  <button onClick={() => startEdit(r)} style={smallBtnStyle}>Edit</button>
                                ) : (
                                  <StatusChip label="Edit pending" color="blue" title="Your edit is waiting for admin approval" />
                                )}
                                {isAdmin ? (
                                  <button onClick={() => onDelete(r)} style={{ ...smallBtnStyle, color: DANGER, borderColor: '#fecaca' }}>Delete</button>
                                ) : pendingDeletes.has(r.id) ? (
                                  <StatusChip label="Delete requested" color="amber" title="Waiting for admin approval" />
                                ) : (
                                  <button onClick={() => onRequestDelete(r)} style={{ ...smallBtnStyle, color: DANGER, borderColor: '#fecaca' }}>Request delete</button>
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
                <Pagination total={total} limit={limit} offset={offset} onChange={setOffset} onLimitChange={setLimit} />
              )}
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}

// ── Sub-components ─────────────────────────────────────────────
function SubTabs({
  active, total, onChange,
}: { active: 'encode' | 'entries'; total: number; onChange: (t: 'encode' | 'entries') => void }) {
  return (
    <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderBottom: '2px solid #e5e7eb' }}>
      {(['encode', 'entries'] as const).map(t => {
        const label = t === 'encode' ? 'Encode' : `All Entries (${total.toLocaleString()})`
        const isActive = active === t
        return (
          <button key={t} onClick={() => onChange(t)} style={{
            background: 'transparent', border: 'none',
            borderBottom: isActive ? `2px solid ${TEAL}` : '2px solid transparent',
            marginBottom: -2, padding: '8px 18px',
            fontSize: 14, fontWeight: isActive ? 700 : 500,
            color: isActive ? TEAL : '#6b7280',
            cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
            transition: 'color 0.15s, border-color 0.15s',
          }}>{label}</button>
        )
      })}
    </div>
  )
}

function SummaryCards({ summary }: { summary: AdLeadSummary | null }) {
  const loaded = summary !== null
  const rate = loaded && summary!.total > 0 ? Math.round((summary!.booked / summary!.total) * 100) : null
  return (
    <div className="pw-grid-2" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 16 }}>
      <Card label="Total Leads" value={loaded ? summary!.total.toLocaleString() : '—'} highlight />
      <Card label="Booked" value={loaded ? summary!.booked.toLocaleString() : '—'} />
      <Card label="Conversion" value={rate !== null ? `${rate}%` : '—'} />
    </div>
  )
}
function Card({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ background: highlight ? '#f0faf7' : '#fff', border: `1px solid ${highlight ? '#cdebde' : BORDER}`, borderRadius: 10, padding: '14px 18px' }}>
      <div style={{ fontSize: 11, color: TEXT_SOFT, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: highlight ? TEAL : TEXT, marginTop: 4 }}>{value}</div>
    </div>
  )
}
function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, gridColumn: full ? '1/-1' : undefined }}>
      <span style={{ fontSize: 12, color: TEXT_SOFT, fontWeight: 500 }}>{label}</span>
      {children}
    </label>
  )
}
function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th style={{ padding: '10px 14px', textAlign: align, fontSize: 11, fontWeight: 600, color: TEXT_SOFT, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{children}</th>
}
function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <td style={{ padding: '10px 14px', textAlign: align, color: TEXT, verticalAlign: 'top' }}>{children}</td>
}
function Dim({ children }: { children: React.ReactNode }) { return <span style={{ color: '#9ca3af' }}>{children}</span> }

/**
 * Nookal account "Paid" total for a booked lead, read from the values the
 * Sync button saved on the row. A clean single match links straight to the
 * client's Accounts page in Nookal; several same-name clients show a hover
 * list instead of guessing; misspelled / not-yet-created clients show
 * "not in Nookal".
 */
function NookalPaidCell({ row, syncing }: { row: AdLeadDTO; syncing: boolean }) {
  if (!row.nookal_status) {
    if (syncing) return <Dim>…</Dim>
    return <span title="Click Sync Paid (Nookal) above to load" style={{ color: '#9ca3af', cursor: 'help' }}>—</span>
  }
  const lookup = { status: row.nookal_status, candidates: row.nookal_candidates ?? [] }
  if (lookup.status === 'matched' && lookup.candidates[0]) {
    const c = lookup.candidates[0]
    return (
      <a
        href={`https://auzone3.nookal.com/v2.0/clients/accounts/6/${c.clientID}`}
        target="_blank" rel="noreferrer"
        title={`${c.fullName} · Invoiced $${c.invoiced.toFixed(2)} · ${c.invoiceCount} invoice${c.invoiceCount === 1 ? '' : 's'} · Nookal client #${c.clientID} — open in Nookal`}
        style={{ color: TEAL, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}
      >${c.paid.toFixed(2)}</a>
    )
  }
  if (lookup.status === 'multiple') {
    return (
      <span
        title={lookup.candidates.map(c => `${c.fullName} — $${c.paid.toFixed(2)} paid (#${c.clientID})`).join('\n')}
        style={{ color: '#92400e', fontWeight: 600, cursor: 'help', whiteSpace: 'nowrap' }}
      >{lookup.candidates.length} matches</span>
    )
  }
  if (lookup.status === 'error') {
    return <span title="Nookal lookup failed — click Sync Paid (Nookal) to retry" style={{ color: '#9ca3af' }}>lookup failed</span>
  }
  return <span title="No Nookal client found with this name — check the spelling in Nookal" style={{ color: '#9ca3af', whiteSpace: 'nowrap' }}>not in Nookal</span>
}
function StatusChip({ label, color, title }: { label: string; color: 'blue' | 'amber'; title?: string }) {
  const c = color === 'blue'
    ? { bg: '#eff6ff', fg: '#1d4ed8', bd: '#bfdbfe' }
    : { bg: '#fffbeb', fg: '#92400e', bd: '#fde68a' }
  return (
    <span title={title} style={{
      background: c.bg, color: c.fg, border: `1px solid ${c.bd}`,
      borderRadius: 6, padding: '4px 10px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
      fontFamily: "'DM Sans', sans-serif",
    }}>{label}</span>
  )
}
function Pill({ text }: { text: string }) {
  return <span style={{ background: '#f0faf7', color: TEAL, border: '1px solid #cdebde', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>{text}</span>
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', border: `1px solid ${BORDER}`, borderRadius: 7,
  fontSize: 13, fontFamily: "'DM Sans',sans-serif", color: TEXT, boxSizing: 'border-box', background: '#fff',
}
const primaryBtnStyle: React.CSSProperties = {
  background: TEAL, color: '#fff', border: 'none', borderRadius: 7,
  padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif",
}
const smallBtnStyle: React.CSSProperties = {
  background: '#fff', color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 6,
  padding: '5px 10px', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif",
}
// Filter-bar bits — one labelled column per filter.
const filterCol: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4,
}
const filterLabel: React.CSSProperties = {
  fontSize: 11, color: TEXT_SOFT, fontWeight: 500,
}
