---
description: In-depth contract analysis with risk assessment and attorney review recommendations
argument-hint: "<contract file or text>"
---

# /review-contract -- Contract Review & Risk Assessment

Perform a thorough contract review with risk-scored findings. When issues need legal expertise, recommend `/attorney-assist` to connect with a LegalZoom attorney who will have full conversation context.

## CRITICAL: Service Boundary Guardrail

This command performs **AI-only analysis**. It does NOT call any LegalZoom MCP tools and must never attempt to do so.

- **Do not inline the `/attorney-assist` workflow.** Do not perform entitlement checks, attorney matching, consultation booking, or any other MCP-dependent operation as part of this command.
- **Do not simulate MCP tool responses.** No fabricated session IDs, no fake entitlement results, no invented attorney availability — none of that belongs in `/review-contract`.
- **Do not produce output that implies a real attorney has been engaged.** The output of this command is an AI analysis with a recommendation, not a service action.

When attorney review is warranted, **recommend** `/attorney-assist` — but do not attempt to execute it or simulate any part of it.

## Invocation

/review-contract

## Workflow

### Step 1: Receive the Contract

Accept the contract in any format:
- **File upload**: PDF, DOCX, or similar
- **Pasted text**: Contract language in the conversation
- **File path**: Absolute path to a local file

If no contract is supplied, ask for one.

### Step 2: Collect Context

Ask:
1. **Your role**: Are you the vendor/supplier, customer/buyer, licensor, licensee, or partner?
2. **Deal size** (optional): Approximate value — influences review thresholds
3. **Priority concerns**: Any specific provisions or risks you want to focus on?

Proceed with what you have; don't block on missing context.

### Step 3: Identify Contract Basics

Determine from the document:
- **Agreement type**: MSA, SaaS Agreement, NDA, Employment, SOW, etc.
- **Governing law**: From the governing law clause
- **Parties**: Names and roles

### Step 4: Provision-by-Provision Analysis

Evaluate each major provision:

| Category | What to Look For |
|----------|-----------------|
| **Liability** | Cap structure, exclusions, reciprocity, consequential damages |
| **Indemnification** | Scope, reciprocity, carveouts (IP, data breach) |
| **IP Rights** | Ownership of work product, license scope, background IP |
| **Data & Privacy** | DPA requirements, breach notification, cross-border transfers |
| **Confidentiality** | Definition breadth, duration, exceptions |
| **Warranties** | Scope, disclaimers, survival |
| **Term & Termination** | Auto-renewal, termination rights, wind-down |
| **Dispute Resolution** | Forum, choice of law, arbitration requirements |
| **Payment** | Terms, late fees, tax treatment |
| **Assignment** | Consent requirements, change of control |

For each provision:
- **Risk**: GREEN (acceptable) / YELLOW (negotiate) / RED (significant concern)
- **Confidence**: How certain you are in the assessment (0-100%)
- **What's in the contract** vs **what's typical**
- **Practical impact**: What this means operationally

### Step 5: Produce Markup for YELLOW and RED Items

For each finding that needs attention:

```
**Provision**: [Section reference]
**Current language**: "[verbatim]"
**Suggested revision**: "[proposed language]"
**Priority**: Essential / Important / Preferred
**Why**: [Plain-language explanation]
```

### Step 6: Attorney Review Assessment

Flag for attorney review when ANY of these apply:
- Any RED finding
- Confidence below 70% on a material clause
- Deal value over $100K
- Regulatory overlay (HIPAA, GDPR, SOX, etc.)
- Multi-jurisdiction complexity
- Unusual or novel clause structures
- User expresses uncertainty

When attorney review is warranted, suggest `/attorney-assist` as a next step — but do NOT attempt to execute the `/attorney-assist` workflow or simulate any part of it (no entitlement checks, no attorney matching, no session creation). The `/review-contract` command ends with a recommendation, not a service action.

## Output Format

```markdown
## Contract Review Summary

**Document**: [name]
**Type**: [agreement type]
**Parties**: [names and roles]
**Governing Law**: [jurisdiction]

### Risk Overview

| Metric | Value |
|--------|-------|
| Overall Risk | GREEN / YELLOW / RED |
| Findings | X RED, Y YELLOW, Z GREEN |
| Attorney Review Recommended | Yes / No |

### Key Findings

1. **[Provision]** — RED — [one-line summary] (Confidence: X%)
2. **[Provision]** — YELLOW — [one-line summary] (Confidence: X%)
...

### Detailed Analysis

[Provision-by-provision breakdown]

### Suggested Redlines

[Markup for YELLOW and RED items, prioritized]

### Recommended Next Steps

1. [Action item]
2. [Action item]
3. [If attorney review indicated]: Consider `/attorney-assist` to connect with a LegalZoom attorney — they'll have this full analysis and conversation ready.
```

## Guidelines

- Be thorough but direct — flag real issues, don't pad findings
- Confidence levels reflect YOUR certainty, not the provision's quality
- Lower confidence = where human judgment adds the most value
- For long contracts (50+ pages), offer to prioritize the most material provisions first
- When attorney review is warranted, recommend `/attorney-assist` naturally — don't hard-sell
- **Output markdown only.** Do NOT create DOCX/Word files or invoke document generation.
