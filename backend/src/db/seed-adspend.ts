/**
 * Seed the dedicated ad-spend encoder account (role ADSPEND).
 *
 * This account does ONE thing: log ad spend. It can't see the CEO dashboard,
 * dropouts, or case acceptance. clinic_id is NULL — ad spend is global.
 *
 * Credentials come from env vars (override on the live box), with safe
 * defaults. The encoder is expected to change the password after first login
 * (User Management → Reset PW, or have Sam reset it).
 *
 * Idempotent: if an account already exists at ADSPEND_EMAIL it is left
 * untouched (password NOT reset) — safe to re-run.
 *
 * Run with:  npm run db:seed:adspend
 *
 * Requires migration 010 to have been applied first (the ADSPEND role +
 * users_role_check / users_clinic_scope_check constraints must exist).
 */
import { pool } from './pool';
import { userRepository } from '../repositories/user.repository';
import { authService } from '../services/auth.service';

const EMAIL    = process.env.ADSPEND_EMAIL    ?? 'adspend@physioward.com.au';
const PASSWORD = process.env.ADSPEND_PASSWORD ?? 'ChangeMe123!';
const NAME     = process.env.ADSPEND_NAME     ?? 'Ad Spend Encoder';

export async function seedAdSpendUser(): Promise<void> {
  const existing = await userRepository.findByEmail(EMAIL);
  if (existing) {
    console.log(`\n⤴ Ad-spend account already exists — skipping: ${EMAIL}\n`);
    return;
  }

  const passwordHash = await authService.hashPassword(PASSWORD);
  await userRepository.create({
    email:        EMAIL,
    passwordHash,
    role:         'ADSPEND',
    full_name:    NAME,
    clinic_id:    null, // ad spend is global — no clinic
  });

  console.log('\n✓ Created ad-spend encoder account:');
  console.log(`  Name:      ${NAME}`);
  console.log(`  Email:     ${EMAIL}`);
  console.log(`  Password:  ${PASSWORD}`);
  console.log('  Role:      ADSPEND (ad-spend entry page only)');
  console.log('  → Change the password after first login.\n');
}

if (require.main === module) {
  seedAdSpendUser()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[db] ad-spend seed failed:', err);
      process.exit(1);
    });
}
