import { create } from 'zustand';
import axios from 'axios';
import { User } from '../types';

const SESSION_KEY = 'pw_session';

// localStorage persists across tabs and browser restarts (unlike sessionStorage
// which is per-tab and cleared when the tab/window closes). The access token is
// short-lived (8h) so the XSS exposure window stays manageable; the refresh
// token lives in an httpOnly cookie — XSS cannot reach it.
function saveSession(user: User, token: string) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ user, token })); } catch {}
}
function loadSession(): { user: User; token: string } | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

// Decode JWT expiry without verifying signature (client-side only)
function tokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp * 1000 < Date.now();
  } catch { return true; }
}

// Singleton in-flight refresh promise — prevents the race condition where
// multiple concurrent 401s each trigger a separate refresh. With refresh-token
// rotation, only the FIRST call succeeds; the rest see "invalid token" and log
// the user out. By reusing the same promise, every caller waits for the single
// in-progress refresh and then retries with the new token.
let _refreshInFlight: Promise<boolean> | null = null;

interface AuthState {
  user: User | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshToken: () => Promise<boolean>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user:            null,
  accessToken:     null,
  isAuthenticated: false,
  isLoading:       true,

  login: async (email, password) => {
    const res = await axios.post('/api/auth/login', { email, password }, { withCredentials: true });
    saveSession(res.data.user, res.data.accessToken);
    set({
      user:            res.data.user,
      accessToken:     res.data.accessToken,
      isAuthenticated: true,
      isLoading:       false,
    });
  },

  logout: async () => {
    const token = get().accessToken;
    clearSession();
    _refreshInFlight = null;
    try {
      await axios.post('/api/auth/logout', {}, {
        headers:         { Authorization: `Bearer ${token}` },
        withCredentials: true,
      });
    } catch {}
    set({ user: null, accessToken: null, isAuthenticated: false });
  },

  refreshToken: async () => {
    // If a refresh is already in flight, reuse it — don't fire a second one.
    if (_refreshInFlight) return _refreshInFlight;

    _refreshInFlight = (async (): Promise<boolean> => {
      // Fast path: restore from localStorage without a network round-trip.
      const saved = loadSession();
      if (saved && !tokenExpired(saved.token)) {
        set({ user: saved.user, accessToken: saved.token, isAuthenticated: true, isLoading: false });
        return true;
      }

      // Slow path: localStorage expired or missing — hit the refresh endpoint
      // which reads the httpOnly refresh-token cookie.
      try {
        const res = await axios.post('/api/auth/refresh', {}, { withCredentials: true });
        saveSession(res.data.user ?? get().user, res.data.accessToken);
        set({
          user:            res.data.user ?? get().user,
          accessToken:     res.data.accessToken,
          isAuthenticated: true,
          isLoading:       false,
        });
        return true;
      } catch {
        clearSession();
        set({ user: null, accessToken: null, isAuthenticated: false, isLoading: false });
        return false;
      }
    })().finally(() => {
      _refreshInFlight = null;
    });

    return _refreshInFlight;
  },
}));
