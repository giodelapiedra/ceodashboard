import React, { useCallback, useEffect, useRef, useState } from 'react'
import { weeklyKpiApi } from '../../api/weeklyKpi.api'
import { WeeklyKpiComment } from '../../types'
import { useAuthStore } from '../../store/auth.store'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/confirm.store'
import { useWeeklyKpiUnreadStore } from '../../store/weeklyKpiUnread.store'
import {
  ACCENT, SURFACE, BORDER, TEXT, TEXT_SOFT, TEXT_MUTED, TEXT_FAINT,
  FONT, captionStyle, stamp, Avatar, ErrorBanner, textareaStyle, primaryBtnStyle, smallBtnStyle,
} from './weeklyKpi.ui'

/**
 * The comment thread on one weekly KPI report — Sam's ask, 2026-08-24:
 * *"puwede rin mag comment si super admin regarding sa submitted weekly-kpi
 * tapos ma notify si clinician na nag comment"*, and his answer on the same day
 * that it should be two-way, so the physio can reply.
 *
 * Two parties only — the physio who owns the week, and the super admin. The
 * server enforces that (a non-participant gets a 404 on every endpoint here),
 * so this component does not branch on role for ACCESS. It branches on role
 * only for wording, because "reply to Sam" and "leave a note for Emma" are
 * different jobs even though they are the same POST.
 *
 * Mounted in three places, all of them behind an expanded report: the tracker's
 * open row, a week opened in the history list, and the physio's current week
 * under their own form. Opening the thread is what marks it read — hence the
 * markThreadRead on mount rather than on scroll or on reply.
 */
