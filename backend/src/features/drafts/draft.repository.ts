import { query } from '../../db/pool';

/** Which entry form a draft belongs to. */
export type DraftKind = 'dropout' | 'case_acceptance';

export const DRAFT_KINDS: readonly DraftKind[] = ['dropout', 'case_acceptance'];

export interface DraftRow {
  id:           string;
  kind:         DraftKind;
  owner_id:     string;
  clinic_id:    string | null;
  patient_name: string | null;
  // Opaque snapshot of the frontend FormState. The backend never inspects its
  // shape — it round-trips verbatim.
  form_data:    Record<string, unknown>;
  created_at:   Date;
  updated_at:   Date;
}

export interface DraftDTO {
  id:           string;
  kind:         DraftKind;
  clinic_id:    string | null;
  patient_name: string | null;
  form_data:    Record<string, unknown>;
  created_at:   string;
  updated_at:   string;
}

function toDTO(row: DraftRow): DraftDTO {
  return {
    id:           row.id,
    kind:         row.kind,
    clinic_id:    row.clinic_id,
    patient_name: row.patient_name,
    form_data:    row.form_data,
    created_at:   row.created_at.toISOString(),
    updated_at:   row.updated_at.toISOString(),
  };
}

export interface SaveDraftInput {
  owner_id:     string;
  kind:         DraftKind;
  clinic_id:    string | null;
  patient_name: string | null;
  form_data:    Record<string, unknown>;
}

export interface UpdateDraftInput {
  clinic_id:    string | null;
  patient_name: string | null;
  form_data:    Record<string, unknown>;
}

export const draftRepository = {
  /** A user's drafts of one kind, newest first. */
  async listByOwner(ownerId: string, kind: DraftKind): Promise<DraftDTO[]> {
    const { rows } = await query<DraftRow>(
      `SELECT * FROM entry_drafts
        WHERE owner_id = $1 AND kind = $2
        ORDER BY updated_at DESC, id DESC`,
      [ownerId, kind]
    );
    return rows.map(toDTO);
  },

  /** How many drafts a user already has of one kind (for the per-user cap). */
  async countByOwner(ownerId: string, kind: DraftKind): Promise<number> {
    const { rows } = await query<{ total: string }>(
      `SELECT COUNT(*)::bigint AS total FROM entry_drafts WHERE owner_id = $1 AND kind = $2`,
      [ownerId, kind]
    );
    return Number(rows[0]?.total ?? 0);
  },

  /** Raw row incl. owner_id — used by the service for ownership checks. */
  async findRawById(id: string): Promise<DraftRow | null> {
    const { rows } = await query<DraftRow>(
      `SELECT * FROM entry_drafts WHERE id = $1 LIMIT 1`,
      [id]
    );
    return rows[0] ?? null;
  },

  async create(input: SaveDraftInput): Promise<DraftDTO> {
    const { rows } = await query<DraftRow>(
      `INSERT INTO entry_drafts (kind, owner_id, clinic_id, patient_name, form_data)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.kind, input.owner_id, input.clinic_id, input.patient_name, input.form_data]
    );
    return toDTO(rows[0]);
  },

  async update(id: string, patch: UpdateDraftInput): Promise<DraftDTO> {
    const { rows } = await query<DraftRow>(
      `UPDATE entry_drafts
          SET clinic_id    = $2,
              patient_name = $3,
              form_data    = $4,
              updated_at   = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, patch.clinic_id, patch.patient_name, patch.form_data]
    );
    return toDTO(rows[0]);
  },

  async delete(id: string): Promise<void> {
    await query(`DELETE FROM entry_drafts WHERE id = $1`, [id]);
  },
};
