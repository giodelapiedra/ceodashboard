import api from './client';
import { User, Role, ClinicId } from '../types';

export interface CreateUserPayload {
  email:     string;
  password:  string;
  full_name: string;
  role:      Role;
  clinic_id: ClinicId | null;
}

export interface UpdateUserPayload {
  full_name?: string;
  role?:      Role;
  clinic_id?: ClinicId | null;
  is_active?: boolean;
}

export const usersApi = {
  get: (id: string): Promise<User> =>
    api.get(`/api/users/${id}`).then(r => r.data),

  list: (filters?: { clinic_id?: ClinicId; role?: Role; active?: boolean }): Promise<User[]> =>
    api.get('/api/users', {
      params: filters && {
        clinic_id: filters.clinic_id,
        role:      filters.role,
        active:    filters.active === undefined ? undefined : String(filters.active),
      },
    }).then(r => r.data),

  staff: (role: Role, clinic_id?: ClinicId): Promise<User[]> =>
    api.get('/api/users/staff', { params: { role, clinic_id } }).then(r => r.data),

  create: (payload: CreateUserPayload): Promise<User> =>
    api.post('/api/users', payload).then(r => r.data),

  update: (id: string, patch: UpdateUserPayload): Promise<User> =>
    api.patch(`/api/users/${id}`, patch).then(r => r.data),

  resetPassword: (id: string, password: string): Promise<{ success: true }> =>
    api.post(`/api/users/${id}/password`, { password }).then(r => r.data),

  deactivate: (id: string): Promise<User> =>
    api.post(`/api/users/${id}/deactivate`).then(r => r.data),

  reactivate: (id: string): Promise<User> =>
    api.post(`/api/users/${id}/reactivate`).then(r => r.data),
};
