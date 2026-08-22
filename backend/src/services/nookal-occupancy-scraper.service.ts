import puppeteer, { Browser, Page } from 'puppeteer';
import { env } from '../config/env';

/**
 * Browser-based scraper for the Nookal Occupancy report.
 *
 * The Occupancy report at Reports → Occupancy has no API endpoint — Nookal's v3
 * GraphQL has no roster/scheduled-minutes field, and v2's getSchedules only
 * works for fresh weeks (the roster drifts). This scraper automates the browser
 * to pull the exact figures Nookal displays.
 *
 * Requires NOOKAL_WEB_COMPANY_ID, NOOKAL_WEB_EMAIL and NOOKAL_WEB_PASSWORD in .env.
 */

export interface OccupancyReportRow {
  provider: string;
  scheduledMinutes: number;
  occupiedMinutes: number;
  occupancyPct: number;
}

export interface OccupancyScrapeResult {
  dateFrom: string;
  dateTo: string;
  rows: OccupancyReportRow[];
  scrapedAt: string;
}

const NOOKAL_LOGIN_URL = `${env.NOOKAL_WEB_URL}/v3.0/auth/login`;
const NOOKAL_OCCUPANCY_URL = `${env.NOOKAL_WEB_URL}/v2.5/reports/reports/occupancy`;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Parse a numeric value from Nookal's display format.
 * Handles "1,380", "102.17%", etc.
 */
