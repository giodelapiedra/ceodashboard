import api from './client'

export type DeleteEntityType = 'dropout' | 'case_acceptance'
export type DeleteRequestStatus = 'pending' | 'approved' | 'rejected'

export interface DeleteRequestDTO {
  id:                string
  entity_type:       DeleteEntityType
  entity_id:         string
  requested_by:      string
  requested_by_name: string | null
  reason:            string | null
  clinic_id:         string | null
  patient_name:      string | null
  entry_date:        string | null
  status:            DeleteRequestStatus
  reviewed_by:       string | null
  reviewed_by_name:  string | null
  reviewed_at:       string | null
  created_at:        string
  updated_at:        string
}

/** Lightweight ref used by entry pages to mark "delete requested" rows. */
export interface PendingRef {
  entity_type: DeleteEntityType
  entity_id:   string
}

export interface CreateDeleteRequestPayload {
  entity_type: DeleteEntityType
  entity_id:   string
  reason?:     string | null
}

export const deleteRequestsApi = {
  /** ADMIN review queue — pending requests. */
  listPending: (): Promise<DeleteRequestDTO[]> =>
    api.get('/api/delete-requests').then(r => r.data.data),

  /** Entity refs the caller currently has an open request for. */
  mine: (): Promise<PendingRef[]> =>
    api.get('/api/delete-requests/mine').then(r => r.data.data),

  create: (payload: CreateDeleteRequestPayload): Promise<DeleteRequestDTO> =>
    api.post('/api/delete-requests', payload).then(r => r.data),

  approve: (id: string): Promise<void> =>
    api.post(`/api/delete-requests/${id}/approve`).then(() => {}),

  reject: (id: string): Promise<void> =>
    api.post(`/api/delete-requests/${id}/reject`).then(() => {}),
}
