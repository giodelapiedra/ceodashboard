import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT:     z.coerce.number().default(3001),
  FRONTEND_URL: z.string().min(1).default('http://localhost:5173'),

  DATABASE_URL:   z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MAX:    z.coerce.number().default(10),
  DB_POOL_IDLE_MS: z.coerce.number().default(30_000),

  // ── Nookal v2 (REST) — still used for appointments, patients, inventory
  NOOKAL_API_KEY:  z.string().min(1),
  NOOKAL_BASE_URL: z.string().url(),
  NOOKAL_LOCATION_NEWPORT:   z.string().min(1),
  NOOKAL_LOCATION_NARRABEEN: z.string().min(1),
  NOOKAL_LOCATION_BROOKVALE: z.string().min(1),

  // ── Nookal v3 (GraphQL + OAuth) — used for the revenue report
  NOOKAL_V3_BASE_URL:      z.string().url().default('https://au-apiv3.nookal.com'),
  NOOKAL_V3_CLIENT_ID:     z.string().min(1),
  NOOKAL_V3_CLIENT_SECRET: z.string().min(1),
  // Real v3 location IDs (integers, different from v2 IDs). Discovered via
  // the `locations` query on 2026-04-22.
  NOOKAL_V3_LOCATION_NEWPORT:   z.coerce.number().int().default(1),
  NOOKAL_V3_LOCATION_NARRABEEN: z.coerce.number().int().default(2),
  NOOKAL_V3_LOCATION_BROOKVALE: z.coerce.number().int().default(6),

  // ── Google Ads API (optional — sync disabled when absent) ────
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().min(1).optional(),
  GOOGLE_ADS_CLIENT_ID:       z.string().min(1).optional(),
  GOOGLE_ADS_CLIENT_SECRET:   z.string().min(1).optional(),
  GOOGLE_ADS_REFRESH_TOKEN:   z.string().min(1).optional(),
  GOOGLE_ADS_CUSTOMER_ID:     z.string().min(1).optional(),
  GOOGLE_ADS_MANAGER_ID:      z.string().min(1).optional(),

  // ── Google Sheets API (import scripts only — optional in production) ─────
  GOOGLE_SHEETS_REFRESH_TOKEN:   z.string().min(1).optional(),
  GOOGLE_SHEETS_CLIENT_ID:       z.string().min(1).optional(),
  GOOGLE_SHEETS_CLIENT_SECRET:   z.string().min(1).optional(),
  GOOGLE_SHEETS_KEY_FILE:        z.string().min(1).optional(),

  CEO_EMAIL:    z.string().email(),
  CEO_PASSWORD: z.string().min(8),

  JWT_SECRET:     z.string().min(32, 'JWT_SECRET must be >= 32 chars'),
  JWT_EXPIRES_IN: z.string().default('15m'),

  SNAPSHOT_TTL_MINUTES: z.coerce.number().default(60),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('\n✗ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  console.error('\nCheck your .env file against .env.example\n');
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
