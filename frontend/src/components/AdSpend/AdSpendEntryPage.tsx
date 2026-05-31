import React, { useEffect, useState, useCallback } from 'react'
import {
  adSpendApi,
  CreateAdSpendPayload, UpdateAdSpendPayload, AdSpendSummary, WeeklyReportRow,
} from '../../api/adSpend.api'
import { AdSpendDTO, AD_CHANNELS, AdChannel } from '../../types'
import { useAuthStore } from '../../store/auth.store'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/confirm.store'
import AppShell from '../shared/AppShell'
import Pagination from '../shared/Pagination'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'

// ── Constants ─────────────────────────────────────────────────
const TEAL      = '#0f6e56'
const TEXT      = '#111827'
const TEXT_SOFT = '#4b5563'
const BORDER    = '#e5e7eb'
const DANGER    = '#b91c1c'

const AUD = new Intl.NumberFormat('en-AU', {
  style: 'currency', currency: 'AUD', minimumFractionDigits: 2,
})

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// ── Date helpers ──────────────────────────────────────────────
function localISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function todayISO(): string { return localISO(new Date()) }
function addDays(isoDate: string, n: number): string {
  const d = new Date(isoDate + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return localISO(d)
}
function getMondayISO(anyISO: string): string {
  const d = new Date(anyISO + 'T12:00:00')
  const dow = d.getDay()
  const diff = dow === 0 ? -6 : 1 - dow
  d.setDate(d.getDate() + diff)
  return localISO(d)
}
function weekRangeLabel(monday: string, friday: string): string {
  const s = new Date(monday + 'T12:00:00')
  const e = new Date(friday + 'T12:00:00')
  const sm = MONTHS[s.getMonth()], sd = s.getDate(), sy = s.getFullYear()
  const em = MONTHS[e.getMonth()], ed = e.getDate(), ey = e.getFullYear()
  if (sy !== ey) return `${sm} ${sd}, ${sy} – ${em} ${ed}, ${ey}`
  if (sm === em)  return `${sm} ${sd}–${ed}, ${sy}`
  return `${sm} ${sd} – ${em} ${ed}, ${sy}`
}

// ── Enter Week form state ─────────────────────────────────────
type WeekAmounts = Record<AdChannel, string>
function emptyAmounts(): WeekAmounts {
  return Object.fromEntries(AD_CHANNELS.map(c => [c, ''])) as WeekAmounts
}

// ── Weekly Input Form ─────────────────────────────────────────
function WeeklyInputForm({ onSaved }: { onSaved: () => void }) {
  const [weekDate,  setWeekDate]  = useState(todayISO())
  const [amounts,   setAmounts]   = useState<WeekAmounts>(emptyAmounts)
  const [notes,     setNotes]     = useState('')
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')
  const [loading,   setLoading]   = useState(false)
  // existing entry IDs per channel (for delete-before-recreate on save)
  const [existingIds, setExistingIds] = useState<Record<string, string[]>>({})
  // auto-synced total for Google (read-only display)
  const [googleSynced, setGoogleSynced] = useState<number | null>(null)

  const monday = getMondayISO(weekDate)
  const friday = addDays(monday, 4)
  const label  = weekRangeLabel(monday, friday)

  // Load existing entries whenever the week changes
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setAmounts(emptyAmounts())
    setNotes('')
    setExistingIds({})
    setGoogleSynced(null)

    adSpendApi.list({ date_from: monday, date_to: friday, limit: 500 })
      .then(res => {
        if (cancelled) return
        const ids: Record<string, string[]>  = {}
        const totals: Record<string, number> = {}
        let googleAutoTotal = 0
        let googleHasManual = false

        for (const row of res.data) {
          if (!ids[row.channel]) ids[row.channel] = []
          ids[row.channel].push(row.id)
          totals[row.channel] = (totals[row.channel] ?? 0) + row.amount

          if (row.channel === 'Google' && row.notes === 'Auto-synced from Google Ads') {
            googleAutoTotal += row.amount
          } else if (row.channel === 'Google') {
            googleHasManual = true
          }
        }

        const newAmounts = emptyAmounts()
        for (const c of AD_CHANNELS) {
          if (c !== 'Google' && totals[c] != null) {
            newAmounts[c] = String(Math.round(totals[c] * 100) / 100)
          }
        }

        setExistingIds(ids)
        setAmounts(newAmounts)
        // Show Google synced total unless encoder manually overrode it
        setGoogleSynced(googleAutoTotal > 0 && !googleHasManual ? googleAutoTotal : null)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [monday])

  const manualTotal = AD_CHANNELS.filter(c => c !== 'Google').reduce((s, c) => {
    const v = parseFloat(amounts[c])
    return s + (Number.isFinite(v) && v > 0 ? v : 0)
  }, 0)
  const previewTotal = manualTotal + (googleSynced ?? 0)

  const goWeek = (dir: -1 | 1) => setWeekDate(addDays(monday, dir * 7))

  const onSubmit = async () => {
    setError('')
    const toDelete: string[] = []
    const toCreate: CreateAdSpendPayload[] = []

    for (const c of AD_CHANNELS) {
      if (c === 'Google') continue // never overwrite auto-synced Google entries
      const raw = amounts[c].trim()
      const v   = raw ? parseFloat(raw) : 0

      if (raw && (!Number.isFinite(v) || v < 0)) { setError(`Invalid amount for ${c}`); return }

      // Delete existing manual entries for this channel+week
      if (existingIds[c]?.length) toDelete.push(...existingIds[c])
      // Re-create if amount > 0
      if (v > 0) toCreate.push({ spend_date: monday, channel: c, amount: v, notes: notes.trim() || null })
    }

    if (toCreate.length === 0 && toDelete.length === 0) {
      setError('Enter at least one amount greater than $0'); return
    }

    setSaving(true)
    try {
      await Promise.all([
        ...toDelete.map(id => adSpendApi.remove(id)),
      ])
      await Promise.all(toCreate.map(e => adSpendApi.create(e)))
      toast.success(`Saved · ${AUD.format(previewTotal)} for ${label}`)
      onSaved()
    } catch (e: any) {
      const msg = e.response?.data?.error?.message || 'Failed to save'
      setError(msg); toast.error(msg)
    } finally { setSaving(false) }
  }

  return (
    <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: 24, marginBottom: 20 }}>
      {/* Week navigator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
        <button onClick={() => goWeek(-1)} style={navBtnStyle} title="Previous week">‹</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: TEXT_SOFT, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 5 }}>
            Select week
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <input type="date" value={weekDate}
              onChange={e => { if (e.target.value) setWeekDate(e.target.value) }}
              style={{ ...inputStyle, width: 160 }} />
            <span style={{ fontSize: 16, fontWeight: 700, color: TEXT }}>{label}</span>
          </div>
          <div style={{ fontSize: 11, color: TEXT_SOFT, marginTop: 4 }}>
            Saved on <strong>{monday}</strong> · Mon–Fri week (matches CEO dashboard)
          </div>
        </div>
        <button onClick={() => goWeek(1)} style={navBtnStyle} title="Next week">›</button>
      </div>

      {error && (
        <div style={{ background:'#fef2f2', border:'1px solid #fecaca', color:DANGER, borderRadius:8, padding:'10px 14px', fontSize:13, marginBottom:16 }}>
          {error}
        </div>
      )}

      {/* Channel grid */}
      <div style={{ border:`1px solid ${BORDER}`, borderRadius:8, overflow:'hidden', marginBottom:18 }}>
        {/* Header */}
        <div style={{ display:'grid', gridTemplateColumns:'140px 1fr 120px', gap:8, padding:'8px 16px', background:'#f9fafb', borderBottom:`1px solid ${BORDER}` }}>
          <div style={{ fontSize:11, fontWeight:600, color:TEXT_SOFT, textTransform:'uppercase', letterSpacing:'0.05em' }}>Channel</div>
          <div style={{ fontSize:11, fontWeight:600, color:TEXT_SOFT, textTransform:'uppercase', letterSpacing:'0.05em' }}>Ad Spend $</div>
          <div style={{ fontSize:11, fontWeight:600, color:TEXT_SOFT, textTransform:'uppercase', letterSpacing:'0.05em', textAlign:'right' }}>Preview</div>
        </div>

        {loading && (
          <div style={{ padding:'14px 16px', fontSize:13, color:TEXT_SOFT }}>Loading week data…</div>
        )}
        {!loading && AD_CHANNELS.map((c, i) => {
          const isGoogleSynced = c === 'Google' && googleSynced !== null
          const amtVal = isGoogleSynced ? googleSynced : parseFloat(amounts[c])
          return (
            <div key={c} style={{
              display:'grid', gridTemplateColumns:'140px 1fr 120px', gap:8,
              padding:'10px 16px', alignItems:'center',
              background: i % 2 === 0 ? '#fff' : '#fafbfc',
              borderBottom: i < AD_CHANNELS.length - 1 ? `1px solid ${BORDER}` : undefined,
            }}>
              <div style={{ fontSize:14, fontWeight:600, color:TEXT, display:'flex', alignItems:'center', gap:6 }}>
                {c}
                {isGoogleSynced && (
                  <span style={{ fontSize:9, fontWeight:700, background:'#d1fae5', color:'#065f46', borderRadius:4, padding:'2px 5px', letterSpacing:'0.04em' }}>
                    AUTO
                  </span>
                )}
              </div>

              {/* Spend */}
              <div style={{ position:'relative' }}>
                {isGoogleSynced ? (
                  <div style={{ ...inputStyle, paddingLeft:24, display:'flex', alignItems:'center', background:'#f9fafb', color:TEXT_SOFT, cursor:'default' }}>
                    <span style={{ position:'absolute', left:10, fontSize:13, color:TEXT_SOFT }}>$</span>
                    <span style={{ paddingLeft:8 }}>{googleSynced.toFixed(2)}</span>
                  </div>
                ) : (
                  <>
                    <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', fontSize:13, color:TEXT_SOFT, pointerEvents:'none' }}>$</span>
                    <input type="number" min={0} step="0.01" value={amounts[c]}
                      onChange={e => setAmounts(a => ({ ...a, [c]: e.target.value }))}
                      placeholder="0.00"
                      style={{ ...inputStyle, paddingLeft:24 }} />
                  </>
                )}
              </div>

              {/* Preview */}
              <div style={{ textAlign:'right', fontSize:13, fontWeight:600, fontFamily:"'DM Mono',monospace", color: amtVal > 0 ? TEAL : '#d1d5db' }}>
                {amtVal > 0 ? AUD.format(amtVal) : '—'}
              </div>
            </div>
          )
        })}

        {/* Total row */}
        <div style={{ display:'grid', gridTemplateColumns:'140px 1fr 120px', gap:8, padding:'12px 16px', background:'#f0faf7', borderTop:`2px solid ${TEAL}`, alignItems:'center' }}>
          <div style={{ fontSize:13, fontWeight:700, color:TEAL }}>TOTAL</div>
          <div />
          <div style={{ textAlign:'right', fontSize:16, fontWeight:700, fontFamily:"'DM Mono',monospace", color: previewTotal > 0 ? TEAL : '#d1d5db' }}>
            {previewTotal > 0 ? AUD.format(previewTotal) : '—'}
          </div>
        </div>
      </div>

      {/* Notes */}
      <label style={{ display:'block', marginBottom:18 }}>
        <span style={{ fontSize:12, color:TEXT_SOFT, fontWeight:500, display:'block', marginBottom:5 }}>Notes (optional)</span>
        <input value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="e.g. Winter Knee Pain campaign"
          style={inputStyle} />
      </label>

      <div style={{ display:'flex', justifyContent:'flex-end' }}>
        <button onClick={onSubmit} disabled={saving || previewTotal === 0} style={{
          ...primaryBtnStyle, fontSize:14, padding:'10px 28px',
          opacity: previewTotal === 0 ? 0.4 : 1,
          cursor:  previewTotal === 0 ? 'not-allowed' : 'pointer',
        }}>
          {saving ? 'Saving…' : 'Save Week Spend'}
        </button>
      </div>
    </div>
  )
}

