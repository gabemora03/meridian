/**
 * @meridian/sdk — TypeScript client library
 * AI Governance enforcement layer for any agent or model
 * 
 * Install: npm install @meridian/sdk
 * Docs: https://docs.meridian.ai/sdk
 */

import EventEmitter from 'events';
import WebSocket from 'ws';

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface MeridianConfig {
  apiKey: string;
  baseUrl?: string;
  wsUrl?: string;
  orgId?: string;
  timeout?: number;        // ms, default 10000
  enforceSync?: boolean;   // wait for enforcement decision (default true)
}

export interface AgentAction {
  actionType: string;      // 'send_email' | 'commit_transaction' | 'call_api' | ...
  resource?: string;       // target resource identifier
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface GovernanceResult {
  allowed: boolean;
  decision: 'allow' | 'block' | 'escalate' | 'modify';
  latencyMs: number;
  policyId?: string;
  reason?: string;
  auditId: string;
  modifiedPayload?: Record<string, unknown>; // if decision === 'modify'
}

export interface RiskAssessment {
  systemId: string;
  overallScore: number;         // 0–100 risk score (100 = highest risk)
  monetaryExposure: number;     // Expected annual loss in USD
  monetaryCI: { p5: number; p95: number }; // 90% confidence interval
  biasScore: number;
  privacyScore: number;
  driftScore: number;           // AgentDNA™ Jensen-Shannon divergence
  frameworks: FrameworkCoverage[];
  recommendations: Recommendation[];
  assessedAt: Date;
}

export interface FrameworkCoverage {
  frameworkId: string;          // 'eu-ai-act' | 'nist-rmf' | 'iso-42001' | ...
  coverage: number;             // 0–100 percentage
  gaps: string[];
  nextReviewAt?: Date;
}

export interface Recommendation {
  priority: 'critical' | 'high' | 'medium' | 'low';
  action: string;
  monetaryImpact?: number;
  dueAt?: Date;
}

export interface AgentDNA {
  agentId: string;
  baselineEstablished: boolean;
  divergenceScore: number;      // Jensen-Shannon divergence 0–1
  anomalyDetected: boolean;
  actionDistribution: Record<string, number>;
  capturedAt: Date;
}

export type GovernanceEvent =
  | { type: 'action_blocked'; data: GovernanceResult }
  | { type: 'drift_detected'; data: AgentDNA }
  | { type: 'risk_elevated'; data: { systemId: string; delta: number } }
  | { type: 'incident_created'; data: { incidentId: string; severity: string } }
  | { type: 'compliance_breach'; data: { frameworkId: string; controlId: string } };

// ─── ERRORS ───────────────────────────────────────────────────────────────────

export class GovernanceBlockedError extends Error {
  public readonly decision: GovernanceResult;
  constructor(decision: GovernanceResult) {
    super(`Action blocked by Meridian governance: ${decision.reason ?? decision.policyId ?? 'policy violation'}`);
    this.name = 'GovernanceBlockedError';
    this.decision = decision;
    Object.setPrototypeOf(this, GovernanceBlockedError.prototype);
  }
}

export class MeridianAuthError extends Error {
  constructor(message = 'Invalid or expired Meridian API key') {
    super(message);
    this.name = 'MeridianAuthError';
  }
}

// ─── AGENT PROXY ──────────────────────────────────────────────────────────────

export class AgentProxy {
  private readonly client: Meridian;
  private readonly agentId: string;

  constructor(client: Meridian, agentId: string) {
    this.client = client;
    this.agentId = agentId;
  }

  /**
   * Govern an agent action — enforces policy in <10ms, returns result or throws.
   * 
   * @example
   * await meridian.agent('customer-bot').govern({
   *   actionType: 'send_email',
   *   resource: 'user@example.com',
   *   payload: { subject, body },
   * });
   */
  async govern(action: AgentAction): Promise<GovernanceResult> {
    const result = await this.client.enforcePolicy(this.agentId, action);
    if (!result.allowed) {
      throw new GovernanceBlockedError(result);
    }
    return result;
  }

  /**
   * Check policy without throwing — for conditional logic.
   */
  async check(action: AgentAction): Promise<GovernanceResult> {
    return this.client.enforcePolicy(this.agentId, action);
  }

  /**
   * Get the AgentDNA™ behavioral profile for this agent.
   */
  async getDNA(): Promise<AgentDNA> {
    return this.client.getAgentDNA(this.agentId);
  }
}

// ─── MAIN CLIENT ──────────────────────────────────────────────────────────────

export class Meridian extends EventEmitter {
  private readonly config: Required<MeridianConfig>;
  private ws: WebSocket | null = null;
  private wsReady = false;

  constructor(config: MeridianConfig | string) {
    super();
    if (typeof config === 'string') {
      config = { apiKey: config };
    }
    this.config = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? 'https://api.meridian.ai/v1',
      wsUrl: config.wsUrl ?? 'wss://rt.meridian.ai/v1/ws',
      orgId: config.orgId ?? '',
      timeout: config.timeout ?? 10000,
      enforceSync: config.enforceSync ?? true,
    };
  }

  /** Return a scoped proxy for a specific agent ID */
  agent(agentId: string): AgentProxy {
    return new AgentProxy(this, agentId);
  }

  /** Direct policy enforcement — used by AgentProxy.govern() */
  async enforcePolicy(agentId: string, action: AgentAction): Promise<GovernanceResult> {
    const start = Date.now();
    const res = await this.post('/enforce', { agentId, action });
    return { ...res, latencyMs: Date.now() - start };
  }

