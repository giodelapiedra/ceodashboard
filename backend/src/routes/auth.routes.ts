import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { authService } from '../services/auth.service';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { userRepository } from '../repositories/user.repository';
import { refreshTokenRepository } from '../repositories/refresh-token.repository';
import { audit } from '../shared/audit';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  message:  { error: 'Too many login attempts. Try again in 15 minutes.' },
});

const REFRESH_COOKIE  = 'refreshToken';
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure:   env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   REFRESH_MAX_AGE,
    path:     '/api/auth',
  });
}

// POST /api/auth/login
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const user = await authService.authenticate(email, password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const tokens = await authService.issueTokens(user);
  setRefreshCookie(res, tokens.refreshToken);

  res.json({ accessToken: tokens.accessToken, user: tokens.user });
});

// POST /api/auth/refresh
router.post('/refresh', async (req: Request, res: Response) => {
  const presented = req.cookies?.[REFRESH_COOKIE];
  if (!presented) {
    return res.status(401).json({ error: 'No refresh token' });
  }

  const rotated = await authService.rotateRefresh(presented);
  if (!rotated) {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  setRefreshCookie(res, rotated.refreshToken);
  res.json({ accessToken: rotated.accessToken, user: rotated.user });
});

// POST /api/auth/logout
router.post('/logout', authMiddleware, async (req: Request, res: Response) => {
  const presented = req.cookies?.[REFRESH_COOKIE];
  if (presented) await authService.revokeRefresh(presented);

  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  res.json({ success: true });
});

// GET /api/auth/me
router.get('/me', authMiddleware, (req: AuthRequest, res: Response) => {
  res.json({ user: req.user });
});

// POST /api/auth/change-password
// Any authenticated user can change their own password.
// Requires the current password to be correct, min 8 chars for new password.
// All existing refresh tokens are revoked so every session must re-login.
router.post('/change-password', authMiddleware, async (req: AuthRequest, res: Response) => {
  const { current_password, new_password } = req.body ?? {};

  if (typeof current_password !== 'string' || typeof new_password !== 'string') {
    return res.status(400).json({ error: 'current_password and new_password are required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  // Fetch the full user row so we can verify the current password hash.
  const userId = req.user!.sub;
  const user   = await userRepository.findById(userId);
  if (!user || !user.is_active) {
    return res.status(403).json({ error: 'User not found or inactive' });
  }

  // Verify current password using authenticate (which also handles timing-equalization).
  const verified = await authService.authenticate(user.email, current_password);
  if (!verified) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  // Hash and persist the new password.
  const newHash = await authService.hashPassword(new_password);
  await userRepository.updatePassword(userId, newHash);

  // Revoke ALL refresh tokens for this user — every device/session must re-login.
  await refreshTokenRepository.revokeAllForUser(userId);

  // Clear the refresh cookie on this device too.
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });

  await audit(user.email, 'user.change_password', { userId });

  res.json({ success: true, message: 'Password changed. Please log in again.' });
});

export default router;
