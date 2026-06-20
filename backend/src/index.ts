import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import { env } from './config/env';
import { runMigrations } from './db/migrate';
import { seedInitialUser } from './db/seed';
import { closePool } from './db/pool';

import authRoutes           from './routes/auth.routes';
import dashboardRoutes      from './routes/dashboard.routes';
import usersRoutes          from './features/users/users.routes';
import dropoutsRoutes       from './features/dropouts/dropouts.routes';
import caseAcceptanceRoutes from './features/case-acceptance/case-acceptance.routes';
import draftsRoutes          from './features/drafts/drafts.routes';
import adSpendRoutes         from './features/ad-spend/ad-spend.routes';
import auditLogRoutes        from './features/audit-log/audit-log.routes';
import { errorMiddleware } from './middleware/error.middleware';

const app = express();

app.use(helmet());
const allowedOrigins = env.FRONTEND_URL.split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin:      allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins,
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json());

app.use('/api/auth',            authRoutes);
app.use('/api/dashboard',       dashboardRoutes);
app.use('/api/users',           usersRoutes);
app.use('/api/dropouts',        dropoutsRoutes);
app.use('/api/case-acceptance', caseAcceptanceRoutes);
app.use('/api/drafts',          draftsRoutes);
app.use('/api/ad-spend',        adSpendRoutes);
app.use('/api/audit-log',       auditLogRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
});

app.use(errorMiddleware);

async function start() {
  await runMigrations();
  await seedInitialUser();

  const server = app.listen(env.PORT, () => {
    console.log(`\n🚀 PhysioWard Backend — http://localhost:${env.PORT}`);
    console.log(`   Health:    http://localhost:${env.PORT}/api/health`);
    console.log(`   Dashboard: http://localhost:${env.PORT}/api/dashboard/monthly?clinic=newport&month=4&year=2026\n`);
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[server] ${signal} received — shutting down`);
    server.close(async () => {
      await closePool();
      console.log('[server] clean exit');
      process.exit(0);
    });
    // Hard-kill after 10s if close() hangs
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
