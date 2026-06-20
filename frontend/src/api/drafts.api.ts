import api from './client'

/** Which entry form a draft belongs to. Must match the backend enum. */
export type DraftKind = 'dropout' | 'case_acceptance'

/**
 * A saved, work-in-progress entry. `form_data` is the verbatim FormState
 * snapshot from the page that saved it — typed via the generic so each page
 * restores its own shape. `clinic_id` / `patient_name` are denormalised copies
 * used only to label the draft in the list.
 */
export interface DraftDTO<T = Record<string, unknown>> {
  id:           string
  kind:         DraftKind
  clinic_id:    string | null
  patient_name: string | null
  form_data:    T
  created_at:   string
  updated_at:   string
}

export interface SaveDraftPayload<T = Record<string, unknown>> {
  kind:          DraftKind
  clinic_id?:    string | null
  patient_name?: string | null
  form_data:     T
}

export type UpdateDraftPayload<T = Record<string, unknown>> = Omit<SaveDraftPayload<T>, 'kind'>

export const draftsApi = {
  list: <T = Record<string, unknown>>(kind: DraftKind): Promise<DraftDTO<T>[]> =>
    api.get('/api/drafts', { params: { kind } }).then(r => r.data.data),

  create: <T = Record<string, unknown>>(payload: SaveDraftPayload<T>): Promise<DraftDTO<T>> =>
    api.post('/api/drafts', payload).then(r => r.data),

  update: <T = Record<string, unknown>>(id: string, payload: UpdateDraftPayload<T>): Promise<DraftDTO<T>> =>
    api.patch(`/api/drafts/${id}`, payload).then(r => r.data),

  remove: (id: string): Promise<void> =>
    api.delete(`/api/drafts/${id}`).then(() => {}),
}