  /** Register / update an AI system in the registry */
  async registerSystem(params: {
    name: string;
    type: 'model' | 'agent' | 'application';
    owner: string;
    description?: string;
    frameworks?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<{ systemId: string }> {
    return this.post('/systems', params);
  }

  /** Get the latest risk assessment for a system */
  async getSystemRisk(systemId: string): Promise<RiskAssessment> {
    return this.get(`/systems/${systemId}/risk`);
  }

  /** Trigger an on-demand risk assessment */
  async assessRisk(systemId: string): Promise<RiskAssessment> {
    return this.post(`/systems/${systemId}/assess`, {});
  }

  /** Get AgentDNA™ behavioral fingerprint */
  async getAgentDNA(agentId: string): Promise<AgentDNA> {
    return this.get(`/agents/${agentId}/dna`);
  }

  /** List all registered agents */
  async listAgents(): Promise<Array<{ agentId: string; name: string; status: string; autonomyLevel: number }>> {
    return this.get('/agents');
  }

  /** Create an incident */
  async createIncident(params: {
    title: string;
    description: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    systemId?: string;
    evidence?: Record<string, unknown>;
  }): Promise<{ incidentId: string; jiraTicket?: string }> {
    return this.post('/incidents', params);
  }

  /** Upload evidence item — auto-maps to all relevant frameworks */
  async uploadEvidence(params: {
    title: string;
    content: string | Buffer;
    contentType: string;
    frameworks?: string[];
    systemIds?: string[];
  }): Promise<{ evidenceId: string; mappedFrameworks: string[]; reuseCount: number }> {
    return this.post('/evidence', params);
  }

  /**
   * Generate policy-as-code from natural language (uses Claude)
   * 
   * @example
   * const policy = await meridian.generatePolicy(
   *   'Block any agent from sending emails to external addresses without manager approval'
   * );
   */
  async generatePolicy(naturalLanguage: string): Promise<{
    policyId: string;
    policyCode: string;
    explanation: string;
    frameworkMappings: string[];
  }> {
    return this.post('/policies/generate', { naturalLanguage });
  }

  /**
   * Stream AI Advisor responses via Server-Sent Events
   * Returns an async generator of text chunks.
   */
  async *streamAdvice(query: string): AsyncGenerator<string> {
    const res = await fetch(`${this.config.baseUrl}/advisor/stream`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ query }),
    });
    if (!res.body) throw new Error('No response body');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value);
      const lines = chunk.split('\n').filter(l => l.startsWith('data: '));
      for (const line of lines) {
        const data = line.slice(6);
        if (data === '[DONE]') return;
        try { yield JSON.parse(data).text; } catch { yield data; }
      }
    }
  }

  /**
   * Subscribe to real-time governance events via WebSocket.
   * 
   * @example
   * meridian.subscribe(['action_blocked', 'drift_detected']);
   * meridian.on('action_blocked', (event) => console.log(event));
   */
  subscribe(events?: GovernanceEvent['type'][]): void {
    if (this.ws) return;
    this.ws = new WebSocket(`${this.config.wsUrl}?key=${this.config.apiKey}`);
    this.ws.on('open', () => {
      this.wsReady = true;
      if (events?.length) {
        this.ws!.send(JSON.stringify({ type: 'subscribe', events }));
      }
    });
    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const event: GovernanceEvent = JSON.parse(data.toString());
        this.emit(event.type, event.data);
        this.emit('event', event);
      } catch {}
    });
    this.ws.on('error', err => this.emit('error', err));
    this.ws.on('close', () => {
      this.wsReady = false;
      this.ws = null;
      // Reconnect after 3s
      setTimeout(() => this.subscribe(events), 3000);
    });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  // ─── PRIVATE ───

  private headers(): HeadersInit {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
      'X-Meridian-Org': this.config.orgId,
      'X-Meridian-SDK': 'typescript/0.9.0',
    };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeout),
    });
    if (res.status === 401) throw new MeridianAuthError();
    if (!res.ok) throw new Error(`Meridian API error ${res.status}: ${await res.text()}`);
    return res.json();
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.config.timeout),
    });
    if (res.status === 401) throw new MeridianAuthError();
    if (!res.ok) throw new Error(`Meridian API error ${res.status}: ${await res.text()}`);
    return res.json();
  }
}

// ─── FRAMEWORK INTEGRATIONS ───────────────────────────────────────────────────

/**
 * LangChain middleware — wraps any LangChain agent with governance.
 * 
 * @example
 * const governedAgent = createMeridianLangChainMiddleware(langchainAgent, meridian, {
 *   agentId: 'my-langchain-agent',
 *   autonomyLevel: 2,
 * });
 */
export function createMeridianLangChainMiddleware(
  agent: { invoke: (input: unknown) => Promise<unknown> },
  meridian: Meridian,
  options: { agentId: string; autonomyLevel?: number }
) {
  return {
    async invoke(input: unknown) {
      await meridian.agent(options.agentId).govern({
        actionType: 'invoke',
        payload: { input: input as Record<string, unknown> },
        metadata: { autonomyLevel: options.autonomyLevel ?? 1 },
      });
      return agent.invoke(input);
    },
  };
}

/**
 * OpenAI function calling middleware
 * Intercepts tool calls and enforces governance before execution.
 */
export function createMeridianOpenAIToolMiddleware(
  meridian: Meridian,
  agentId: string
) {
  return async function governedToolCall(
    toolName: string,
    toolArgs: Record<string, unknown>
  ): Promise<void> {
    await meridian.agent(agentId).govern({
      actionType: 'tool_call',
      resource: toolName,
      payload: toolArgs,
    });
  };
}

// Default export
export default Meridian;
