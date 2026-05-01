/**
 * AgentMonitorService
 * 
 * Real-time agent monitoring, behavioral fingerprinting (AgentDNA™),
 * and <10ms policy enforcement via WebSocket telemetry.
 */

import { PrismaClient } from '@prisma/client';
import { RedisClientType } from 'redis';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../lib/logger';

// ─── TYPES ─────────────────────────────────────────────────────────────────

export interface AgentAction {
  agentId: string;
  actionType: string;
  resource?: string;
  payload?: Record<string, unknown>;
  timestamp: Date;
}

export interface AgentState {
  agentId: string;
  name: string;
  status: 'active' | 'idle' | 'blocked' | 'killed';
  autonomyLevel: number;        // 1–4
  actionsToday: number;
  violationsToday: number;
  dnaScore: number;             // Jensen-Shannon divergence from baseline
  lastSeen: Date;
}

export interface PolicyViolation {
  agentId: string;
  actionId: string;
  policyId: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  blocked: boolean;
  reason: string;
  timestamp: Date;
}

// ─── AGENTDNA™ FINGERPRINT ─────────────────────────────────────────────────

interface ActionDistribution {
  [actionType: string]: number; // count
}

function computeJensenShannondivergence(
  baseline: ActionDistribution,
  current: ActionDistribution
): number {
  const allKeys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const total_b = Object.values(baseline).reduce((a, b) => a + b, 0) || 1;
  const total_c = Object.values(current).reduce((a, b) => a + b, 0) || 1;

  // Normalize to probability distributions
  const p: number[] = [], q: number[] = [];
  allKeys.forEach(k => {
    p.push((baseline[k] ?? 0) / total_b);
    q.push((current[k] ?? 0) / total_c);
  });

  // Compute mixture M = (P + Q) / 2
  const m = p.map((pi, i) => (pi + q[i]) / 2);

  const klPM = p.reduce((sum, pi, i) => {
    if (pi === 0) return sum;
    return sum + pi * Math.log2(pi / (m[i] + 1e-10));
  }, 0);

  const klQM = q.reduce((sum, qi, i) => {
    if (qi === 0) return sum;
    return sum + qi * Math.log2(qi / (m[i] + 1e-10));
  }, 0);

  // JSD is bounded [0, 1]
  return Math.min(1, Math.max(0, (klPM + klQM) / 2));
}

// ─── SERVICE ────────────────────────────────────────────────────────────────

export class AgentMonitorService {
  private readonly prisma: PrismaClient;
  private readonly redis: RedisClientType;
  private readonly wss: WebSocketServer;

  // In-memory agent state (fast reads for enforcement path)
  private agentStates = new Map<string, AgentState>();
  // WebSocket client → subscribed events
  private clientSubs = new Map<WebSocket, Set<string>>();

  constructor(prisma: PrismaClient, redis: RedisClientType, wss: WebSocketServer) {
    this.prisma = prisma;
    this.redis = redis;
    this.wss = wss;
  }

  async init(): Promise<void> {
    // Load agent states from DB into memory
    const agents = await this.prisma.agent.findMany({
      where: { status: { in: ['active', 'idle'] } },
    });
    agents.forEach(a => {
      this.agentStates.set(a.id, {
        agentId: a.id,
        name: a.name,
        status: a.status as AgentState['status'],
        autonomyLevel: a.autonomyLevel,
        actionsToday: 0,
        violationsToday: 0,
        dnaScore: 0,
        lastSeen: a.updatedAt,
      });
    });

    logger.info(`AgentMonitorService initialized — ${agents.length} agents loaded`);

    // Heartbeat simulation for demo agents
    this.startHeartbeat();
  }

  /**
   * Core enforcement method — called on every agent action.
   * Must complete in <10ms to avoid adding latency to agent workflows.
   */
  async ingestAction(action: AgentAction): Promise<{
    allowed: boolean;
    violation?: PolicyViolation;
    latencyMs: number;
  }> {
    const start = performance.now();

    // Fast path: check autonomy level first (in-memory, ~0.1ms)
    const state = this.agentStates.get(action.agentId);
    if (state?.status === 'blocked' || state?.status === 'killed') {
      return {
        allowed: false,
        violation: {
          agentId: action.agentId,
          actionId: crypto.randomUUID(),
          policyId: 'AGENT_KILLED',
          severity: 'critical',
          blocked: true,
          reason: `Agent ${action.agentId} is ${state.status}`,
          timestamp: new Date(),
        },
        latencyMs: performance.now() - start,
      };
    }

    // Check Redis policy cache (~1–2ms)
    const policyKey = `policy:${action.agentId}:${action.actionType}`;
    const cachedPolicy = await this.redis.get(policyKey);

    if (cachedPolicy) {
      const policy = JSON.parse(cachedPolicy) as { allowed: boolean; policyId: string; reason: string };
      if (!policy.allowed) {
        this.recordViolation(action, policy.policyId, policy.reason);
        return {
          allowed: false,
          violation: {
            agentId: action.agentId,
            actionId: crypto.randomUUID(),
            policyId: policy.policyId,
            severity: 'high',
            blocked: true,
            reason: policy.reason,
            timestamp: new Date(),
          },
          latencyMs: performance.now() - start,
        };
      }
    }

    // Update action distribution for AgentDNA™ fingerprinting
    await this.updateDNA(action);

    // Async DB write (non-blocking — doesn't add to latency)
    setImmediate(() => this.persistAction(action));

    if (state) {
      state.actionsToday++;
      state.lastSeen = new Date();
    }

    return { allowed: true, latencyMs: performance.now() - start };
  }

