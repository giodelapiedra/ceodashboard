import { GoogleAdsApi } from 'google-ads-api';
import { env } from '../config/env';
import { Errors } from '../shared/errors';

export interface GoogleAdsDaySpend {
  spend_date:    string; // YYYY-MM-DD
  campaign_name: string;
  amount:        number; // AUD (account currency)
}

export async function fetchGoogleAdsSpend(
  dateFrom: string,
  dateTo:   string
): Promise<GoogleAdsDaySpend[]> {
  if (
    !env.GOOGLE_ADS_CLIENT_ID     ||
    !env.GOOGLE_ADS_CLIENT_SECRET ||
    !env.GOOGLE_ADS_DEVELOPER_TOKEN ||
    !env.GOOGLE_ADS_REFRESH_TOKEN ||
    !env.GOOGLE_ADS_CUSTOMER_ID
  ) {
    throw Errors.validation('Google Ads credentials not configured — add GOOGLE_ADS_* vars to .env');
  }

  const client = new GoogleAdsApi({
    client_id:       env.GOOGLE_ADS_CLIENT_ID,
    client_secret:   env.GOOGLE_ADS_CLIENT_SECRET,
    developer_token: env.GOOGLE_ADS_DEVELOPER_TOKEN,
  });

  const customer = client.Customer({
    customer_id:       env.GOOGLE_ADS_CUSTOMER_ID,
    refresh_token:     env.GOOGLE_ADS_REFRESH_TOKEN,
    login_customer_id: env.GOOGLE_ADS_MANAGER_ID,
  });

  const rows = await customer.query(`
    SELECT
      campaign.name,
      metrics.cost_micros,
      segments.date
    FROM campaign
    WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}'
      AND metrics.cost_micros > 0
    ORDER BY segments.date ASC
  `);

  return (rows as any[]).map(r => ({
    spend_date:    r.segments.date as string,
    campaign_name: r.campaign.name as string,
    amount:        Number(r.metrics.cost_micros ?? 0) / 1_000_000,
  }));
}
