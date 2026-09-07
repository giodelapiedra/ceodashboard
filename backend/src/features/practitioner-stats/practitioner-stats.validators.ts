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

/**
 * One practitioner-week's hand-read Nookal figures. Both are nullable so a
 * partially-filled week is savable and a mistyped figure can be cleared — a
 * blank has to stay distinguishable from a zero.
 */
export const upsertWeekInputSchema = z.object({
  clinician_id:  z.string().regex(/^\d+$/, 'Must be a numeric id'),
  year:          z.coerce.number().int().min(2020).max(2100),
  month:         z.coerce.number().int().min(1).max(12),
  // 5 is the Remainder column the sheet carries after Week 4.
  week_num:      z.coerce.number().int().min(1).max(5),
  total_appts:   z.number().int().min(0).max(10_000).nullable(),
  new_cases:     z.number().int().min(0).max(10_000).nullable(),
});

export type UpsertWeekInputBody = z.infer<typeof upsertWeekInputSchema>;
