import { query } from '../../db/pool';

export type EditEntityType = 'case_acceptance' | 'dropout';
export const EDIT_ENTITY_TYPES: readonly EditEntityType[] = ['case_acceptance', 'dropout'];

export type EditRequestStatus = 'pending' | 'approved' | 'rejected';

export interface EditRequestRow {
  id:               string;
  entity_type:      EditEntityType;
  entity_id:        string;
  requested_by:     string;
  reason:           string;
  patch:            Record<string, unknown>;
  clinic_id:        string | null;
  patient_name:     string | null;
  entry_date:       Date | null;
  status:           EditRequestStatus;
  reviewed_by:      string | null;
  reviewed_at:      Date | null;
  rejection_reason: string | null;
  created_at:       Date;
  updated_at:       Date;
}

interface EditRequestJoinedRow extends EditRequestRow {
  requested_by_name: string | null;
  reviewed_by_name:  string | null;
}

export interface EditRequestDTO {
  id:                string;
  entity_type:       EditEntityType;
  entity_id:         string;
  requested_by:      string;
  requested_by_name: string | null;
  reason:            string;
  patch:             Record<string, unknown>;
  clinic_id:         string | null;
  patient_name:      string | null;
  entry_date:        string | null;
  status:            EditRequestStatus;
  reviewed_by:       string | null;
  reviewed_by_name:  string | null;
  reviewed_at:       string | null;
  rejection_reason:  string | null;
  created_at:        string;
  updated_at:        string;
}

export interface CreateEditRequestInput {
  entity_type:  EditEntityType;
  entity_id:    string;
  requested_by: string;
  reason:       string;
  patch:        Record<string, unknown>;
  clinic_id:    string | null;
  patient_name: string | null;
  entry_date:   string | null;
}

function isoDateOnly(d: Date | null): string | null {
  if (!d) return null;
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function toDTO(row: EditRequestJoinedRow): EditRequestDTO {
  return {
    id:                String(row.id),
    entity_type:       row.entity_type,
    entity_id:         String(row.entity_id),
    requested_by:      String(row.requested_by),
    requested_by_name: row.requested_by_name,
    reason:            row.reason,
    patch:             row.patch,
    clinic_id:         row.clinic_id,
    patient_name:      row.patient_name,
    entry_date:        isoDateOnly(row.entry_date),
    status:            row.status,
    reviewed_by:       row.reviewed_by ? String(row.reviewed_by) : null,
    reviewed_by_name:  row.reviewed_by_name,
    reviewed_at:       row.reviewed_at ? row.reviewed_at.toISOString() : null,
    rejection_reason:  row.rejection_reason ?? null,
    created_at:        row.created_at.toISOString(),
    updated_at:        row.updated_at.toISOString(),
  };
}

const SELECT_JOINED = `
  SELECT
    er.*,
    ru.full_name AS requested_by_name,
    rv.full_name AS reviewed_by_name
  FROM edit_requests er
  LEFT JOIN users ru ON ru.id = er.requested_by
  LEFT JOIN users rv ON rv.id = er.reviewed_by
`;

export const editRequestRepository = {
  async hasPending(entityType: EditEntityType, entityId: string): Promise<boolean> {
    const { rows } = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM edit_requests
          WHERE entity_type = $1 AND entity_id = $2 AND status = 'pending'
       ) AS exists`,
      [entityType, entityId]
    );
    return rows[0]?.exists ?? false;
  },

  async create(input: CreateEditRequestInput): Promise<EditRequestDTO> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO edit_requests
         (entity_type, entity_id, requested_by, reason, patch, clinic_id, patient_name, entry_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        input.entity_type, input.entity_id, input.requested_by, input.reason,
        JSON.stringify(input.patch), input.clinic_id, input.patient_name, input.entry_date,
      ]
    );
    const created = await this.findById(rows[0].id);
    if (!created) throw new Error('Failed to fetch newly created edit request');
    return created;
  },

  async findById(id: string): Promise<EditRequestDTO | null> {
    const { rows } = await query<EditRequestJoinedRow>(
      `${SELECT_JOINED} WHERE er.id = $1 LIMIT 1`,
      [id]
    );
    return rows[0] ? toDTO(rows[0]) : null;
  },

  async findRawById(id: string): Promise<EditRequestRow | null> {
    const { rows } = await query<EditRequestRow>(
      `SELECT * FROM edit_requests WHERE id = $1 LIMIT 1`,
      [id]
    );
    return rows[0] ?? null;
  },

  async listByStatus(status: EditRequestStatus): Promise<EditRequestDTO[]> {
    const { rows } = await query<EditRequestJoinedRow>(
      `${SELECT_JOINED} WHERE er.status = $1 ORDER BY er.created_at DESC`,
      [status]
    );
    return rows.map(toDTO);
  },

  async listPendingRefsByRequester(
    requesterId: string
  ): Promise<{ entity_type: EditEntityType; entity_id: string }[]> {
    const { rows } = await query<{ entity_type: EditEntityType; entity_id: string }>(
      `SELECT entity_type, entity_id::text FROM edit_requests
        WHERE requested_by = $1 AND status = 'pending'`,
      [requesterId]
    );
    return rows;
  },

  async setStatus(
    id: string,
    status: Exclude<EditRequestStatus, 'pending'>,
    reviewedBy: string,
    rejectionReason?: string | null
  ): Promise<void> {
    await query(
      `UPDATE edit_requests
          SET status = $2, reviewed_by = $3, reviewed_at = NOW(),
              rejection_reason = $4, updated_at = NOW()
        WHERE id = $1`,
      [id, status, reviewedBy, rejectionReason ?? null]
    );
  },

  /** Recently rejected requests for the requester — drives the "why was my edit rejected?" UI. */
  async listRejectedByRequester(requesterId: string): Promise<EditRequestDTO[]> {
    const { rows } = await query<EditRequestJoinedRow>(
      `${SELECT_JOINED}
        WHERE er.requested_by = $1
          AND er.status = 'rejected'
          AND er.requester_ack_at IS NULL
          AND er.reviewed_at > NOW() - INTERVAL '30 days'
        ORDER BY er.reviewed_at DESC`,
      [requesterId]
    );
    return rows.map(toDTO);
  },

  /** Requester dismissed the rejection banner — never show it again.
   *  Acks EVERY rejected request for the same entity, since the UI collapses
   *  them into one banner; acking only the newest would surface the older one. */
  async ackRejectedByRequester(requesterId: string, id: string): Promise<boolean> {
    const { rowCount } = await query(
      `UPDATE edit_requests
          SET requester_ack_at = NOW(), updated_at = NOW()
        WHERE requested_by = $2
          AND status = 'rejected'
          AND requester_ack_at IS NULL
          AND (entity_type, entity_id) IN (
            SELECT entity_type, entity_id FROM edit_requests
             WHERE id = $1 AND requested_by = $2
          )`,
      [id, requesterId]
    );
    return (rowCount ?? 0) > 0;
  },
};
