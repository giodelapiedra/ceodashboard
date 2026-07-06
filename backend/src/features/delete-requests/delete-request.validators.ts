import { z } from 'zod';
import { DELETE_ENTITY_TYPES, DeleteEntityType } from './delete-request.repository';

const entityTypeEnum = z.enum(
  [...DELETE_ENTITY_TYPES] as [DeleteEntityType, ...DeleteEntityType[]]
);
const idStr = z.string().regex(/^\d+$/, 'Must be a numeric id');

export const createDeleteRequestSchema = z.object({
  entity_type: entityTypeEnum,
  entity_id:   idStr,
  reason:      z.string().max(1000).trim().nullable().optional(),
});

export type CreateDeleteRequestBody = z.infer<typeof createDeleteRequestSchema>;
