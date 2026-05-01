/**
 * Meridian API Server
 * Express + WebSocket — AI Governance Platform backend
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createClient } from 'redis';
import { PrismaClient } from '@prisma/client';

import { AgentMonitorService } from './services/AgentMonitorService';
import { RiskEngineService } from './services/RiskEngineService';
import { PolicyEnforcerService } from './services/PolicyEnforcerService';
import { EvidenceService } from './services/EvidenceService';
import { GovernanceAdvisorService } from './services/GovernanceAdvisorService';
import { enforcePolicy } from './routes/enforce';
import { systemsRouter } from './routes/systems';
import { agentsRouter } from './routes/agents';
import { incidentsRouter } from './routes/incidents';
import { evidenceRouter } from './routes/evidence';
import { policiesRouter } from './routes/policies';
import { advisorRouter } from './routes/advisor';
import { authMiddleware } from './middleware/auth';
import { auditMiddleware } from './middleware/audit';
import { logger } from './lib/logger';

// ─── INIT ──────────────────────────────────────────────────────────────────

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const prisma = new PrismaClient();
const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:3000', 'http://localhost:5173'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Rate limiting — more permissive for enforcement (latency-sensitive)
const enforceLimiter = rateLimit({
  windowMs: 1000,      // 1 second
  max: 500,            // 500 enforcement calls/sec per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'enforcement_rate_limit' },
  skipSuccessfulRequests: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/v1/enforce', enforceLimiter);
app.use('/v1', apiLimiter);
app.use('/v1', authMiddleware);
app.use('/v1', auditMiddleware(prisma));

// ─── SERVICES ──────────────────────────────────────────────────────────────

const agentMonitor = new AgentMonitorService(prisma, redis, wss);
const riskEngine = new RiskEngineService(prisma, redis);
const policyEnforcer = new PolicyEnforcerService(prisma, redis);
const evidenceService = new EvidenceService(prisma);
const advisor = new GovernanceAdvisorService(prisma);

// ─── ROUTES ────────────────────────────────────────────────────────────────

// Core enforcement — optimized for <10ms
app.post('/v1/enforce', enforcePolicy(policyEnforcer, agentMonitor));

// Resource routers
app.use('/v1/systems', systemsRouter(prisma, riskEngine));
app.use('/v1/agents', agentsRouter(prisma, agentMonitor));
app.use('/v1/incidents', incidentsRouter(prisma));
app.use('/v1/evidence', evidenceRouter(prisma, evidenceService));
app.use('/v1/policies', policiesRouter(prisma, policyEnforcer, advisor));
app.use('/v1/advisor', advisorRouter(prisma, advisor));

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: process.env.npm_package_version ?? '0.9.0',
    uptime: process.uptime(),
    prisma: prisma.$connect ? 'connected' : 'disconnected',
  });
});

// ─── WEBSOCKET ─────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const apiKey = new URL(req.url ?? '/', `http://localhost`).searchParams.get('key');
  if (!apiKey) { ws.close(4001, 'Missing API key'); return; }

  logger.info('WebSocket client connected');

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'subscribe' && Array.isArray(msg.events)) {
        // Register event subscriptions (stored in memory map)
        agentMonitor.subscribeClient(ws, msg.events);
      }
    } catch { /* ignore malformed */ }
  });

  ws.on('close', () => agentMonitor.unsubscribeClient(ws));
  ws.on('error', (err) => logger.error('WebSocket error', { err }));

  // Send initial snapshot
  ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
});

// ─── WEBHOOKS (incoming from integrations) ─────────────────────────────────

app.post('/webhooks/jira', express.json(), async (req, res) => {
  const { issue, webhookEvent } = req.body;
  if (webhookEvent === 'jira:issue_updated' && issue?.labels?.includes('ai-governance')) {
    await prisma.incident.updateMany({
      where: { externalId: issue.id },
      data: { status: issue.fields.status.name, updatedAt: new Date() },
    });
  }
  res.json({ ok: true });
});

app.post('/webhooks/slack', express.json(), async (req, res) => {
  // Slack URL verification
  if (req.body.type === 'url_verification') return res.json({ challenge: req.body.challenge });
  // Handle action callbacks from Slack modals
  res.json({ ok: true });
});

// ─── START ─────────────────────────────────────────────────────────────────

async function start() {
  await redis.connect();
  await prisma.$connect();
  await agentMonitor.init();
  await riskEngine.startScheduler();

  const PORT = parseInt(process.env.PORT ?? '4000');
  httpServer.listen(PORT, () => {
    logger.info(`Meridian API running on :${PORT}`);
    logger.info(`WebSocket server ready`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Graceful shutdown...');
    httpServer.close();
    await prisma.$disconnect();
    await redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => {
  logger.error('Startup failed', { err });
  process.exit(1);
});

export { app, wss };
