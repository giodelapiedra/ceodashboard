import { create } from 'zustand'

/** One row of the side-by-side diff. */
export interface DuplicateField {
  label:    string
  /** Value already stored, rendered as-is. Use '—' for blanks. */
  existing: string
  /** Value the user just typed. */
  incoming: string
}

/**
 * The dialog only ever warns: save the new entry alongside the existing one, or
 * back out. Overwriting was removed on 2026-08-12 — it dragged non-admins into
 * the edit-request queue in the middle of an entry, and staff legitimately need
 * to log the same patient more than once.
 */
export type DuplicateChoice = 'save' | 'cancel'

export interface DuplicateOptions {
  /** e.g. 'This dropout entry is already logged' */
  title:        string
  /** Identity line: 'Cedric Adams · 28 Jul 2026 · Newport · Jane Doe' */
  subtitle:     string
  /** Provenance of the existing row: 'Encoded by Maria · 28 Jul, 9:12am' */
  existingMeta: string
  /** Diff rows. Unchanged fields are rendered dimmed, changed ones highlighted. */
  fields:       DuplicateField[]
  /** Primary button text. Defaults to 'Save anyway'. */
  saveLabel?:   string
  /** Optional caption beside the buttons. */
  saveNote?:    string
}

interface DuplicateRequest extends DuplicateOptions {
  id:      string
  resolve: (choice: DuplicateChoice) => void
}

interface DuplicateState {
  current: DuplicateRequest | null
  ask:     (opts: DuplicateOptions) => Promise<DuplicateChoice>
  resolve: (choice: DuplicateChoice) => void
}

export const useDuplicateStore = create<DuplicateState>((set, get) => ({
  current: null,

  ask: (opts) =>
    new Promise<DuplicateChoice>((resolve) => {
      // Same guard as confirm.store: a stale dialog resolves as a cancel so no
      // caller is ever left awaiting a promise that never settles.
      const previous = get().current
      if (previous) previous.resolve('cancel')

      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      set({ current: { ...opts, id, resolve } })
    }),

  resolve: (choice) => {
    const cur = get().current
    if (!cur) return
    cur.resolve(choice)
    set({ current: null })
  },
}))

// Convenience: keeps callsites short, mirrors confirmDialog.
export const duplicateDialog = {
  ask: (opts: DuplicateOptions): Promise<DuplicateChoice> =>
    useDuplicateStore.getState().ask(opts),
}