export default function WeeklyKpiComments({
  reportId,
  /** Whose week this is — used for the admin's placeholder and the empty state. */
  ownerName,
  /** Called after anything that changes the counts, so the row above can
   *  re-read its badge without this component knowing what a row is. */
  onChanged,
}: {
  reportId:   string
  ownerName?: string | null
  onChanged?: () => void
}) {
  const { user } = useAuthStore()
  const refreshUnread = useWeeklyKpiUnreadStore(s => s.refresh)

  const [comments, setComments] = useState<WeeklyKpiComment[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')
  const [draft,    setDraft]    = useState('')
  const [posting,  setPosting]  = useState(false)

  const [editingId,   setEditingId]   = useState<string | null>(null)
  const [editDraft,   setEditDraft]   = useState('')
  const [savingEdit,  setSavingEdit]  = useState(false)

  const isAdmin = user?.role === 'ADMIN'

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const t = await weeklyKpiApi.comments(reportId)
      setComments(t.comments)
    } catch (e: any) {
      setError(e.response?.data?.error?.message || 'Could not load the comments')
    } finally { setLoading(false) }
  }, [reportId])

  useEffect(() => { load() }, [load])

  /** Fire-and-forget: a failed read stamp leaves the badge lit, which is the
   *  harmless direction to fail in. */
  const markRead = useCallback(() => {
    weeklyKpiApi.markThreadRead(reportId)
      .then(() => { refreshUnread(); onChanged?.() })
      .catch(() => { /* best-effort */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId])

  // Opening the thread IS reading it — and the 60 s unread poll doubles as a
  // live update while it stays open: if the other party writes something after
  // this component mounted, the count for THIS report goes above zero and the
  // thread re-reads itself instead of sitting there stale until a reload.
  //
  // `handled` keeps that from turning into a request loop: marking read drives
  // the count back to zero, and a zero we caused is not news.
  const unreadHere = useWeeklyKpiUnreadStore(s => s.unreadFor(reportId))
  const handled = useRef<number | null>(null)
  useEffect(() => { handled.current = null }, [reportId])
  useEffect(() => {
    if (handled.current === unreadHere) return
    const firstPass = handled.current === null
    handled.current = unreadHere
    if (firstPass)        { markRead(); return }
    if (unreadHere === 0) return
    load(); markRead()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId, unreadHere])

  const post = async () => {
    const body = draft.trim()
    if (!body) return
    setPosting(true)
    try {
      const saved = await weeklyKpiApi.addComment(reportId, body)
      setComments(prev => [...prev, saved])
      setDraft('')
      refreshUnread(); onChanged?.()
    } catch (e: any) {
      const msg = e.response?.data?.error?.message || 'Could not post the comment'
      setError(msg); toast.error(msg)
    } finally { setPosting(false) }
  }

  const saveEdit = async (id: string) => {
    const body = editDraft.trim()
    if (!body) return
    setSavingEdit(true)
    try {
      const saved = await weeklyKpiApi.editComment(id, body)
      setComments(prev => prev.map(c => c.id === id ? saved : c))
      setEditingId(null)
    } catch (e: any) {
      const msg = e.response?.data?.error?.message || 'Could not save the change'
      setError(msg); toast.error(msg)
    } finally { setSavingEdit(false) }
  }

  const remove = async (c: WeeklyKpiComment) => {
    const ok = await confirmDialog.destructive({
      title:        'Delete this comment?',
      message:      'It will be removed from this week’s thread for both of you. This cannot be undone.',
      confirmLabel: 'Delete',
    })
    if (!ok) return
    try {
      await weeklyKpiApi.deleteComment(c.id)
      setComments(prev => prev.filter(x => x.id !== c.id))
      refreshUnread(); onChanged?.()
    } catch (e: any) {
      toast.error(e.response?.data?.error?.message || 'Could not delete the comment')
    }
  }

  const firstName = (ownerName ?? '').trim().split(/\s+/)[0] || 'this physio'

  return (
    <div style={{ borderTop: `1px solid ${BORDER}`, marginTop: 26, paddingTop: 22, maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 16 }}>
        <span style={captionStyle}>Conversation</span>
        {comments.length > 0 && (
          <span style={{ fontSize: 12, color: TEXT_FAINT }}>
            {comments.length} comment{comments.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <ErrorBanner message={error} />

      {loading && (
        <div style={{ fontSize: 13, color: TEXT_MUTED, marginBottom: 16 }}>Loading the conversation…</div>
      )}

      {!loading && comments.length === 0 && (
        <div style={{ fontSize: 13.5, color: TEXT_MUTED, lineHeight: 1.6, marginBottom: 18 }}>
          {isAdmin
            ? `No comments yet. Anything you write here goes to ${firstName} only — it is not visible to the rest of the team.`
            : 'No comments yet. Notes from Sam about this week will appear here, and you can reply to them.'}
        </div>
      )}

      {comments.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginBottom: 22 }}>
          {comments.map(c => {
            const mine = String(c.author_id) === String(user?.id)
            const editing = editingId === c.id
            return (
              <div key={c.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <Avatar name={c.author_name} size={30} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: TEXT, letterSpacing: '-0.01em' }}>
                      {mine ? 'You' : (c.author_name ?? 'Unknown')}
                    </span>
                    {/* Which side of the thread this came from. On a two-party
                        thread the role IS the identity, so it is worth the ink. */}
                    <span style={{ fontSize: 11.5, color: TEXT_FAINT }}>
                      {c.author_role === 'ADMIN' ? 'Super admin' : 'Physio'}
                    </span>
                    <span style={{ fontSize: 11.5, color: TEXT_FAINT }}>·</span>
                    <span style={{ fontSize: 11.5, color: TEXT_FAINT }} title={stamp(c.created_at)}>
                      {timeAgo(c.created_at)}
                    </span>
                    {c.edited && (
                      <span style={{ fontSize: 11.5, color: TEXT_FAINT }} title={stamp(c.updated_at)}>
                        · edited
                      </span>
                    )}
                  </div>

                  {editing ? (
                    <div style={{ marginTop: 8 }}>
                      <textarea
                        value={editDraft}
                        onChange={e => setEditDraft(e.target.value)}
                        style={{ ...textareaStyle, minHeight: 72 }}
                        autoFocus
                      />
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <button
                          onClick={() => saveEdit(c.id)}
                          disabled={savingEdit || !editDraft.trim()}
                          style={{
                            ...smallBtnStyle, background: ACCENT, color: '#fff', borderColor: ACCENT,
                            opacity: savingEdit || !editDraft.trim() ? 0.4 : 1,
                          }}
                        >{savingEdit ? 'Saving…' : 'Save'}</button>
                        <button onClick={() => setEditingId(null)} style={{ ...smallBtnStyle, color: TEXT_MUTED }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{
                        marginTop: 6, fontSize: 14, color: TEXT_SOFT,
                        lineHeight: 1.6, whiteSpace: 'pre-wrap',
                      }}>{c.body}</div>
                      {mine && (
                        <div style={{ display: 'flex', gap: 14, marginTop: 7 }}>
                          <LinkBtn label="Edit" onClick={() => { setEditingId(c.id); setEditDraft(c.body) }} />
                          <LinkBtn label="Delete" onClick={() => remove(c)} />
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Composer. Both sides get one — the thread is two-way by Sam's call. */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <Avatar name={user?.full_name ?? null} size={30} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              // Ctrl/Cmd+Enter posts. Plain Enter stays a newline: these are
              // paragraphs about someone's week, not chat one-liners.
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); post() }
            }}
            placeholder={isAdmin
              ? `Write a note for ${firstName} about this week…`
              : 'Reply…'}
            style={{ ...textareaStyle, minHeight: 76, background: SURFACE }}
          />
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, flexWrap: 'wrap',
          }}>
            <button
              onClick={post}
              disabled={posting || !draft.trim()}
              style={{
                ...primaryBtnStyle, padding: '9px 18px', fontSize: 13.5,
                opacity: posting || !draft.trim() ? 0.4 : 1,
                cursor:  posting || !draft.trim() ? 'not-allowed' : 'pointer',
              }}
            >{posting ? 'Posting…' : isAdmin ? 'Post comment' : 'Reply'}</button>
            <span style={{ fontSize: 11.5, color: TEXT_FAINT }}>
              Only {isAdmin ? firstName : 'Sam'} and you can see this thread.
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Text-only action. A full button for "Edit" would outweigh the comment. */
function LinkBtn({ label, onClick }: { label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        fontFamily: FONT, fontSize: 12, fontWeight: 500,
        color: hover ? ACCENT : TEXT_MUTED,
        textDecoration: hover ? 'underline' : 'none',
      }}
    >{label}</button>
  )
}

/** "3 min ago" / "yesterday" / a date once it stops being recent. Absolute
 *  stamps are still on the title attribute — this is for scanning, not for
 *  the record. */
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1)    return 'just now'
  if (mins < 60)   return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24)    return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  const days = Math.round(hrs / 24)
  if (days === 1)  return 'yesterday'
  if (days < 7)    return `${days} days ago`
  return stamp(iso).split(' · ')[0]
}
