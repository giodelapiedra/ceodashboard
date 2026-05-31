import { z } from 'zod';
import { AD_CHANNELS, AdChannel } from '../../shared/roles';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

const channelEnum = z.enum([...AD_CHANNELS] as [AdChannel, ...AdChannel[]]);

const amountField = z.coerce
  .number()
  .min(0, 'Amount must be 0 or more')
  .max(10_000_000, 'Amount looks too large — double-check')
  .transform((v) => Math.round(v * 100) / 100);

const campaignField = z.string().min(1).max(200).trim().nullable();

const baseShape = {
  spend_date:    isoDate,
  channel:       channelEnum,
  campaign_name: campaignField.optional(),
  amount:        amountField,
  notes:         z.string().max(2000).nullable().optional(),
};

export const createAdSpendSchema = z.object(baseShape);

export const updateAdSpendSchema = z
  .object({
    spend_date:    isoDate.optional(),
    channel:       channelEnum.optional(),
    campaign_name: campaignField.optional(),
    amount:        amountField.optional(),
    notes:         z.string().max(2000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided',
  });

export const listAdSpendQuerySchema = z.object({
  date_from: isoDate.optional(),
  date_to:   isoDate.optional(),
  channel:   channelEnum.optional(),
  search:    z.string().trim().min(1).max(100).optional(),
  limit:     z.coerce.number().int().min(1).max(500).optional(),
  offset:    z.coerce.number().int().min(0).optional(),
});

export type CreateAdSpendBody = z.infer<typeof createAdSpendSchema>;
export type UpdateAdSpendBody = z.infer<typeof updateAdSpendSchema>;
