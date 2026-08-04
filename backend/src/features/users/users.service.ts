import {
  userRepository, UserRow, UserPublicDTO, toPublicDTO,
  CreateUserInput, UpdateUserInput, ListUsersFilters,
} from '../../repositories/user.repository';
import { authService } from '../../services/auth.service';
import { refreshTokenRepository } from '../../repositories/refresh-token.repository';
import { Errors } from '../../shared/errors';
import { Role } from '../../shared/roles';

export const usersService = {
  async list(filters: ListUsersFilters): Promise<UserPublicDTO[]> {
    const rows = await userRepository.list(filters);
    return rows.map(toPublicDTO);
  },

  async get(id: string): Promise<UserPublicDTO> {
    const row = await userRepository.findById(id);
    if (!row) throw Errors.notFound(`User ${id} not found`);
    return toPublicDTO(row);
  },

  async create(input: {
    email:     string;
    password:  string;
    role:      Role;
    full_name: string;
    clinic_id: string | null;
  }): Promise<UserPublicDTO> {
    const existing = await userRepository.findByEmail(input.email);
    if (existing) throw Errors.conflict(`Email ${input.email} is already in use`);

    const passwordHash = await authService.hashPassword(input.password);
    const created = await userRepository.create({
      email:        input.email,
      passwordHash,
      role:         input.role,
      full_name:    input.full_name,
      clinic_id:    input.clinic_id,
    });
    return toPublicDTO(created);
  },

  async update(id: string, patch: UpdateUserInput): Promise<UserPublicDTO> {
    // Block updates to non-existent users explicitly so the route returns 404.
    const existing = await userRepository.findById(id);
    if (!existing) throw Errors.notFound(`User ${id} not found`);

    // Email is the login identifier, so it must stay unique. Reject if another
    // account already uses the requested address (case-insensitive match).
    if (patch.email !== undefined) {
      const clash = await userRepository.findByEmail(patch.email);
      if (clash && String(clash.id) !== String(id)) {
        throw Errors.conflict(`Email ${patch.email} is already in use`);
      }
    }

    const updated = await userRepository.update(id, patch);
    if (!updated) throw Errors.notFound(`User ${id} not found`);

    // If the role/clinic changed in a way that broadens or narrows access,
    // existing access tokens still carry the OLD claims for up to 15 minutes
    // (JWT TTL). Revoking refresh tokens forces the user back through login,
    // which is the safe choice for any role/clinic/is_active mutation.
    const sensitive =
      patch.role     !== undefined ||
      patch.clinic_id !== undefined ||
      patch.is_active !== undefined;
    if (sensitive) {
      await refreshTokenRepository.revokeAllForUser(id);
    }

    return toPublicDTO(updated);
  },

  async resetPassword(id: string, newPassword: string): Promise<void> {
    const existing = await userRepository.findById(id);
    if (!existing) throw Errors.notFound(`User ${id} not found`);

    const hash = await authService.hashPassword(newPassword);
    await userRepository.updatePassword(id, hash);
    // Force re-login on all devices.
    await refreshTokenRepository.revokeAllForUser(id);
  },

  async deactivate(id: string): Promise<UserPublicDTO> {
    return this.update(id, { is_active: false });
  },

  async reactivate(id: string): Promise<UserPublicDTO> {
    return this.update(id, { is_active: true });
  },

  /**
   * Used by the entry-form "clinician" dropdowns (and the admin filter
   * dropdowns). Only returns staff flagged to appear in pickers, so ex-physios
   * whose accounts stay active (and whose data stays in the dashboard) drop out
   * of the selection lists.
   */
  async listActiveByClinic(clinicId: string, role: Role): Promise<UserPublicDTO[]> {
    const rows = await userRepository.list({
      clinic_id:      clinicId,
      role,
      active:         true,
      show_in_picker: true,
      // A flagged super admin who also treats should surface in the clinician picker.
      include_also_clinician: role === 'CLINICIAN',
    });
    return rows.map(toPublicDTO);
  },

  /** Cross-clinic variant of {@link listActiveByClinic} (no clinic filter). */
  async listActiveForPicker(role: Role): Promise<UserPublicDTO[]> {
    const rows = await userRepository.list({
      role,
      active:         true,
      show_in_picker: true,
      include_also_clinician: role === 'CLINICIAN',
    });
    return rows.map(toPublicDTO);
  },
};
