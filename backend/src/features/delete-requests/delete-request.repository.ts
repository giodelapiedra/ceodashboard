import { query } from '../../db/pool';

export type DeleteEntityType = 'dropout' | 'case_acceptance';
export const DELETE_ENTITY_TYPES: readonly DeleteEntityType[] = ['dropout', 'case_acceptance'];

export type DeleteRequestStatus = 'pending' | 'approved' | 'rejected';

export interface DeleteRequestRow {
  id:           string;
  entity_type:  DeleteEntityType;
  entity_id:    string;
  requested_by: string;
  reason:       string | null;
  clinic_id:    string | null;
  patient_name: string | null;
  entry_date:   Date | null;
  status:       DeleteRequestStatus;
  reviewed_by:  string | null;
  reviewed_at:  Date | null;
  created_at:   Date;
  updated_at:   Date;
}

interface DeleteRequestJoinedRow extends DeleteRequestRow {
  requested_by_name: string | null;
  reviewed_by_name:  string | null;
}

export interface DeleteRequestDTO {
  id:                string;
  entity_type:       DeleteEntityType;
  entity_id:         string;
  requested_by:      string;
  requested_by_name: string | null;
  reason:            string | null;
  clinic_id:         string | null;
  patient_name:      string | null;
  entry_date:        string | null;
  status:            DeleteRequestStatus;
  reviewed_by:       string | null;
  reviewed_by_name:  string | null;
  reviewed_at:       string | null;
  created_at:        string;
  updated_at:        string;
}

function isoDateOnly(d: Date | null): string | null {
  if (!d) return null;
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function toDTO(row: DeleteRequestJoinedRow): DeleteRequestDTO {
  return {
    id:                row.id,
    entity_type:       row.entity_type,
    entity_id:         row.entity_id,
    requested_by:      row.requested_by,
    requested_by_name: row.requested_by_name,
    reason:            row.reason,
    clinic_id:         row.clinic_id,
    patient_name:      row.patient_name,
    entry_date:        isoDateOnly(row.entry_date),
    status:            row.status,
    reviewed_by:       row.reviewed_by,
    reviewed_by_name:  row.reviewed_by_name,
    reviewed_at:       row.reviewed_at ? row.reviewed_at.toISOString() : null,
    created_at:        row.created_at.toISOString(),
    updated_at:        row.updated_at.toISOString(),
  };
}

export interface CreateDeleteRequestInput {
  entity_type:  DeleteEntityType;
  entity_id:    string;
  requested_by: string;
  reason:       string | null;
  clinic_id:    string | null;
  patient_name: string | null;
  entry_date:   string | null;
}

const SELECT_JOINED = `
  SELECT
    dr.*,
    ru.full_name AS requested_by_name,
    rv.full_name AS reviewed_by_name
  FROM delete_requests dr
  LEFT JOIN users ru ON ru.id = dr.requested_by
  LEFT JOIN users rv ON rv.id = dr.reviewed_by
`;

export const deleteRequestRepository = {
  /** True if an OPEN request already exists for this entry. */
  async hasPending(entityType: DeleteEntityType, entityId: string): Promise<boolean> {
    const { rows } = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM delete_requests
          WHERE entity_type = $1 AND entity_id = $2 AND status = 'pending'
       ) AS exists`,
      [entityType, entityId]
    );
    return rows[0]?.exists ?? false;
  },

  async create(input: CreateDeleteRequestInput): Promise<DeleteRequestDTO> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO delete_requests
         (entity_type, entity_id, requested_by, reason, clinic_id, patient_name, entry_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        input.entity_type, input.entity_id, input.requested_by, input.reason,
        input.clinic_id, input.patient_name, input.entry_date,
      ]
    );
    const created = await this.findById(rows[0].id);
    if (!created) throw new Error('Failed to fetch newly created delete request');
    return created;
  },

  async findById(id: string): Promise<DeleteRequestDTO | null> {
    const { rows } = await query<DeleteRequestJoinedRow>(
      `${SELECT_JOINED} WHERE dr.id = $1 LIMIT 1`,
      [id]
    );
    return rows[0] ? toDTO(rows[0]) : null;
  },

  /** Raw row (incl. status) for the service's state checks. */
  async findRawById(id: string): Promise<DeleteRequestRow | null> {
    const { rows } = await query<DeleteRequestRow>(
      `SELECT * FROM delete_requests WHERE id = $1 LIMIT 1`,
      [id]
    );
    return rows[0] ?? null;
  },

  async listByStatus(status: DeleteRequestStatus): Promise<DeleteRequestDTO[]> {
    const { rows } = await query<DeleteRequestJoinedRow>(
      `${SELECT_JOINED} WHERE dr.status = $1 ORDER BY dr.created_at DESC`,
      [status]
    );
    return rows.map(toDTO);
  },

  /** Entity refs a given user currently has an OPEN request for. */
  async listPendingRefsByRequester(
    requesterId: string
  ): Promise<{ entity_type: DeleteEntityType; entity_id: string }[]> {
    const { rows } = await query<{ entity_type: DeleteEntityType; entity_id: string }>(
      `SELECT entity_type, entity_id FROM delete_requests
        WHERE requested_by = $1 AND status = 'pending'`,
      [requesterId]
    );
    return rows;
  },

  async setStatus(
    id: string,
    status: Exclude<DeleteRequestStatus, 'pending'>,
    reviewedBy: string
  ): Promise<void> {
    await query(
      `UPDATE delete_requests
          SET status = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [id, status, reviewedBy]
    );
  },
};