// ── Weekly Report tab ─────────────────────────────────────────
function WeeklyReportTab() {
  const [range, setRange]  = useState(() => ({ from: addDays(todayISO(), -90), to: todayISO() }))
  const [rows,  setRows]   = useState<WeeklyReportRow[]>([])
  const [loading, setLoad] = useState(false)
  const [error, setError]  = useState('')

  const load = useCallback(async () => {
    setLoad(true); setError('')
    try { setRows(await adSpendApi.weeklyReport(range.from, range.to)) }
    catch (e: any) { setError(e.response?.data?.error?.message || 'Failed to load') }
    finally { setLoad(false) }
  }, [range])

  useEffect(() => { load() }, [load])

  // All channels that appear across all weeks
  const allChannels = AD_CHANNELS.filter(c =>
    rows.some(r => (r.byChannel[c] ?? 0) > 0)
  )

  const grandTotal = rows.reduce((s, r) => s + r.total, 0)
  const channelTotals = Object.fromEntries(
    allChannels.map(c => [c, rows.reduce((s, r) => s + (r.byChannel[c] ?? 0), 0)])
  )

  return (
    <div>
      {/* Controls */}
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:16, flexWrap:'wrap' }}>
        <span style={{ fontSize:12, color:TEXT_SOFT, fontWeight:500 }}>From</span>
        <input type="date" value={range.from}
          onChange={e => setRange(r => ({ ...r, from: e.target.value }))}
          style={{ ...inputStyle, width:150, fontSize:12 }} />
        <span style={{ fontSize:12, color:TEXT_SOFT, fontWeight:500 }}>To</span>
        <input type="date" value={range.to}
          onChange={e => setRange(r => ({ ...r, to: e.target.value }))}
          style={{ ...inputStyle, width:150, fontSize:12 }} />
        <button onClick={load} disabled={loading}
          style={{ ...primaryBtnStyle, padding:'7px 16px', fontSize:12 }}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div style={{ background:'#fef2f2', border:'1px solid #fecaca', color:DANGER, borderRadius:8, padding:'10px 14px', fontSize:13, marginBottom:12 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>No entries for this date range.</div>
      ) : (
        <div style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                <th style={{ padding:'10px 12px', textAlign:'left', fontSize:11, fontWeight:700, color:'#fff', background:'#374151', whiteSpace:'nowrap' }}>Week</th>
                {allChannels.map(c => (
                  <th key={c} style={{ padding:'10px 12px', textAlign:'right', fontSize:11, fontWeight:600, color:TEXT_SOFT, letterSpacing:'0.05em', textTransform:'uppercase', whiteSpace:'nowrap' }}>{c}</th>
                ))}
                <th style={{ padding:'10px 12px', textAlign:'right', fontSize:11, fontWeight:700, color:TEAL, letterSpacing:'0.05em', textTransform:'uppercase' }}>TOTAL</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.week_start} style={{ borderTop:`1px solid ${BORDER}`, background: i%2===1 ? '#fafbfc' : '#fff' }}>
                  <td style={{ padding:'9px 12px', fontWeight:500, color:TEXT, whiteSpace:'nowrap' }}>
                    {weekRangeLabel(row.week_start, row.week_end)}
                  </td>
                  {allChannels.map(c => (
                    <td key={c} style={{ padding:'9px 12px', textAlign:'right', fontFamily:"'DM Mono',monospace", color: (row.byChannel[c] ?? 0) > 0 ? TEXT : '#d1d5db' }}>
                      {(row.byChannel[c] ?? 0) > 0 ? AUD.format(row.byChannel[c]) : '—'}
                    </td>
                  ))}
                  <td style={{ padding:'9px 12px', textAlign:'right', fontFamily:"'DM Mono',monospace", fontWeight:700, color:TEAL }}>
                    {AUD.format(row.total)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop:`2px solid ${TEAL}`, background:'#f0faf7' }}>
                <td style={{ padding:'10px 12px', fontWeight:700, color:TEXT }}>TOTAL</td>
                {allChannels.map(c => (
                  <td key={c} style={{ padding:'10px 12px', textAlign:'right', fontFamily:"'DM Mono',monospace", fontWeight:700, color:TEXT }}>
                    {AUD.format(channelTotals[c] ?? 0)}
                  </td>
                ))}
                <td style={{ padding:'10px 12px', textAlign:'right', fontFamily:"'DM Mono',monospace", fontWeight:700, color:TEAL, fontSize:14 }}>
                  {AUD.format(grandTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Edit form state ───────────────────────────────────────────
interface EditFormState {
  spend_date: string
  channel:    AdChannel | ''
  amount:     string
  notes:      string
}
function emptyEditForm(row?: AdSpendDTO): EditFormState {
  return {
    spend_date: row?.spend_date ?? todayISO(),
    channel:    (row?.channel as AdChannel) ?? '',
    amount:     row ? String(row.amount) : '',
    notes:      row?.notes ?? '',
  }
}

// ── Main page ─────────────────────────────────────────────────
type Tab = 'enter' | 'weekly' | 'entries'

export default function AdSpendEntryPage() {
  const { user } = useAuthStore()
  if (!user) return null

  const isAdmin = user.role === 'ADMIN'
  const [tab, setTab] = useState<Tab>(isAdmin ? 'entries' : 'enter')

  // ── Entries list ──
  const [rows,    setRows]    = useState<AdSpendDTO[]>([])
  const [total,   setTotal]   = useState(0)
  const [loading, setLoading] = useState(true)
  const [listErr, setListErr] = useState('')
  const [limit,   setLimit]   = useState(50)
  const [offset,  setOffset]  = useState(0)
  const [searchInput, setSearchInput] = useState('')
  const search = useDebouncedValue(searchInput.trim(), 300)
  const [summary, setSummary] = useState<AdSpendSummary | null>(null)
  // Date range filter for All Entries — empty = all time
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo,   setDateTo]   = useState('')

  useEffect(() => { setOffset(0) }, [search, limit, dateFrom, dateTo])

  const loadEntries = useCallback(async () => {
    setLoading(true); setListErr('')
    try {
      const filters = {
        limit, offset,
        search:    search    || undefined,
        date_from: dateFrom  || undefined,
        date_to:   dateTo    || undefined,
      }
      const [listRes, sumRes] = await Promise.all([
        adSpendApi.list(filters),
        adSpendApi.summary({ search: search || undefined, date_from: dateFrom || undefined, date_to: dateTo || undefined }),
      ])
      setRows(listRes.data); setTotal(listRes.pagination.total); setSummary(sumRes)
    } catch (e: any) {
      setListErr(e.response?.data?.error?.message || 'Failed to load entries')
    } finally { setLoading(false) }
  }, [limit, offset, search, dateFrom, dateTo])

  useEffect(() => { loadEntries() }, [loadEntries])

  // ── Edit state ──
  const [editingId,  setEditingId]  = useState<string | null>(null)
  const [editForm,   setEditForm]   = useState<EditFormState>(emptyEditForm())
  const [editSaving, setEditSaving] = useState(false)
  const [editErr,    setEditErr]    = useState('')

  const startEdit = (row: AdSpendDTO) => {
    setEditingId(row.id); setEditForm(emptyEditForm(row)); setEditErr('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const cancelEdit = () => { setEditingId(null); setEditForm(emptyEditForm()) }

  const onEditSubmit = async () => {
    setEditErr('')
    if (!editForm.channel) { setEditErr('Channel is required'); return }
    const amount = parseFloat(editForm.amount)
    if (!Number.isFinite(amount) || amount < 0) { setEditErr('Invalid amount'); return }

    setEditSaving(true)
    try {
      const patch: UpdateAdSpendPayload = {
        spend_date: editForm.spend_date,
        channel:    editForm.channel as AdChannel,
        amount,
        notes:      editForm.notes.trim() || null,
      }
      await adSpendApi.update(editingId!, patch)
      toast.success('Entry updated')
      cancelEdit(); await loadEntries()
    } catch (e: any) {
      const msg = e.response?.data?.error?.message || 'Failed to update'
      setEditErr(msg); toast.error(msg)
    } finally { setEditSaving(false) }
  }

  const onDelete = async (row: AdSpendDTO) => {
    const ok = await confirmDialog.destructive({
      title:        'Delete ad spend entry?',
      message:      `${AUD.format(row.amount)} · ${row.channel}\nDate: ${row.spend_date}\n\nThis cannot be undone.`,
      confirmLabel: 'Delete entry',
    })
    if (!ok) return
    try {
      await adSpendApi.remove(row.id)
      toast.success('Deleted'); await loadEntries()
    } catch (e: any) { toast.error(e.response?.data?.error?.message || 'Failed to delete') }
  }

  const isEditable = (row: AdSpendDTO) => isAdmin || row.entered_by === user.id

  // ── Google Ads sync (ADMIN only) ──
  const [syncing,    setSyncing]    = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  const [syncFrom,   setSyncFrom]   = useState(() => `${new Date().getFullYear()}-01-01`)
  const [syncTo,     setSyncTo]     = useState(todayISO)

  const onSyncGoogle = async () => {
    setSyncing(true); setSyncResult(null)
    try {
      const res = await adSpendApi.syncGoogle(syncFrom, syncTo)
      const msg = res.inserted > 0
        ? `Synced ${res.inserted} Google Ads entries (${syncFrom} → ${syncTo})`
        : `No Google Ads spend found for ${syncFrom} → ${syncTo}`
      setSyncResult(msg)
      toast.success(msg)
      await loadEntries()
    } catch (e: any) {
      const msg = e.response?.data?.error?.message || 'Google Ads sync failed'
      setSyncResult(msg); toast.error(msg)
    } finally { setSyncing(false) }
  }

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'enter',   label: 'Enter Week',    show: !isAdmin },
    { id: 'weekly',  label: 'Weekly Report', show: true     },
    { id: 'entries', label: 'All Entries',   show: true     },
  ]

  return (
    <AppShell title="Ad Spend">
      <div style={{ padding:'20px 28px' }}>

        {/* Google Ads sync — ADMIN only */}
        {isAdmin && (
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:16, padding:'12px 16px', background:'#f0faf7', border:`1px solid #a7f3d0`, borderRadius:10, flexWrap:'wrap' }}>
            <button
              onClick={onSyncGoogle}
              disabled={syncing}
              style={{ background: syncing ? '#9ca3af' : TEAL, color:'#fff', border:'none', borderRadius:7, padding:'8px 18px', fontSize:13, fontWeight:700, cursor: syncing ? 'not-allowed' : 'pointer', fontFamily:"'DM Sans',sans-serif", whiteSpace:'nowrap' }}>
              {syncing ? 'Syncing...' : 'Sync Google Ads'}
            </button>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <span style={{ fontSize:11, fontWeight:600, color:TEXT_SOFT, textTransform:'uppercase', letterSpacing:'0.05em' }}>From</span>
              <input type="date" value={syncFrom} onChange={e => setSyncFrom(e.target.value)}
                style={{ ...inputStyle, width:145, fontSize:12 }} />
              <span style={{ fontSize:11, fontWeight:600, color:TEXT_SOFT, textTransform:'uppercase', letterSpacing:'0.05em' }}>To</span>
              <input type="date" value={syncTo} onChange={e => setSyncTo(e.target.value)}
                style={{ ...inputStyle, width:145, fontSize:12 }} />
            </div>
            <span style={{ fontSize:12, color: syncResult ? (syncResult.includes('failed') || syncResult.includes('No ') ? '#b91c1c' : TEAL) : TEXT_SOFT, flex:1 }}>
              {syncResult ?? 'Default: Jan 1 → today (full year). Change dates to sync a specific range.'}
            </span>
          </div>
        )}

        {/* Tab bar */}
        <div style={{ display:'flex', gap:4, marginBottom:20, borderBottom:`2px solid ${BORDER}` }}>
          {tabs.filter(t => t.show).map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              background:'none', border:'none', cursor:'pointer',
              padding:'8px 20px', fontSize:13, fontWeight:600,
              fontFamily:"'DM Sans',sans-serif",
              color: tab === t.id ? TEAL : TEXT_SOFT,
              borderBottom: tab === t.id ? `2px solid ${TEAL}` : '2px solid transparent',
              marginBottom:-2, transition:'color 0.15s',
            }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Enter Week */}
        {tab === 'enter' && !isAdmin && <WeeklyInputForm onSaved={loadEntries} />}

        {/* Weekly Report */}
        {tab === 'weekly' && (
          <div style={{ background:'#fff', border:`1px solid ${BORDER}`, borderRadius:10, padding:18 }}>
            <WeeklyReportTab />
          </div>
        )}

        {/* All Entries */}
        {tab === 'entries' && (
          <>
            {/* Inline edit panel */}
            {editingId && (
              <div style={{ background:'#fff', border:`1px solid ${TEAL}`, borderRadius:10, padding:18, marginBottom:20 }}>
                <div style={{ fontSize:13, fontWeight:600, color:TEAL, marginBottom:14, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <span>Editing entry</span>
                  <button onClick={cancelEdit} style={smallBtnStyle}>Cancel</button>
                </div>
                {editErr && <div style={{ background:'#fef2f2', border:'1px solid #fecaca', color:DANGER, borderRadius:8, padding:'10px 14px', fontSize:13, marginBottom:12 }}>{editErr}</div>}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
                  <Field label="Date">
                    <input type="date" value={editForm.spend_date}
                      onChange={e => setEditForm(f => ({ ...f, spend_date: e.target.value }))}
                      style={inputStyle} />
                  </Field>
                  <Field label="Channel">
                    <select value={editForm.channel}
                      onChange={e => setEditForm(f => ({ ...f, channel: e.target.value as AdChannel }))}
                      style={inputStyle}>
                      <option value="">— Select —</option>
                      {AD_CHANNELS.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </Field>
                  <Field label="Amount (AUD)">
                    <input type="number" min={0} step="0.01" value={editForm.amount}
                      onChange={e => setEditForm(f => ({ ...f, amount: e.target.value }))}
                      style={inputStyle} />
                  </Field>
                  <Field label="Notes" full>
                    <input value={editForm.notes}
                      onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                      style={inputStyle} />
                  </Field>
                </div>
                <div style={{ marginTop:14, display:'flex', justifyContent:'flex-end' }}>
                  <button onClick={onEditSubmit} disabled={editSaving} style={primaryBtnStyle}>
                    {editSaving ? 'Saving…' : 'Update entry'}
                  </button>
                </div>
              </div>
            )}

            <SummaryCards summary={summary} />

            <div style={{ background:'#fff', border:`1px solid ${BORDER}`, borderRadius:10, overflow:'hidden' }}>
              <div style={{ padding:'12px 16px', background:'#f9fafb', borderBottom:`1px solid ${BORDER}`, display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
                {/* Date range filter */}
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <span style={{ fontSize:11, fontWeight:600, color:TEXT_SOFT, textTransform:'uppercase', letterSpacing:'0.05em' }}>From</span>
                  <input type="date" value={dateFrom}
                    onChange={e => setDateFrom(e.target.value)}
                    style={{ ...inputStyle, width:140, fontSize:12 }} />
                  <span style={{ fontSize:11, fontWeight:600, color:TEXT_SOFT, textTransform:'uppercase', letterSpacing:'0.05em' }}>To</span>
                  <input type="date" value={dateTo}
                    onChange={e => setDateTo(e.target.value)}
                    style={{ ...inputStyle, width:140, fontSize:12 }} />
                  {(dateFrom || dateTo) && (
                    <button onClick={() => { setDateFrom(''); setDateTo('') }}
                      style={{ ...smallBtnStyle, fontSize:11, padding:'4px 10px', color:TEXT_SOFT }}>
                      Clear
                    </button>
                  )}
                </div>

                <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:8 }}>
                  <div style={{ fontSize:13, fontWeight:600, color:TEXT }}>
                    {total.toLocaleString()} {total === 1 ? 'entry' : 'entries'}
                    {(dateFrom || dateTo || search) && <span style={{ color:TEXT_SOFT, fontWeight:400 }}> (filtered)</span>}
                  </div>
                  <div style={{ position:'relative' }}>
                    <input type="text" value={searchInput}
                      onChange={e => setSearchInput(e.target.value)}
                      placeholder="Search notes…"
                      style={{ ...inputStyle, paddingRight: searchInput ? 26 : 12, width:180, fontSize:12 }} />
                    {searchInput && (
                      <button onClick={() => setSearchInput('')} style={{ position:'absolute', right:6, top:'50%', transform:'translateY(-50%)', background:'transparent', border:'none', cursor:'pointer', color:'#9ca3af', fontSize:14, padding:2 }}>×</button>
                    )}
                  </div>
                </div>
              </div>

              {listErr && <div style={{ margin:16, background:'#fef2f2', border:'1px solid #fecaca', color:DANGER, borderRadius:8, padding:'10px 14px', fontSize:13 }}>{listErr}</div>}

              {loading ? (
                <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading…</div>
              ) : rows.length === 0 ? (
                <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>
                  No entries yet.{!isAdmin && ' Use Enter Week tab to add spend.'}
                </div>
              ) : (
                <div style={{ overflowX:'auto' }}>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13, minWidth:620 }}>
                    <thead>
                      <tr style={{ background:'#f9fafb' }}>
                        <Th>Date</Th><Th>Channel</Th>
                        <Th align="right">Spend</Th>
                        <Th>Notes</Th><Th>Entered by</Th><Th align="right">Actions</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.id} style={{ borderTop:`1px solid ${BORDER}`, background: editingId === r.id ? '#f0faf7' : undefined }}>
                          <Td>{r.spend_date}</Td>
                          <Td><Pill text={r.channel} /></Td>
                          <Td align="right"><strong>{AUD.format(r.amount)}</strong></Td>
                          <Td><span style={{ color:TEXT_SOFT }}>{r.notes || <Dim>—</Dim>}</span></Td>
                          <Td><span style={{ color:TEXT_SOFT }}>{r.entered_by_name || <Dim>—</Dim>}</span></Td>
                          <Td align="right">
                            {isEditable(r) ? (
                              <div style={{ display:'flex', gap:6, justifyContent:'flex-end' }}>
                                <button onClick={() => startEdit(r)} style={smallBtnStyle}>Edit</button>
                                <button onClick={() => onDelete(r)} style={{ ...smallBtnStyle, color:DANGER, borderColor:'#fecaca' }}>Delete</button>
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
                <Pagination total={total} limit={limit} offset={offset}
                  onChange={setOffset} onLimitChange={n => { setLimit(n); setOffset(0) }} />
              )}
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}

// ── Shared sub-components ─────────────────────────────────────
function SummaryCards({ summary }: { summary: AdSpendSummary | null }) {
  const loaded = summary !== null
  const topCh = loaded ? Object.entries(summary!.byChannel).sort((a,b) => b[1]-a[1])[0] : undefined
  const cards = loaded ? [
    { label:'Total Spend',    value: AUD.format(summary!.totalAmount), sub:`${summary!.total} entries` },
    { label:'Top Channel',    value: topCh?.[0] ?? '—', sub: topCh ? AUD.format(topCh[1]) : undefined },
    { label:'Channels Used',  value: String(Object.keys(summary!.byChannel).length) },
  ] : [
    { label:'Total Spend', value:'—' },
    { label:'Top Channel', value:'—' },
    { label:'Channels Used', value:'—' },
  ]
  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12, marginBottom:16 }}>
      {cards.map(c => (
        <div key={c.label} style={{ background:'#fff', border:`1px solid ${BORDER}`, borderRadius:10, padding:'14px 18px' }}>
          <div style={{ fontSize:11, color:TEXT_SOFT, fontWeight:600, letterSpacing:'0.06em', textTransform:'uppercase' }}>{c.label}</div>
          <div style={{ fontSize:22, fontWeight:700, color:TEXT, marginTop:4, fontFamily:"'DM Sans',sans-serif" }}>{c.value}</div>
          {c.sub && <div style={{ fontSize:12, color:TEXT_SOFT, marginTop:2 }}>{c.sub}</div>}
        </div>
      ))}
    </div>
  )
}

