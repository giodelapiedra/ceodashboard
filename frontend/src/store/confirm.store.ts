import { create } from 'zustand'

/**
 * How the dialog was closed.
 *
 * 'cancel' is the cancel BUTTON being pressed; 'dismiss' is Esc or a backdrop
 * click. Most callers can't tell them apart and shouldn't have to — both mean
 * "don't do it", which is what `ask()` returns as false. The split exists for
 * the one case where the cancel button is a real second action rather than a
 * way out: "Let me check" on the near-duplicate warning, which opens the
 * existing entry underneath the form. Esc must NOT do that.
 */
export type ConfirmOutcome = 'confirm' | 'cancel' | 'dismiss'

export interface ConfirmOptions {
  title:         string
  message:       string
  confirmLabel?: string
  cancelLabel?:  string
  /** Renders the confirm button in red and uses a danger icon. */
  destructive?:  boolean
}

interface ConfirmRequest extends ConfirmOptions {
  id:      string
  resolve: (outcome: ConfirmOutcome) => void
}

interface ConfirmState {
  current: ConfirmRequest | null
  ask:     (opts: ConfirmOptions) => Promise<ConfirmOutcome>
  resolve: (outcome: ConfirmOutcome) => void
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  current: null,

  ask: (opts) =>
    new Promise<ConfirmOutcome>((resolve) => {
      // If a previous dialog is still open, auto-cancel it. In practice the
      // user can't trigger two simultaneously, but this keeps state sane.
      const previous = get().current
      if (previous) previous.resolve('dismiss')

      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      set({ current: { ...opts, id, resolve } })
    }),

  resolve: (outcome) => {
    const cur = get().current
    if (!cur) return
    cur.resolve(outcome)
    set({ current: null })
  },
}))

// Convenience: keeps callsites short.
export const confirmDialog = {
  /** Did they say yes? The usual question, and the only one most callers have. */
  ask: async (opts: ConfirmOptions): Promise<boolean> =>
    (await useConfirmStore.getState().ask(opts)) === 'confirm',

  destructive: async (opts: Omit<ConfirmOptions, 'destructive'>): Promise<boolean> =>
    (await useConfirmStore.getState().ask({ ...opts, destructive: true })) === 'confirm',

  /** The full outcome — for a dialog whose cancel button is itself an action. */
  choose: (opts: ConfirmOptions): Promise<ConfirmOutcome> =>
    useConfirmStore.getState().ask(opts),
}
