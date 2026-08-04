import api from './client'

export const patientsApi = {
  // Autocomplete over patient names we've already encoded (dropouts + cases).
  // Returns up to 10 distinct names matching the typed prefix.
  suggest: (q: string): Promise<string[]> =>
    api.get('/api/patients/suggest', { params: { q } }).then(r => r.data),
}