  /**
   * AgentDNA™: Update behavioral fingerprint and compute JSD from baseline.
   */
  private async updateDNA(action: AgentAction): Promise<void> {
    const baselineKey = `dna:baseline:${action.agentId}`;
    const currentKey = `dna:current:${action.agentId}:${this.todayKey()}`;

    // Increment current action count
    await this.redis.hIncrBy(currentKey, action.actionType, 1);
    await this.redis.expire(currentKey, 86400 * 7); // 7 day TTL

    // Compute divergence from baseline
    const [baseline, current] = await Promise.all([
      this.redis.hGetAll(baselineKey),
      this.redis.hGetAll(currentKey),
    ]);

    if (Object.keys(baseline).length > 0) {
      const baselineDist: ActionDistribution = {};
      const currentDist: ActionDistribution = {};
      Object.entries(baseline).forEach(([k, v]) => (baselineDist[k] = Number(v)));
      Object.entries(current).forEach(([k, v]) => (currentDist[k] = Number(v)));

      const jsd = computeJensenShannondivergence(baselineDist, currentDist);

      const state = this.agentStates.get(action.agentId);
      if (state) state.dnaScore = jsd;

      // Emit drift event if divergence is high
      if (jsd > 0.7) {
        this.broadcast('drift_detected', {
          agentId: action.agentId,
          divergenceScore: jsd,
          anomalyDetected: true,
          capturedAt: new Date().toISOString(),
        });
      }
    }
  }

  /** Persist action to DB asynchronously */
  private async persistAction(action: AgentAction): Promise<void> {
    try {
      await this.prisma.agentAction.create({
        data: {
          agentId: action.agentId,
          actionType: action.actionType,
          resource: action.resource,
          payload: action.payload as object ?? {},
          timestamp: action.timestamp,
          allowed: true,
        },
      });
    } catch (err) {
      logger.error('Failed to persist agent action', { err, agentId: action.agentId });
    }
  }

  private async recordViolation(
    action: AgentAction,
    policyId: string,
    reason: string
  ): Promise<void> {
    const state = this.agentStates.get(action.agentId);
    if (state) state.violationsToday++;

    // Auto-kill on repeated critical violations
    if (state && state.violationsToday >= 5) {
      state.status = 'killed';
      this.broadcast('action_blocked', {
        agentId: action.agentId,
        reason: 'Auto-killed after 5 violations',
        policyId: 'AUTO_KILL',
      });
    }

    this.broadcast('action_blocked', { agentId: action.agentId, policyId, reason });

    setImmediate(() =>
      this.prisma.agentAction.create({
        data: {
          agentId: action.agentId,
          actionType: action.actionType,
          resource: action.resource,
          payload: action.payload as object ?? {},
          timestamp: action.timestamp,
          allowed: false,
          policyViolation: policyId,
        },
      }).catch(err => logger.error('Failed to persist violation', { err }))
    );
  }

  /** Broadcast event to all subscribed WebSocket clients */
  broadcast(eventType: string, data: unknown): void {
    const msg = JSON.stringify({ type: eventType, data, timestamp: new Date().toISOString() });
    this.clientSubs.forEach((subs, client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (subs.size === 0 || subs.has(eventType)) {
        client.send(msg);
      }
    });
  }

  subscribeClient(ws: WebSocket, events: string[]): void {
    this.clientSubs.set(ws, new Set(events));
  }

  unsubscribeClient(ws: WebSocket): void {
    this.clientSubs.delete(ws);
  }

  getAgentState(agentId: string): AgentState | undefined {
    return this.agentStates.get(agentId);
  }

  getAllStates(): AgentState[] {
    return [...this.agentStates.values()];
  }

  async killAgent(agentId: string, reason: string): Promise<void> {
    const state = this.agentStates.get(agentId);
    if (state) state.status = 'killed';
    await this.prisma.agent.update({ where: { id: agentId }, data: { status: 'killed' } });
    this.broadcast('agent_killed', { agentId, reason });
    logger.warn('Agent killed', { agentId, reason });
  }

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private startHeartbeat(): void {
    setInterval(() => {
      this.agentStates.forEach(state => {
        if (state.status === 'active') {
          this.broadcast('agent_heartbeat', {
            agentId: state.agentId,
            actionsToday: state.actionsToday,
            dnaScore: state.dnaScore,
          });
        }
      });
    }, 5000);
  }
}