function parseNum(value: string | null | undefined): number {
  if (!value) return 0;
  const cleaned = value.replace(/[^0-9.\-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Format a date as DD/MM/YYYY which is what Nookal's date picker expects.
 */
function formatDateForNookal(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const year = d.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

export class NookalOccupancyScraper {
  private browser: Browser | null = null;
  private page: Page | null = null;

  /**
   * Check if Nookal web credentials are configured.
   */
  static isConfigured(): boolean {
    return Boolean(env.NOOKAL_WEB_COMPANY_ID && env.NOOKAL_WEB_EMAIL && env.NOOKAL_WEB_PASSWORD);
  }

  /**
   * Initialize the browser instance.
   */
  async init(): Promise<void> {
    if (!NookalOccupancyScraper.isConfigured()) {
      throw new Error(
        'Nookal web credentials not configured. Set NOOKAL_WEB_EMAIL and NOOKAL_WEB_PASSWORD in .env'
      );
    }

    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
      ],
    });
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1920, height: 1080 });
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
  }

  /**
   * Clean up browser resources.
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  /**
   * Log into Nookal using web credentials.
   */
  async login(): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');

    console.log('[occupancy-scraper] Navigating to Nookal login...');
    await this.page.goto(NOOKAL_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(2000);

    // Fill using ID selectors
    console.log('[occupancy-scraper] Filling login form...');
    await this.page.waitForSelector('#login_company', { timeout: 10000 });
    
    await this.page.type('#login_company', env.NOOKAL_WEB_COMPANY_ID || '', { delay: 30 });
    await this.page.type('#login_email', env.NOOKAL_WEB_EMAIL || '', { delay: 30 });
    await this.page.type('#login_password', env.NOOKAL_WEB_PASSWORD || '', { delay: 30 });

    // Submit
    console.log('[occupancy-scraper] Submitting...');
    await this.page.keyboard.press('Enter');
    await delay(6000);
    
    const currentUrl = this.page.url();
    console.log('[occupancy-scraper] URL:', currentUrl);
    
    if (currentUrl.includes('/auth/login')) {
      throw new Error('Login failed');
    }
    
    console.log('[occupancy-scraper] Login OK');
  }

  /**
   * Navigate to the Occupancy report and set filters.
   */
  async navigateToOccupancyReport(dateFrom: string, dateTo: string): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');

    console.log(`[occupancy-scraper] Navigating to Occupancy report...`);
    await this.page.goto(NOOKAL_OCCUPANCY_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(3000);

    const dateFromFormatted = formatDateForNookal(dateFrom);
    const dateToFormatted = formatDateForNookal(dateTo);
    const dateRangeValue = `${dateFromFormatted} - ${dateToFormatted}`;
    
    console.log(`[occupancy-scraper] Setting date range: ${dateRangeValue}`);

    // Set date range and click Generate using evaluate
    await this.page.evaluate((dateRange: string) => {
      // Find and set date input
      const inputs = document.querySelectorAll('input');
      for (const input of inputs) {
        const value = input.value || '';
        if (value.match(/\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}\/\d{2}\/\d{4}/)) {
          input.value = dateRange;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }
      }
    }, dateRangeValue);

    await delay(1000);

    // Click Generate
    console.log('[occupancy-scraper] Clicking Generate...');
    await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.toLowerCase().includes('generate')) {
          btn.click();
          return;
        }
      }
    });

    console.log('[occupancy-scraper] Waiting for report...');
    await delay(5000);
    
    try {
      await this.page.waitForFunction(
        () => document.querySelectorAll('table tbody tr').length > 0,
        { timeout: 30000 }
      );
      console.log('[occupancy-scraper] Report loaded');
    } catch {
      console.log('[occupancy-scraper] Timeout waiting for table');
    }
  }

  /**
   * Scrape the occupancy data from the report table.
   * Nookal's table structure:
   * - Column 0: Provider name
   * - Column 1: Days
   * - Column 2: Scheduled Minutes
   * - Column 3: Occupied
   * - Column 4: Occupancy %
   */
  async scrapeOccupancyData(): Promise<OccupancyReportRow[]> {
    if (!this.page) throw new Error('Browser not initialized');

    console.log('[occupancy-scraper] Scraping occupancy data...');

    const rows = await this.page.evaluate(() => {
      const results: { provider: string; scheduled: string; occupied: string; occupancy: string }[] = [];
      const tableRows = document.querySelectorAll('table tbody tr');
      
      for (const row of tableRows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 5) continue;
        
        // Column 0: Provider name
        const provider = cells[0]?.textContent?.trim() || '';
        
        // Skip empty, header-like rows, or totals
        if (!provider || 
            provider.toLowerCase().includes('total') || 
            provider.toLowerCase().includes('provider')) {
          continue;
        }

        // Column 2: Scheduled Minutes
        const scheduled = cells[2]?.textContent?.trim() || '0';
        // Column 3: Occupied
        const occupied = cells[3]?.textContent?.trim() || '0';
        // Column 4: Occupancy %
        const occupancy = cells[4]?.textContent?.trim() || '0%';

        results.push({ provider, scheduled, occupied, occupancy });
      }
      
      return results;
    });

    const parsed: OccupancyReportRow[] = rows.map(row => ({
      provider: row.provider,
      scheduledMinutes: parseNum(row.scheduled),
      occupiedMinutes: parseNum(row.occupied),
      occupancyPct: parseNum(row.occupancy),
    }));

    // Filter out rows with no data (both scheduled and occupied are 0)
    const filtered = parsed.filter(row => 
      row.provider && (row.scheduledMinutes > 0 || row.occupiedMinutes > 0)
    );

    console.log(`[occupancy-scraper] Scraped ${filtered.length} provider rows with data (${parsed.length} total)`);
    return filtered;
  }

  /**
   * Full scrape: login, navigate, set filters, and extract data.
   */
  async scrapeOccupancy(dateFrom: string, dateTo: string): Promise<OccupancyScrapeResult> {
    try {
      await this.init();
      await this.login();
      await this.navigateToOccupancyReport(dateFrom, dateTo);
      const rows = await this.scrapeOccupancyData();

      return {
        dateFrom,
        dateTo,
        rows,
        scrapedAt: new Date().toISOString(),
      };
    } finally {
      await this.close();
    }
  }
}

/**
 * Convenience function to scrape occupancy for a date range.
 */
export async function scrapeNookalOccupancy(dateFrom: string, dateTo: string): Promise<OccupancyScrapeResult> {
  const scraper = new NookalOccupancyScraper();
  return scraper.scrapeOccupancy(dateFrom, dateTo);
}
