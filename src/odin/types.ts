export type OdinSkillSource = 'local' | 'cloud' | 'captured' | 'imported' | 'manual';

export type OdinSkillStatus =
  | 'draft'
  | 'active'
  | 'stale'
  | 'failed'
  | 'archived';

export type OdinSearchScope = 'local' | 'cloud' | 'all';

export type OdinEvolutionKind = 'auto-learn' | 'auto-improve' | 'auto-fix' | 'manual';

export type OdinEvolutionOutcome = 'success' | 'partial' | 'failure';

export type OdinSkillLineage = {
  parentSkillIds: string[];
  originEventId?: string;
  originSearchId?: string;
  changeSummary?: string;
  captureQuery?: string;
  revision: number;
};

export type OdinSkillRecord = {
  id: string;
  name: string;
  summary?: string;
  description?: string;
  tags: string[];
  source: OdinSkillSource;
  status: OdinSkillStatus;
  scope: OdinSearchScope;
  confidence: number;
  readOnly: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  lineage?: OdinSkillLineage;
  metadata?: Record<string, unknown>;
};

export type OdinSearchHit = {
  skillId: string;
  score: number;
  reasons: string[];
  matchedTokens: string[];
};

export type OdinSearchRecord = {
  id: string;
  query: string;
  scope: OdinSearchScope;
  limit: number;
  autoImport: boolean;
  results: OdinSearchHit[];
  searchedAt: string;
};

export type OdinEvolutionEvent = {
  id: string;
  kind: OdinEvolutionKind;
  outcome: OdinEvolutionOutcome;
  skillIds: string[];
  summary: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type OdinStoreData = {
  version: 1;
  updatedAt: string;
  /** ISO timestamp of the last skill-decay pass. Used to throttle decay to once per 24 h. */
  lastDecayAt?: string;
  skills: OdinSkillRecord[];
  searchRecords: OdinSearchRecord[];
  evolutionEvents: OdinEvolutionEvent[];
};

export type OdinSkillUpsertInput = {
  id: string;
  name: string;
  summary?: string;
  description?: string;
  tags?: string[];
  source?: OdinSkillSource;
  status?: OdinSkillStatus;
  scope?: OdinSearchScope;
  confidence?: number;
  readOnly?: boolean;
  lastUsedAt?: string;
  lineage?: Partial<OdinSkillLineage>;
  metadata?: Record<string, unknown>;
};

export type OdinSearchQuery = {
  query: string;
  scope?: OdinSearchScope;
  limit?: number;
  autoImport?: boolean;
};

export type OdinSearchResult = {
  query: string;
  scope: OdinSearchScope;
  limit: number;
  hits: OdinSearchHit[];
};

