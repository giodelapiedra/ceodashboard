import api from './client'

export type EditEntityType = 'case_acceptance' | 'dropout'
export type EditRequestStatus = 'pending' | 'approved' | 'rejected'

export interface EditRequestDTO {
  id:                string
  entity_type:       EditEntityType
  entity_id:         string
  requested_by:      string
  requested_by_name: string | null
  reason:            string
  patch:             Record<string, unknown>
  clinic_id:         string | null
  patient_name:      string | null
  entry_date:        string | null
  status:            EditRequestStatus
  reviewed_by:       string | null
  reviewed_by_name:  string | null
  reviewed_at:       string | null
  rejection_reason:  string | null
  created_at:        string
  updated_at:        string
}

export interface PendingEditRef {
  entity_type: EditEntityType
  entity_id:   string
}

export interface CreateEditRequestPayload {
  entity_type: EditEntityType
  entity_id:   string
  reason:      string
  patch:       Record<string, unknown>
}

export const editRequestsApi = {
  /** ADMIN review queue — pending requests. */
  listPending: (): Promise<EditRequestDTO[]> =>
    api.get('/api/edit-requests').then(r => r.data.data),

  /** Entity refs the caller currently has an open request for. */
  mine: (): Promise<PendingEditRef[]> =>
    api.get('/api/edit-requests/mine').then(r => r.data.data),

  create: (payload: CreateEditRequestPayload): Promise<EditRequestDTO> =>
    api.post('/api/edit-requests', payload).then(r => r.data),

  approve: (id: string): Promise<void> =>
    api.post(`/api/edit-requests/${id}/approve`).then(() => {}),

  reject: (id: string, rejectionReason: string): Promise<void> =>
    api.post(`/api/edit-requests/${id}/reject`, { rejection_reason: rejectionReason }).then(() => {}),

  /** Recently rejected requests for the current user — drives the notification banner. */
  myRejected: (): Promise<EditRequestDTO[]> =>
    api.get('/api/edit-requests/mine/rejected').then(r => r.data.data),

  /** Dismiss a rejection banner permanently (server-side, survives any device/browser). */
  ackRejected: (id: string): Promise<void> =>
    api.post(`/api/edit-requests/${id}/ack`).then(() => {}),
}
