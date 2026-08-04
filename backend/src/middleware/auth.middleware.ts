import { Request, Response, NextFunction } from 'express';
import { authService, TokenPayload } from '../services/auth.service';
import { Role } from '../shared/roles';

/**
 * Security-relevant subset of the JWT payload, used as the first argument to
 * scope-aware repository methods. Repos must always apply this scope to query
 * filters — it is the single source of truth for "what data can this caller see".
 */
export interface RequestScope {
  userId:    string;
  role:      Role;
  /** null for ADMIN / FRONT_DESK_GLOBAL (cross-clinic). Set for CLINICIAN / FRONT_DESK. */
  clinic_id: string | null;
  /** Display name from the user account. Used by services to stamp
   *  front_staff_name on entries created by receptionist logins. */
  full_name: string | null;
  /** Login email. Always set for real requests (from the JWT); optional so the
   *  internal "act as ADMIN" scope literals in repos don't need to supply it.
   *  Used to gate account-specific access (e.g. the Meta/Google Leads section). */
  email?:    string;
}

export interface AuthRequest extends Request {
  user?:  TokenPayload;
  scope?: RequestScope;
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'No token provided' } });
  }

  const token   = authHeader.slice('Bearer '.length);
  const payload = authService.verifyAccessToken(token);

  if (!payload) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
  }

  req.user  = payload;
  req.scope = {
    userId:    payload.sub,
    role:      payload.role,
    clinic_id: payload.clinic_id,
    full_name: payload.full_name,
    email:     payload.email,
  };
  next();
}
