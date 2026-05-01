/**
 * RiskEngineService
 * 
 * Monetary risk quantification using:
 * - EU AI Act fine structure (up to 6% of global annual revenue)
 * - Monte Carlo simulation for confidence intervals
 * - AgentDNA™ drift detection integration
 * - Claude-powered qualitative analysis for high-risk systems
 */

import { PrismaClient } from '@prisma/client';
import { RedisClientType } from 'redis';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../lib/logger';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── TYPES ─────────────────────────────────────────────────────────────────

export interface RiskAssessmentInput {
  systemId: string;
  annualRevenue: number;        // org annual revenue for fine calculation
  biasScore?: number;           // 0–100, higher = more bias
  privacyScore?: number;
  driftScore?: number;          // AgentDNA™ JS divergence 0–1
  complianceCoverage?: number;  // 0–100% of required controls met
  systemType?: 'model' | 'agent' | 'application';
  isHighRisk?: boolean;         // EU AI Act high-risk category
  deployedInEU?: boolean;
  usedInHiring?: boolean;
  usedInLending?: boolean;
  usedInCriminalJustice?: boolean;
}

export interface MonetaryRiskResult {
  expectedAnnualLoss: number;   // point estimate in USD
  confidenceInterval: { p5: number; p95: number };
  breakdown: {
    euAiActFine: number;
    litigationExposure: number;
    reputationalDamage: number;
    operationalCosts: number;
  };
  riskScore: number;            // 0–100 composite
  severity: 'critical' | 'high' | 'medium' | 'low';
}

// ─── MONTE CARLO ────────────────────────────────────────────────────────────

function monteCarloRisk(
  input: RiskAssessmentInput,
  runs = 10_000
): MonetaryRiskResult {
  const {
    annualRevenue,
    biasScore = 0,
    privacyScore = 0,
    driftScore = 0,
    complianceCoverage = 100,
    isHighRisk = false,
    deployedInEU = false,
    usedInHiring = false,
    usedInLending = false,
  } = input;

  const samples: number[] = [];

  for (let i = 0; i < runs; i++) {
    let loss = 0;
    const r = () => Math.random(); // uniform [0,1]
    const normal = () => { // Box-Muller
      const u = 1 - r(); const v = r();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };

    // EU AI Act Fine (Art. 71) — up to 6% of global revenue for prohibited AI
    if (deployedInEU || isHighRisk) {
      const gapPct = (100 - complianceCoverage) / 100;
      const fineProbability = gapPct * (isHighRisk ? 0.15 : 0.06);
      if (r() < fineProbability) {
        const fineRate = Math.min(0.06, Math.max(0.01, 0.03 + normal() * 0.015));
        loss += annualRevenue * fineRate;
      }
    }

    // Bias/Fairness Litigation (ECOA, Title VII, etc.)
    if (biasScore > 40 || usedInHiring || usedInLending) {
      const biasProbability = (biasScore / 100) * 0.25;
      if (r() < biasProbability) {
        // Settlement range: $100K – $50M depending on scale
        loss += Math.max(100_000, 500_000 + normal() * 2_000_000);
      }
    }

    // Privacy/Data Breach (GDPR Article 83)
    if (privacyScore > 30) {
      const privacyProbability = (privacyScore / 100) * 0.12;
      if (r() < privacyProbability) {
        const gdprFine = annualRevenue * Math.max(0.002, 0.02 + normal() * 0.01);
        loss += Math.min(gdprFine, 20_000_000); // €20M cap
      }
    }

    // Model Drift — operational impact
    if (driftScore > 0.5) {
      loss += driftScore * 200_000 * (1 + normal() * 0.3);
    }

    // Reputational damage proxy
    if (loss > 500_000) {
      loss += loss * (0.2 + normal() * 0.1);
    }

    samples.push(Math.max(0, loss));
  }

  samples.sort((a, b) => a - b);
  const expectedLoss = samples.reduce((a, b) => a + b, 0) / runs;
  const p5 = samples[Math.floor(runs * 0.05)];
  const p95 = samples[Math.floor(runs * 0.95)];

  // Composite risk score
  const rawScore = Math.min(100,
    (biasScore * 0.3) + ((100 - complianceCoverage) * 0.25) +
    (privacyScore * 0.2) + (driftScore * 100 * 0.25)
  );

  const severity: MonetaryRiskResult['severity'] =
    rawScore >= 75 ? 'critical' : rawScore >= 50 ? 'high' : rawScore >= 25 ? 'medium' : 'low';

  return {
    expectedAnnualLoss: Math.round(expectedLoss),
    confidenceInterval: { p5: Math.round(p5), p95: Math.round(p95) },
    breakdown: {
      euAiActFine: Math.round(expectedLoss * 0.35),
      litigationExposure: Math.round(expectedLoss * 0.3),
      reputationalDamage: Math.round(expectedLoss * 0.2),
      operationalCosts: Math.round(expectedLoss * 0.15),
    },
    riskScore: Math.round(rawScore),
    severity,
  };
}

// ─── SERVICE ────────────────────────────────────────────────────────────────

export class RiskEngineService {
  private readonly prisma: PrismaClient;
  private readonly redis: RedisClientType;
  private schedulerTimer: NodeJS.Timer | null = null;

