/**
 * Drive the REAL app in a headless browser and screenshot /weekly-kpi at phone
 * and desktop widths. LOCAL DEV ONLY.
 *
 *     npm run shot:kpi-mobile
 *
 * WHY. Two things could not be checked any other way. Everything up to now has
 * verified the score and the wire shape; neither says whether a physio on a
 * phone can actually read the form. And the whole HTTP layer — Express routing,
 * auth middleware, the real fetch from the browser — had been typechecked but
 * never exercised end to end.
 *
 * This does both at once: it logs in through the real login form, so every
 * request the page makes goes through the real API, and it photographs the
 * result at 390px.
 *
 * It creates a throwaway clinician with a random password, uses it, and deletes
 * it — account and week — in a finally block. The account is created with
 * show_in_picker = false so it cannot appear on the tracker's "not submitted"
 * list or in a clinician dropdown even while it exists.
 *
 * Refuses to run against anything but localhost. It writes and deletes rows,
 * and it types a password into a login form.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import bcrypt from 'bcrypt';
import puppeteer from 'puppeteer';
import { pool, query } from '../src/db/pool';
import { env } from '../src/config/env';

const APP        = process.env.KPI_SHOT_URL ?? 'http://localhost:5173';
const TEST_EMAIL = '__kpi_shot@physioward.local';
const OUT_DIR    = path.join(__dirname, '../.shots');

function assertLocal(): void {
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(env.DATABASE_URL ?? '')) {
    throw new Error('shot:kpi-mobile refuses to run against a non-local DATABASE_URL.');
  }
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(APP)) {
    throw new Error(`shot:kpi-mobile refuses to drive a non-local app (${APP}).`);
  }
}

async function main(): Promise<void> {
  assertLocal();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Random every run: nothing reusable is ever left in the database, and the
  // password never appears in the repo.
  const password = crypto.randomBytes(18).toString('base64url');
  const hash     = await bcrypt.hash(password, 10);

  const { rows } = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, clinic_id, is_active, show_in_picker)
     VALUES ($1, $2, 'Mobile Screenshot', 'CLINICIAN', 'newport', true, false)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true
     RETURNING id`,
    [TEST_EMAIL, hash]
  );
  const userId = rows[0].id;

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // A small, common phone. If it reads here it reads on anything larger.
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

    const failures: string[] = [];
    page.on('pageerror', e => failures.push(`page error: ${e.message}`));
    page.on('response', r => {
      // Every API call the page makes, through the real Express stack. A 4xx/5xx
      // here is the HTTP-layer check failing, and it must not pass silently
      // just because the screenshot came out looking fine.
      if (!r.url().includes('/api/') || r.status() < 400) return;

      const route = new URL(r.url()).pathname;
      // Expected, not a fault: on a cold load the app asks to refresh a session
      // it does not have yet, and a 401 is how it learns to show the login
      // screen. Only this exact case is excused, and only before login.
      if (route.endsWith('/api/auth/refresh') && r.status() === 401 && !loggedIn) return;

      failures.push(`${r.status()} ${r.request().method()} ${route}`);
    });
    let loggedIn = false;

    await page.goto(APP, { waitUntil: 'networkidle2' });
    await page.waitForSelector('input[type="email"]');
    await page.type('input[type="email"]', TEST_EMAIL);
    await page.type('input[type="password"]', password);
    // The login button is a plain onClick handler, not a form submit, and the
    // app is a SPA — so there is no navigation event to await. Click, then wait
    // for the login form to go away, which is the only reliable signal that the
    // token actually came back.
    await page.click('.login-btn');
    await page.waitForFunction(
      () => !document.querySelector('input[type="password"]'),
      { timeout: 20000 },
    ).catch(() => { throw new Error('login did not complete — check the API and the credentials'); });
    loggedIn = true;

    await page.goto(`${APP}/weekly-kpi`, { waitUntil: 'networkidle2' });
    // The registry arrives on its own request; the signals are the thing being
    // photographed, so wait for one to exist rather than for a fixed delay.
    await page.waitForSelector('.pw-signal-row', { timeout: 20000 });

    // ── What the layout must satisfy on a phone ──────────────────────────────
    const audit = await page.evaluate(() => {
      const problems: string[] = []
      const seen = (el: Element | null): boolean =>
        !!el && getComputedStyle(el).display !== 'none' && (el as HTMLElement).offsetParent !== null

      // 1. Nothing may overflow sideways. A form you have to pan is unusable.
      if (document.documentElement.scrollWidth > window.innerWidth + 1) {
        problems.push(`page scrolls sideways: ${document.documentElement.scrollWidth}px > ${window.innerWidth}px`)
      }

      // 2. Every KPI cell must be labelled. The column header is hidden at this
      //    width, so the per-field labels have to be showing — exactly one of
      //    the two, never neither.
      const head  = document.querySelector('.pw-kpi-head')
      const label = document.querySelector('.pw-kpi-fieldlabel')
      if (seen(head))    problems.push('KPI column header still visible at 390px')
      if (!seen(label))  problems.push('KPI per-field labels missing — Target/Result would be unlabelled')

      const labels = Array.from(document.querySelectorAll('.pw-kpi-fieldlabel'))
        .map(el => el.textContent?.trim() ?? '')
      for (const want of ['Target', 'Result']) {
        if (!labels.includes(want)) problems.push(`"${want}" label not rendered on mobile`)
      }

      // 3. The signal rows must have stacked, not squeezed the buttons.
      const row = document.querySelector('.pw-signal-row')
      if (row && getComputedStyle(row).gridTemplateColumns.split(' ').length > 1) {
        problems.push('signal rows did not stack at 390px')
      }

      // 4. Nothing may stick out of the viewport.
      for (const el of Array.from(document.querySelectorAll('.pw-panel, .pw-signal-row, .pw-counts-grid, .pw-drain-row, input, textarea, button'))) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.right > window.innerWidth + 1) {
          problems.push(`${el.className || el.tagName} overflows the right edge by ${Math.round(r.right - window.innerWidth)}px`)
        }
      }

      // 5. Tap targets. Anything smaller than ~28px is a miss-tap on a phone.
      for (const el of Array.from(document.querySelectorAll('.pw-signal-row button, .pw-rating-scale button'))) {
        const r = el.getBoundingClientRect()
        if (r.height < 28) problems.push(`tap target only ${Math.round(r.height)}px tall: "${el.textContent}"`)
      }

      return { problems, signals: document.querySelectorAll('.pw-signal-row').length }
    })

    await page.screenshot({ path: path.join(OUT_DIR, 'weekly-kpi-390.png'), fullPage: true });

    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('.pw-signal-row', { timeout: 20000 });

    // The same check the other way round: on a wide screen the header row is
    // the label and the per-field labels must be off, or every cell is titled
    // twice.
    const wide = await page.evaluate(() => {
      const problems: string[] = []
      const seen = (el: Element | null): boolean =>
        !!el && getComputedStyle(el).display !== 'none'
      if (!seen(document.querySelector('.pw-kpi-head'))) problems.push('KPI column header missing on desktop')
      if (seen(document.querySelector('.pw-kpi-fieldlabel'))) problems.push('per-field labels duplicated on desktop')
      return problems
    })

    await page.screenshot({ path: path.join(OUT_DIR, 'weekly-kpi-1280.png'), fullPage: true });

    console.log(`signals rendered: ${audit.signals} (expected 30)`);
    if (audit.signals !== 30) failures.push(`rendered ${audit.signals} signals, expected 30`);

    const all = [...failures, ...audit.problems, ...wide];
    if (all.length === 0) {
      console.log('\nNo layout or API problems found.');
    } else {
      console.log('\nPROBLEMS:');
      for (const p of all) console.log(`  - ${p}`);
    }
    console.log(`\nScreenshots: ${OUT_DIR}`);
    process.exitCode = all.length === 0 ? 0 : 1;
  } finally {
    await browser.close();
    await query('DELETE FROM weekly_kpi_reports WHERE clinician_id = $1', [userId]);
    await query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
    console.log(`Cleaned up ${TEST_EMAIL}.`);
  }
}

main().catch(async (e) => {
  console.error('shot:kpi-mobile failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
