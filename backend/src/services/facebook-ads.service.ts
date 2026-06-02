import axios from 'axios';
import { env } from '../config/env';
import { Errors } from '../shared/errors';

export interface FacebookAdsDaySpend {
  spend_date:    string; // YYYY-MM-DD
  campaign_name: string;
  amount:        number; // AUD (account currency)
}

export async function fetchFacebookAdsSpend(
  dateFrom: string,
  dateTo:   string
): Promise<FacebookAdsDaySpend[]> {
  if (!env.FACEBOOK_ADS_ACCESS_TOKEN || !env.FACEBOOK_ADS_ACCOUNT_ID) {
    throw Errors.validation('Facebook Ads credentials not configured — add FACEBOOK_ADS_* vars to .env');
  }

  const results: FacebookAdsDaySpend[] = [];
  let url: string | null =
    `https://graph.facebook.com/v19.0/act_${env.FACEBOOK_ADS_ACCOUNT_ID}/insights`;
  let isFirst = true;

  while (url) {
    const params: Record<string, string> = {
      fields:         'spend,campaign_name,date_start',
      time_range:     JSON.stringify({ since: dateFrom, until: dateTo }),
      time_increment: '1',
      level:          'campaign',
      access_token:   env.FACEBOOK_ADS_ACCESS_TOKEN!,
      limit:          '500',
    };

    const resp = await axios.get<any>(isFirst ? url : url, isFirst ? { params } : {});
    const page: any = resp.data;

    for (const row of (page.data ?? [])) {
      const amount = parseFloat(row.spend ?? '0');
      if (amount > 0) {
        results.push({
          spend_date:    row.date_start as string,
          campaign_name: (row.campaign_name as string) || 'Unknown campaign',
          amount,
        });
      }
    }

    url = page.paging?.next ?? null;
    isFirst = false;
  }

  return results;
}