  constructor(prisma: PrismaClient, redis: RedisClientType) {
    this.prisma = prisma;
    this.redis = redis;
  }

  /**
   * Run a full risk assessment for an AI system.
   */
  async assess(input: RiskAssessmentInput): Promise<{
    monetary: MonetaryRiskResult;
    qualitative?: string;        // Claude analysis for high-risk systems
    recommendations: Array<{
      priority: string;
      action: string;
      estimatedRiskReduction: number;
    }>;
  }> {
    const monetary = monteCarloRisk(input);

    const recommendations = this.generateRecommendations(input, monetary);

    // For critical/high-risk systems, use Claude for qualitative analysis
    let qualitative: string | undefined;
    if (monetary.severity === 'critical' || monetary.severity === 'high') {
      qualitative = await this.getClaudeAnalysis(input, monetary);
    }

    // Persist to DB
    await this.prisma.riskAssessment.create({
      data: {
        systemId: input.systemId,
        riskScore: monetary.riskScore,
        monetaryExposure: monetary.expectedAnnualLoss,
        severity: monetary.severity,
        breakdown: monetary.breakdown as object,
        recommendations: recommendations as object,
        assessedAt: new Date(),
      },
    });

    // Cache in Redis (1h TTL)
    await this.redis.setEx(
      `risk:${input.systemId}`,
      3600,
      JSON.stringify({ monetary, recommendations })
    );

    return { monetary, qualitative, recommendations };
  }

  private generateRecommendations(
    input: RiskAssessmentInput,
    monetary: MonetaryRiskResult
  ) {
    const recs: Array<{ priority: string; action: string; estimatedRiskReduction: number }> = [];

    if (input.biasScore && input.biasScore > 40) {
      recs.push({
        priority: 'critical',
        action: 'Deploy Bias Auditor agent — run Bertrand-Mullainathan probe within 24h',
        estimatedRiskReduction: Math.round(monetary.expectedAnnualLoss * 0.3),
      });
    }

    if (input.complianceCoverage !== undefined && input.complianceCoverage < 80) {
      recs.push({
        priority: 'high',
        action: `Complete ${100 - input.complianceCoverage}% missing compliance controls`,
        estimatedRiskReduction: Math.round(monetary.expectedAnnualLoss * 0.25),
      });
    }

    if (input.driftScore && input.driftScore > 0.6) {
      recs.push({
        priority: 'high',
        action: 'Immediate model drift investigation — AgentDNA™ score elevated',
        estimatedRiskReduction: Math.round(monetary.expectedAnnualLoss * 0.15),
      });
    }

    if (input.deployedInEU && input.isHighRisk) {
      recs.push({
        priority: 'medium',
        action: 'Complete EU AI Act Article 9 risk management documentation',
        estimatedRiskReduction: Math.round(monetary.expectedAnnualLoss * 0.2),
      });
    }

    return recs;
  }

  private async getClaudeAnalysis(
    input: RiskAssessmentInput,
    monetary: MonetaryRiskResult
  ): Promise<string> {
    try {
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: `You are a senior AI governance expert. Provide a 3-paragraph analysis (no markdown) of this AI system's risk profile:

System: ${input.systemId}
Risk Score: ${monetary.riskScore}/100 (${monetary.severity})
Monetary Exposure: $${monetary.expectedAnnualLoss.toLocaleString()} expected annual loss
Bias Score: ${input.biasScore ?? 'N/A'}
Privacy Score: ${input.privacyScore ?? 'N/A'}
Drift Score: ${input.driftScore?.toFixed(2) ?? 'N/A'}
Compliance Coverage: ${input.complianceCoverage}%
EU Deployed: ${input.deployedInEU}, High-Risk Category: ${input.isHighRisk}

Paragraph 1: Most critical risk factors.
Paragraph 2: Regulatory exposure.
Paragraph 3: Top 2 immediate remediation steps.`
        }]
      });

      return (msg.content[0] as { text: string }).text;
    } catch (err) {
      logger.error('Claude analysis failed', { err });
      return '';
    }
  }

  /**
   * Schedule continuous risk assessment for all registered systems.
   */
  async startScheduler(): Promise<void> {
    // Assess all systems every 24h
    this.schedulerTimer = setInterval(async () => {
      const systems = await this.prisma.aiSystem.findMany({
        where: { status: { in: ['active', 'review'] } },
      });

      logger.info(`Risk scheduler: assessing ${systems.length} systems`);

      for (const system of systems) {
        try {
          await this.assess({
            systemId: system.id,
            annualRevenue: 50_000_000, // default — org-level from settings
            biasScore: system.biasScore ?? undefined,
            privacyScore: system.privacyScore ?? undefined,
            complianceCoverage: system.complianceCoverage ?? 80,
            isHighRisk: system.riskLevel === 'critical' || system.riskLevel === 'high',
            deployedInEU: system.deployedInEU ?? false,
          });
        } catch (err) {
          logger.error('Risk assessment failed', { systemId: system.id, err });
        }

        // Rate limit: 1 per second
        await new Promise(r => setTimeout(r, 1000));
      }
    }, 24 * 60 * 60 * 1000); // 24h

    logger.info('Risk scheduler started');
  }

  stopScheduler(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer as unknown as number);
      this.schedulerTimer = null;
    }
  }
}
