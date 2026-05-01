/**
 * GovernanceAdvisorService
 * 
 * AI Advisor powered by Claude claude-sonnet-4-6.
 * Streaming responses, policy-as-code generation, incident analysis.
 */

import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '@prisma/client';
import { Response } from 'express';
import { logger } from '../lib/logger';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Meridian's AI Governance Advisor — a world-class expert in AI governance, compliance, and risk management.

You have access to the user's live governance data:
- AI systems registry (247 systems, 31 shadow AI detected)
- Risk assessments with monetary quantification
- Compliance coverage across EU AI Act, NIST RMF, ISO 42001, SOC 2, GDPR, HITRUST
- Agent behavior data via AgentDNA™
- Active incidents and SLA timers
- Policy library

Your role: give direct, actionable, expert guidance. No generic disclaimers.
When asked about risks, always quantify in dollars if possible.
When asked to generate policy, output valid JSON policy-as-code.
When asked about regulations, cite specific articles and requirements.

Tone: Direct, expert, CTO-level. You're talking to a Chief AI Officer.
Format: Conversational prose. No markdown headers. Use numbered lists for action items.`;

export interface AdvisorQuery {
  message: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  orgContext?: {
    totalSystems: number;
    openFlags: number;
    riskExposure: number;
    activeIncidents: number;
  };
}

export class GovernanceAdvisorService {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Stream advice as Server-Sent Events.
   */
  async streamAdvice(query: AdvisorQuery, res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const messages: Anthropic.Messages.MessageParam[] = [
      ...(query.conversationHistory ?? []),
      { role: 'user', content: query.message },
    ];

    try {
      const stream = await anthropic.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages,
      });

      let fullResponse = '';

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const text = event.delta.text;
          fullResponse += text;
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        }
      }

      res.write(`data: [DONE]\n\n`);
      res.end();

      // Persist conversation
      await this.persistConversation(query.message, fullResponse, query.orgContext);

    } catch (err) {
      logger.error('Advisor streaming failed', { err });
      res.write(`data: ${JSON.stringify({ error: 'Stream failed' })}\n\n`);
      res.end();
    }
  }

  /**
   * Non-streaming advice for batch use cases.
   */
  async getAdvice(query: AdvisorQuery): Promise<string> {
    const messages: Anthropic.Messages.MessageParam[] = [
      ...(query.conversationHistory ?? []),
      { role: 'user', content: query.message },
    ];

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    return (msg.content[0] as { text: string }).text;
  }

  /**
   * Analyze an incident and generate remediation steps.
   */
  async analyzeIncident(incident: {
    title: string;
    description: string;
    severity: string;
    systemId: string;
    affectedUsers?: number;
    monetaryExposure?: number;
  }): Promise<{
    rootCause: string;
    remediationSteps: string[];
    preventionMeasures: string[];
    estimatedResolutionHours: number;
    jiraTicketDraft: {
      title: string;
      description: string;
      priority: string;
      labels: string[];
    };
  }> {
    const prompt = `Analyze this AI governance incident and provide structured remediation guidance:

Title: ${incident.title}
Severity: ${incident.severity}
System: ${incident.systemId}
Description: ${incident.description}
Affected users: ${incident.affectedUsers ?? 'Unknown'}
Monetary exposure: ${incident.monetaryExposure ? '$' + incident.monetaryExposure.toLocaleString() : 'Unknown'}

Respond in this exact JSON format (no markdown):
{
  "rootCause": "...",
  "remediationSteps": ["step 1", "step 2", "step 3"],
  "preventionMeasures": ["...", "..."],
  "estimatedResolutionHours": 24,
  "jiraTicketDraft": {
    "title": "[AI-CRITICAL] ...",
    "description": "...",
    "priority": "Critical",
    "labels": ["ai-governance", "..."]
  }
}`;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = (msg.content[0] as { text: string }).text;
    try {
      return JSON.parse(text);
    } catch {
      logger.error('Failed to parse incident analysis JSON', { text });
      throw new Error('Incident analysis parsing failed');
    }
  }

  /**
   * Generate policy-as-code from natural language using Claude.
   * 
   * @example
   * const policy = await advisor.generatePolicyAsCode(
   *   'Block agents from sending emails to external domains without manager approval'
   * );
   */
  async generatePolicyAsCode(naturalLanguage: string): Promise<{
    policyCode: string;
    explanation: string;
    frameworkMappings: string[];
    enforcementNotes: string;
  }> {
    const prompt = `Convert this governance requirement into Meridian policy-as-code:

"${naturalLanguage}"

Respond in this exact JSON format (no markdown):
{
  "policyCode": { "id": "...", "name": "...", "framework": "...", "enforcementMode": "block|flag|modify", "rules": { ... } },
  "explanation": "Plain English explanation of what this policy does",
  "frameworkMappings": ["EU-AI-ACT-ART-9", "NIST-GOVERN-1.1"],
  "enforcementNotes": "Important considerations for deployment"
}

Policy code format:
- id: kebab-case unique identifier
- enforcementMode: "block" (rejects action), "flag" (allows but logs), "modify" (transforms payload)
- rules: { type: "AND"|"OR", rules: [{ type: "CONDITION", field: "action.actionType|action.resource|context.*", operator: "eq|in|gt|lt|contains|regex", value: ... }] }`;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = (msg.content[0] as { text: string }).text;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Policy generation parsing failed');
    }
  }

  private async persistConversation(
    query: string,
    response: string,
    context?: AdvisorQuery['orgContext']
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: 'advisor_query',
          details: { query, response: response.slice(0, 1000), context } as object,
          timestamp: new Date(),
        },
      });
    } catch (err) {
      logger.error('Failed to persist advisor conversation', { err });
    }
  }
}
