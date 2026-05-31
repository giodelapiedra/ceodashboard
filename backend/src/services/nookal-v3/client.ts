import axios, { AxiosInstance } from 'axios';
import { env } from '../../config/env';

/**
 * Nookal v3 GraphQL client — auth flow confirmed by live probing.
 *
 * Token exchange:
 *   POST {BASE}/oauth/token
 *     Authorization: Basic <BASIC_KEY verbatim>       ← NOT base64(id:secret)
 *     Content-Type:  application/x-www-form-urlencoded
 *     body: grant_type=client_credentials
 *   ->  { accessToken, accessTokenExpiresAt: ISO8601, client, user }
 *
 * Nookal's Basic Key is already the encoded credential — pass it verbatim
 * as the Basic auth value. The Client ID is informational only (displayed
 * in Nookal's admin for reference; not needed for auth).
 *
 * GraphQL:
 *   POST {BASE}/graphql
 *     Authorization: Bearer <accessToken>
 *     Content-Type:  application/json
 *
 * Access tokens are cached in-process until 60s before expiry.
 */

interface CachedToken {
  value:     string;
  expiresAt: number;
}

interface TokenResponse {
  accessToken:          string;
  accessTokenExpiresAt: string; // ISO timestamp
}

export interface GraphQLError {
  message:    string;
  path?:      (string | number)[];
  extensions?: Record<string, unknown>;
}

export interface GraphQLResponse<T> {
  data?:   T;
  errors?: GraphQLError[];
}

class UnauthorizedError extends Error {}
class TransientError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

/** Transient 5xx retries: 3 attempts, exponential backoff 400ms → 800ms → 1600ms. */
const TRANSIENT_MAX_ATTEMPTS = 3;
const TRANSIENT_BASE_DELAY_MS = 400;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class NookalV3Client {
  private http:         AxiosInstance;
  private token:        CachedToken | null = null;
  private tokenInFlight: Promise<string> | null = null;

  constructor() {
    this.http = axios.create({
      baseURL: env.NOOKAL_V3_BASE_URL,
      // 90 s — the "overall" dashboard fetches all 3 clinics concurrently;
      // each clinic's entries+invoice-map paginate up to ~10 pages in
      // parallel, so a single Nookal request can take up to ~60 s under
      // load. 30 s was too tight and caused spurious 500s.
      timeout: 90_000,
    });
  }

  /**
   * Serialize token acquisition so parallel GraphQL calls share one token.
   * Without this, each parallel query fetches its own token and Nookal
   * invalidates prior ones — triggering "Token has expired" storms.
   */
  private async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value;
    }
    if (this.tokenInFlight) return this.tokenInFlight;

    this.tokenInFlight = this.fetchToken().finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<string> {
    try {
      const res = await this.http.post<TokenResponse>(
        '/oauth/token',
        'grant_type=client_credentials',
        {
          headers: {
            'Authorization': `Basic ${env.NOOKAL_V3_CLIENT_SECRET}`,
            'Content-Type':  'application/x-www-form-urlencoded',
          },
        }
      );

      const { accessToken, accessTokenExpiresAt } = res.data;
      if (!accessToken || !accessTokenExpiresAt) {
        throw new Error(`unexpected token response: ${JSON.stringify(res.data)}`);
      }

      this.token = {
        value:     accessToken,
        expiresAt: new Date(accessTokenExpiresAt).getTime(),
      };
      return accessToken;
    } catch (err: any) {
      const detail = err.response?.data ?? err.message;
      throw new Error(`Nookal v3 OAuth failed: ${JSON.stringify(detail)}`);
    }
  }

  /**
   * Execute a GraphQL query.
   * - Automatically refreshes the token on 401 / "token expired".
   * - Retries up to 3x on transient 5xx responses from Nookal with
   *   exponential backoff (they sometimes return 502/503 mid-query).
   */
  async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const attempt = async (): Promise<T> => {
      const token = await this.getAccessToken();
      const res = await this.http.post<GraphQLResponse<T> | string>(
        '/graphql',
        { query, variables },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type':  'application/json',
          },
          validateStatus: () => true,
          // Nookal's 502 HTML page fails to parse as JSON; keep it as text.
          transformResponse: [(data) => data],
        }
      );

      const rawBody = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      let parsed: GraphQLResponse<T> | null = null;
      try { parsed = typeof res.data === 'string' ? JSON.parse(res.data) : (res.data as GraphQLResponse<T>); }
      catch { /* not JSON — 5xx HTML or the like */ }

      // Transient gateway/server errors — let the outer loop retry.
      if (res.status >= 500 && res.status < 600) {
        throw new TransientError(res.status, `HTTP ${res.status}: ${rawBody.slice(0, 200)}`);
      }

      // Auth failure or token expired — refresh and retry once.
      const isExpired = /token has expired|please supply a current bearer/i.test(rawBody);
      if (res.status === 401 || isExpired) {
        this.token = null;
        throw new UnauthorizedError();
      }

      if (res.status >= 400 || parsed?.errors?.length) {
        const msg = parsed?.errors?.map((e) => e.message).join('; ')
                 ?? `HTTP ${res.status}: ${rawBody.slice(0, 200)}`;
        throw new Error(`Nookal v3 GraphQL error: ${msg}`);
      }

      if (!parsed?.data) {
        throw new Error('Nookal v3 returned empty data');
      }
      return parsed.data;
    };

    let lastTransient: TransientError | null = null;
    for (let i = 0; i < TRANSIENT_MAX_ATTEMPTS; i++) {
      try {
        return await attempt();
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          // One auth refresh-and-retry. Don't eat our transient-retry budget.
          try { return await attempt(); }
          catch (err2) {
            if (err2 instanceof TransientError) { lastTransient = err2; }
            else throw err2;
          }
        } else if (err instanceof TransientError) {
          lastTransient = err;
        } else {
          throw err;
        }
        // Backoff 400ms → 800ms → 1600ms
        if (i < TRANSIENT_MAX_ATTEMPTS - 1) {
          const delay = TRANSIENT_BASE_DELAY_MS * Math.pow(2, i);
          console.warn(`[nookal-v3] transient error ${lastTransient?.status}, retrying in ${delay}ms`);
          await sleep(delay);
        }
      }
    }
    throw new Error(`Nookal v3 GraphQL error: ${lastTransient?.message ?? 'exhausted retries'}`);
  }
}

export const nookalV3 = new NookalV3Client();
