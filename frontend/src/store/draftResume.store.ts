import { create } from 'zustand'
import { DraftDTO } from '../api/drafts.api'

/**
 * Hand-off channel for "Resume" from the My Drafts tab. The Drafts page stashes
 * the chosen draft here and navigates to the matching entry page; that page
 * consumes it on mount (loading it into its form) and clears it. Keeps the two
 * pages decoupled — no prop drilling through the nav.
 */
interface DraftResumeState {
  pending: DraftDTO | null
  setPending: (d: DraftDTO) => void
  clear: () => void
}

export const useDraftResumeStore = create<DraftResumeState>((set) => ({
  pending: null,
  setPending: (d) => set({ pending: d }),
  clear: () => set({ pending: null }),
}))
