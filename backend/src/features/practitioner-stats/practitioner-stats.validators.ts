import { z } from 'zod';
import { CLINIC_IDS } from '../../shared/roles';

// Report period. Year is bounded generously rather than to "now" so a CEO can
// still open an old month after a year rolls over.
export const practitionerStatsQuerySchema = z.object({
  year:  z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  // Omitted → every clinic pooled, which is how the source spreadsheet's
  // Practitioner Stats tab reads (one board for the whole practice).
  clinic_id: z.enum(CLINIC_IDS).optional(),
});

export type PractitionerStatsQuery = z.infer<typeof practitionerStatsQuerySchema>;