function Field({ label, children, full }: { label:string; children:React.ReactNode; full?:boolean }) {
  return (
    <label style={{ display:'flex', flexDirection:'column', gap:5, gridColumn: full ? '1/-1' : undefined }}>
      <span style={{ fontSize:12, color:TEXT_SOFT, fontWeight:500 }}>{label}</span>
      {children}
    </label>
  )
}
function Th({ children, align='left' }: { children:React.ReactNode; align?:'left'|'right' }) {
  return <th style={{ padding:'10px 14px', textAlign:align, fontSize:11, fontWeight:600, color:TEXT_SOFT, letterSpacing:'0.06em', textTransform:'uppercase', whiteSpace:'nowrap' }}>{children}</th>
}
function Td({ children, align='left' }: { children:React.ReactNode; align?:'left'|'right' }) {
  return <td style={{ padding:'10px 14px', textAlign:align, color:TEXT, verticalAlign:'top' }}>{children}</td>
}
function Dim({ children }: { children:React.ReactNode }) {
  return <span style={{ color:'#9ca3af' }}>{children}</span>
}
function Pill({ text }: { text:string }) {
  return <span style={{ background:'#f0faf7', color:TEAL, border:'1px solid #cdebde', padding:'2px 8px', borderRadius:999, fontSize:11, fontWeight:600 }}>{text}</span>
}

const inputStyle: React.CSSProperties = {
  width:'100%', padding:'9px 12px', border:`1px solid ${BORDER}`,
  borderRadius:7, fontSize:13, fontFamily:"'DM Sans',sans-serif",
  color:TEXT, boxSizing:'border-box', background:'#fff',
}
const primaryBtnStyle: React.CSSProperties = {
  background:TEAL, color:'#fff', border:'none', borderRadius:7,
  padding:'9px 18px', fontSize:13, fontWeight:600, cursor:'pointer',
  fontFamily:"'DM Sans',sans-serif",
}
const smallBtnStyle: React.CSSProperties = {
  background:'#fff', color:TEXT, border:`1px solid ${BORDER}`,
  borderRadius:6, padding:'5px 10px', fontSize:12, fontWeight:500,
  cursor:'pointer', fontFamily:"'DM Sans',sans-serif",
}
const navBtnStyle: React.CSSProperties = {
  background:'#fff', color:TEXT, border:`1px solid ${BORDER}`,
  borderRadius:8, padding:'6px 14px', fontSize:20, fontWeight:400,
  cursor:'pointer', lineHeight:1, fontFamily:'sans-serif',
}
