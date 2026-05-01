# Meridian — AI Governance Platform

**LGST 2420: Big Data, Big Responsibilities · Professor Werbach · Option 2: Build**

Meridian is a functional AI governance platform that addresses four organizational governance failures: algorithmic opacity, the agentic governance gap, undetected demographic bias, and the organizational capacity gap.

---

## How to Run

No installation required. Single HTML file.

1. Download `meridian.html`
2. Open it in Chrome, Firefox, or Safari
3. Complete the 4-step enterprise onboarding (size, industry, AI use cases, maturity level)
4. Navigate using the left sidebar

---

## AI Governance Advisor (Live API)

The AI Advisor makes real API calls to Claude. To use it:

1. Click **AI Advisor** in the left sidebar
2. Enter your [Anthropic API key](https://console.anthropic.com/settings/keys) in the field at the top
3. Ask any governance question — EU AI Act gaps, bias incidents, policy generation, agent risk

Your key is sent only to `api.anthropic.com` and is never stored or logged.

---

## Platform Features

| Feature | Description |
|---|---|
| **AI Registry** | 247 systems tracked with risk scores, model cards, monetary exposure, and shadow AI auto-detection |
| **Agent Monitor** | Real-time agentic governance — AgentDNA™ behavioral fingerprinting, kill switches, autonomy levels |
| **Bias Audits** | Demographic parity testing using Bertrand-Mullainathan methodology, EEOC 4/5 adverse impact ratio |
| **NIST Assessment** | Evaluates AI systems against all 7 NIST AI RMF trustworthiness characteristics |
| **Risk Intelligence** | Compliance rings (EU AI Act, NIST, GDPR, SOC 2, HITRUST), monetary risk quantification |
| **AI Advisor** | Live Claude API — policy-as-code generation, regulatory gap analysis, incident drafting |
| **Agent Builder** | 6-step wizard to configure and deploy governance agents |
| **Policy Engine** | Policy-as-code enforcement with sub-10ms blocking |
| **Evidence Library** | Automated evidence collection across compliance frameworks |

---

## Governance Problem Addressed

Meridian addresses four failures documented in the course materials:

1. **Algorithmic opacity** — *Houston Federation of Teachers v. HISD (2017)* established that AI systems whose reasoning cannot be independently examined may violate procedural due process. Meridian's Registry, Bias Audit, and NIST Assessment operationalize the three transparency levels the "Algorithmic Transparency" video defines.

2. **The agentic governance gap** — Barndoor.ai (2026) finds 30% of professionals use AI that takes autonomous actions; governance frameworks built for query-response AI cannot address this. The Agent Monitor enforces runtime governance at the action level.

3. **Demographic bias** — The "Algorithmic Fairness" video establishes that fairness definitions are mathematically incompatible; ProPublica's COMPAS investigation showed that accuracy can coexist with racially disparate false positive rates. The Bias Audit surfaces these disparities before enforcement.

4. **Organizational capacity gap** — NIST's Govern function is the prerequisite for all other AI RMF activity; Barndoor.ai finds 78% of organizations lack it. The AI Advisor closes this gap conversationally.

---

## Submission Files

- `meridian.html` — The functional platform (run this)
- `final-submission.docx` — Governance Analysis + Build Log + AI Disclosure

---

## Technical Notes

- Pure HTML/CSS/JavaScript — no build step, no dependencies
- All live updates (SLA countdowns, agent action counters, activity feed) run client-side
- Enterprise onboarding personalizes the platform by industry and governance maturity
- API key required only for AI Advisor feature; all other features work without it

## Architecture Note

The functional prototype is `apps/app/index.html`. Backend services in `services/`, `integrations/`, and `packages/` are architectural scaffolding illustrating the intended production architecture — they define the TypeScript interfaces, database schema, and service boundaries a full deployment would require. They have not been compiled or deployed.
