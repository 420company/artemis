/**
 * extensions/curatedSkills.ts — the curated picks of the cco skill packs.
 *
 * The cco pack ships ~700 playbooks across 8 audiences. Most are
 * vendor-specific; this file names the ones worth reaching for first:
 * broadly useful, well described, and representative of their audience.
 * The list lives here as data (not as per-skill front matter) so curation
 * stays in one place and is easy to review.
 *
 * Picked 2026-10-14: 4 per audience, 32 total. A pick is a skill id as the
 * library sees it (the skill folder's name, normalized).
 */

import type { LibrarySkill, SkillLibrary } from './skillLibrary.js';

/** Curated cco skill ids per audience (`cco/<audience>` → skill ids). */
export const CURATED_CCO_SKILLS: Record<string, readonly string[]> = {
  creators: [
    'cco-figma-figma-generate-design',
    'cco-figma-figma-implement-design',
    'cco-frontend-design-frontend-design',
    'cco-mintlify-mintlify',
  ],
  marketers: [
    'cco-searchfit-seo-seo-audit',
    'cco-searchfit-seo-content-strategy',
    'cco-brightdata-plugin-scrape',
    'cco-apollo-prospect',
  ],
  traders: [
    'cco-exa-search',
    'cco-bigdata-com-financial-research-analyst',
    'cco-bigdata-com-earnings-digest',
    'cco-firecrawl-firecrawl-scrape',
  ],
  analysts: [
    'cco-amplitude-analyze-dashboard',
    'cco-amplitude-discover-opportunities',
    'cco-astronomer-data-agents-analyzing-data',
    'cco-amplitude-daily-brief',
  ],
  office: [
    'cco-notion-create-page',
    'cco-notion-database-query',
    'cco-slack-summarize-channel',
    'cco-atlassian-search-company-knowledge',
  ],
  sellers: [
    'cco-stripe-stripe-best-practices',
    'cco-shopify-ai-toolkit-shopify-dev',
    'cco-revenuecat-paywall-builder',
    'cco-shopify-ai-toolkit-shopify-storefront-graphql',
  ],
  security: [
    'cco-sentry-sentry-fix-issues',
    'cco-sonarqube-sonar-fix-issue',
    'cco-aikido-scan',
    'cco-zscaler-investigate-incident',
  ],
  developers: [
    'cco-auth0-auth0-quickstart',
    'cco-code-review-code-review',
    'cco-cloudflare-workers-best-practices',
    'cco-chrome-devtools-mcp-debug-optimize-lcp',
  ],
};

/** Every curated skill id, whatever the audience. */
export const CURATED_SKILL_IDS: ReadonlySet<string> = new Set(Object.values(CURATED_CCO_SKILLS).flat());

/** How many curated picks there are in total. */
export const CURATED_SKILL_COUNT = CURATED_SKILL_IDS.size;

/**
 * Whether a pack skill is a curated pick. `pack` is the library's
 * `"cco/<audience>"` group id; the check is scoped to the cco pack so a
 * same-named skill from another source is never mislabeled.
 */
export function isCuratedCcoSkill(pack: string | undefined, id: string): boolean {
  if (!pack) return false;
  const [packId, audience] = pack.split('/');
  if (packId !== 'cco' || !audience) return false;
  return CURATED_CCO_SKILLS[audience]?.includes(id) ?? false;
}

/** The curated picks present in a loaded library, optionally one audience. */
export function listCuratedSkills(library: SkillLibrary, audience?: string): LibrarySkill[] {
  const wanted = audience?.trim().toLowerCase();
  return library.skills
    .filter((skill) => skill.curated && (!wanted || skill.pack === `cco/${wanted}`))
    .sort((a, b) => a.id.localeCompare(b.id));
}
