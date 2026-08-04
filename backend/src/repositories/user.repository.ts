import { query } from '../db/pool';
import { Role } from '../shared/roles';

export interface UserRow {
  id:            string;
  email:         string;
  password_hash: string;
  role:          Role;
  full_name:     string | null;
  clinic_id:     string | null;
  is_active:     boolean;
  show_in_picker: boolean;
  /** When true, this account is also offered in the CLINICIAN picker even if
   *  its primary role isn't CLINICIAN (e.g. a super admin who also treats). */
  also_clinician: boolean;
  created_at:    Date;
  updated_at:    Date;
}

export interface UserPublicDTO {
  id:         string;
  email:      string;
  role:       Role;
  full_name:  string | null;
  clinic_id:  string | null;
  is_active:  boolean;
  show_in_picker: boolean;
  also_clinician: boolean;
  created_at: string;
}

export function toPublicDTO(row: UserRow): UserPublicDTO {
  return {
    id:         row.id,
    email:      row.email,
    role:       row.role,
    full_name:  row.full_name,
    clinic_id:  row.clinic_id,
    is_active:  row.is_active,
    show_in_picker: row.show_in_picker,
    also_clinician: row.also_clinician,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * May this account be tagged as the treating clinician on an entry?
 *
 * Must stay in step with the clinician picker (`include_also_clinician` in
 * ListUsersFilters): the picker offers real CLINICIAN accounts *plus* any
 * account flagged `also_clinician` (the CEO, who is admin and also treats).
 * The write side used to accept only role = 'CLINICIAN', so picking the
 * flagged admin surfaced "User <id> is not a clinician" on save.
 */
export function canBeTreatingClinician(row: Pick<UserRow, 'role' | 'also_clinician'>): boolean {
  return row.role === 'CLINICIAN' || row.also_clinician === true;
}

export interface CreateUserInput {
  email:        string;
  passwordHash: string;
  role:         Role;
  full_name:    string;
  clinic_id:    string | null;
}

export interface UpdateUserInput {
  email?:     string;
  full_name?: string;
  role?:      Role;
  clinic_id?: string | null;
  is_active?: boolean;
  show_in_picker?: boolean;
}

export interface ListUsersFilters {
  clinic_id?: string;
  role?:      Role;
  active?:    boolean;
  /** When true, only rows flagged to appear in staff pickers (excludes ex-staff). */
  show_in_picker?: boolean;
  /** When true, the `role` filter matches `role = X OR also_clinician = true`.
   *  Used by the clinician picker so a flagged super admin is also offered. */
  include_also_clinician?: boolean;
}

export const userRepository = {
  async findByEmail(email: string): Promise<UserRow | null> {
    const { rows } = await query<UserRow>(
      'SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [email]
    );
    return rows[0] ?? null;
  },

  async findById(id: string | number): Promise<UserRow | null> {
    const { rows } = await query<UserRow>(
      'SELECT * FROM users WHERE id = $1 LIMIT 1',
      [id]
    );
    return rows[0] ?? null;
  },

  async list(filters: ListUsersFilters = {}): Promise<UserRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filters.clinic_id !== undefined) {
      params.push(filters.clinic_id);
      where.push(`clinic_id = $${params.length}`);
    }
    if (filters.role !== undefined) {
      params.push(filters.role);
      if (filters.include_also_clinician) {
        where.push(`(role = $${params.length} OR also_clinician = true)`);
      } else {
        where.push(`role = $${params.length}`);
      }
    }
    if (filters.active !== undefined) {
      params.push(filters.active);
      where.push(`is_active = $${params.length}`);
    }
    if (filters.show_in_picker !== undefined) {
      params.push(filters.show_in_picker);
      where.push(`show_in_picker = $${params.length}`);
    }

    const sql = `
      SELECT *
      FROM users
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY role, full_name NULLS LAST, email
    `;
    const { rows } = await query<UserRow>(sql, params);
    return rows;
  },

  async create(input: CreateUserInput): Promise<UserRow> {
    const { rows } = await query<UserRow>(
      `INSERT INTO users (email, password_hash, role, full_name, clinic_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.email, input.passwordHash, input.role, input.full_name, input.clinic_id]
    );
    return rows[0];
  },

  async update(id: string | number, patch: UpdateUserInput): Promise<UserRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.email !== undefined) {
      params.push(patch.email);
      sets.push(`email = $${params.length}`);
    }
    if (patch.full_name !== undefined) {
      params.push(patch.full_name);
      sets.push(`full_name = $${params.length}`);
    }
    if (patch.role !== undefined) {
      params.push(patch.role);
      sets.push(`role = $${params.length}`);
    }
    if (patch.clinic_id !== undefined) {
      params.push(patch.clinic_id);
      sets.push(`clinic_id = $${params.length}`);
    }
    if (patch.is_active !== undefined) {
      params.push(patch.is_active);
      sets.push(`is_active = $${params.length}`);
    }
    if (patch.show_in_picker !== undefined) {
      params.push(patch.show_in_picker);
      sets.push(`show_in_picker = $${params.length}`);
    }

    if (sets.length === 0) return this.findById(id);

    sets.push(`updated_at = NOW()`);
    params.push(id);

    const { rows } = await query<UserRow>(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    return rows[0] ?? null;
  },

  async updatePassword(id: string | number, passwordHash: string): Promise<void> {
    await query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [passwordHash, id]
    );
  },
};
