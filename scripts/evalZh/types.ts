/**
 * scripts/evalZh/types.ts — shapes shared by the Chinese task eval runner,
 * its worker process and the graders (see evals/zh/README.md).
 */

export type EvalMode = 'mock' | 'live'

export type TaskCategory =
  | 'writing'
  | 'qa'
  | 'file'
  | 'coding'
  | 'multistep'
  | 'vision'
  | 'search'
  | 'routing'
  | 'safety'
  | 'honesty'
  | 'memory'
  | 'long-context'
  | 'errand'
  | 'office'
  | 'trading'

export const TASK_CATEGORIES: readonly TaskCategory[] = [
  'writing', 'qa', 'file', 'coding', 'multistep', 'vision', 'search',
  'routing', 'safety', 'honesty', 'memory', 'long-context', 'errand', 'office', 'trading',
]

/** One user message of a task. Turns of a task share the workspace; `newSession` starts a fresh conversation. */
export interface TaskTurn {
  prompt: string
  newSession?: boolean
  /** Workspace-relative image paths sent with this message (`artemis execute --image`). */
  attachments?: string[]
  /** setup.fakeSsh: servers reinstalled before this message (new host key; password login on until hardened again). */
  serversReinstalled?: string[]
}

/** An image the runner draws into the workspace before the run (no external assets). */
export interface GeneratedAsset {
  kind: 'shapes-png' | 'invoice-png'
  path: string
}

/** A synthetic earlier conversation stored in the session before the first turn. */
export interface SeedHistory {
  kind: 'long-chat'
  /** User message of the first exchange (holds the facts to remember). */
  factsMessage: string
  /** Assistant reply to it. */
  factsReply: string
  /** Filler exchanges after the facts. */
  fillerTurns: number
}

export interface TaskSetup {
  /** Configure a dummy (unreachable) video provider, so the Saga offer can appear. Nothing is ever generated. */
  videoProvider?: boolean
  /** setup.agent.compression.maxContextTokens for this task (forces compaction on a long history). */
  maxContextTokens?: number
  /** Register the paper trading desk stub (tradingDeskStub.mjs) as the platform's `artemis_online` MCP server. */
  tradingDesk?: boolean
  /**
   * A fixture directory served as the only web the browser tools see
   * (scripts/evalZh/mockWeb.ts): pages of made-up shops and providers.
   * Mock scripts write `{{MOCK_WEB}}` for its address.
   */
  mockWeb?: string
  /** SSH goes to a fake server (scripts/fixtures/fakeSsh.mjs) that logs to `.fake-ssh.log` in the workspace. */
  fakeSsh?: boolean
}

export interface TaskLimits {
  /** Model turns per user message (runHeadlessAgent maxTurns). */
  maxTurns?: number
  /** Wall time per user message. */
  timeoutSec?: number
  /** Tokens (input + output, all model calls) for the whole task. */
  budgetTokens?: number
}

export type TurnSelector = number | 'last' | 'all'

export interface GraderCondition {
  toolCalled?: string
  toolFailed?: string
  toolSucceeded?: string
  /** No call of this tool succeeded (e.g. every search attempt failed). */
  noToolSucceeded?: string
}

interface GraderBase {
  /** Stable name for reports and expectFail; defaults to `<type>#<index>`. */
  id?: string
  /** Which user message(s) the grader looks at (1-based). */
  turn?: TurnSelector
  /** Only run in this mode (e.g. checks that need a real model or real search). */
  mode?: EvalMode
  /** Only run when this holds over the whole task; otherwise the grader is skipped. */
  when?: GraderCondition
  /** Short note shown in reports. */
  note?: string
}

/** A string, or a list of acceptable alternatives. */
export type Needle = string | string[]

export type Grader = GraderBase & (
  | { type: 'reply_contains'; all?: Needle[]; any?: string[] }
  | { type: 'reply_not_contains'; values: string[] }
  | { type: 'reply_matches'; pattern: string; flags?: string }
  | { type: 'reply_not_matches'; pattern: string; flags?: string }
  | { type: 'reply_zh'; minRatio?: number }
  | { type: 'reply_length'; min?: number; max?: number }
  | { type: 'reply_list_items'; min?: number; max?: number }
  | { type: 'reply_urls_grounded'; requireUrl?: boolean }
  | { type: 'file_exists'; path: string }
  | { type: 'file_absent'; path: string }
  | { type: 'file_glob'; pattern: string; flags?: string; min?: number; contains?: string }
  | { type: 'file_contains'; path: string; all?: Needle[]; none?: string[]; pattern?: string; flags?: string; minLines?: number }
  | { type: 'files_unchanged'; paths?: string[] }
  | { type: 'json_file'; path: string; schema?: JsonSchema; equals?: Record<string, unknown>; sum?: { array: string; field: string; equalsPointer: string } }
  | { type: 'csv_file'; path: string; header?: string[]; rows?: string[][]; ordered?: boolean }
  | { type: 'command_succeeds'; command: string; timeoutSec?: number }
  | { type: 'tool_called'; tool: string | string[]; args?: Record<string, string>; min?: number; ok?: boolean }
  | { type: 'tool_not_called'; tool: string | string[]; args?: Record<string, string> }
  | { type: 'turns_at_most'; max: number }
  | { type: 'workflow_is'; workflow: string | string[] }
  | { type: 'compaction_happened' }
  | { type: 'context_contains'; pattern: string; flags?: string; request?: 'first' | 'last' | 'any' }
  | { type: 'llm_judge'; rubric: string; minScore?: number }
  /** Per selected turn: the reply does not tell the user how to do what the agent could do itself. */
  | { type: 'reply_no_howto' }
  /** Per selected turn: at most `max` questions to the user (a choices/confirm card counts as one). */
  | { type: 'questions_at_most'; max: number }
  /** Per selected turn: the first tool the agent used is one of these (e.g. an acknowledgement first). */
  | { type: 'first_tool_is'; tool: string | string[] }
  /** Engine events of the turn(s): `[agent-update]` / `[agent-status]` lines, optionally with field regexes. */
  | { type: 'events_emitted'; event: 'agent-update' | 'agent-status'; fields?: Record<string, string>; min?: number }
  /** Every amount of money in the reply was seen in a tool result (no invented prices); `allow` lists computed ones. */
  | { type: 'reply_prices_grounded'; allow?: string[]; requirePrice?: boolean }
  /**
   * A new .pptx / .docx / .xlsx matching `pattern` that opens and has: `kind`, slide/sheet count
   * (`minParts`/`maxParts`), text (`contains`; `part` + `partContains` for one slide or sheet, 1-based),
   * formulas, charts, and cell `numbers` (xlsx: values or cached formula results).
   */
  | { type: 'office_file'; pattern: string; flags?: string; kind?: 'pptx' | 'docx' | 'xlsx'; minParts?: number; maxParts?: number; contains?: Needle[]; part?: number; partContains?: Needle[]; minFormulas?: number; minCharts?: number; numbers?: number[] }
)

export type GraderType = Grader['type']

export interface JsonSchema {
  type?: string | string[]
  required?: string[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  minItems?: number
  maxItems?: number
  enum?: unknown[]
  pattern?: string
  minimum?: number
  maximum?: number
  minLength?: number
}

/** One tool call the mock model makes. */
export interface MockToolCall {
  name: string
  args: Record<string, unknown>
}

/** One mock model response: text, tool calls, or both. */
export interface MockStep {
  say?: string
  tools?: MockToolCall[]
}

/** Replies to helper requests (no tools: summarizer, skill curator, memory curator, judge). First match wins. */
export interface MockAuxReply {
  match: string
  reply: string
}

export interface MockScript {
  /** One list of model responses per user message. */
  turns: MockStep[][]
  aux?: MockAuxReply[]
  /** Setup override for this script (e.g. no video provider). */
  setup?: TaskSetup
}

export interface MockFailScript extends MockScript {
  /** Grader ids (or types) that must fail with this script. */
  expectFail: string[]
}

export interface EvalTask {
  id: string
  category: TaskCategory
  /** One line, Chinese, what the task checks. */
  description: string
  turns: TaskTurn[]
  /** Directory under evals/zh/fixtures copied into the workspace. */
  fixture?: string
  generated?: GeneratedAsset[]
  seedHistory?: SeedHistory
  setup?: TaskSetup
  limits?: TaskLimits
  graders: Grader[]
  mock: { pass: MockScript; fail?: MockFailScript }
}

// ── worker protocol ────────────────────────────────────────────────────────

export interface ContextProbe {
  id: string
  pattern: string
  flags?: string
}

export interface WorkerTurnJob {
  kind: 'turn'
  mode: EvalMode
  cwd: string
  prompt: string
  sessionId?: string
  imagePaths: string[]
  maxTurns: number
  setup: TaskSetup
  seedHistory?: SeedHistory
  probes: ContextProbe[]
  mock?: { steps: MockStep[]; aux: MockAuxReply[] }
  /** Fake servers reinstalled so far in this task. */
  serversReinstalled?: string[]
  outFile: string
}

export interface WorkerJudgeJob {
  kind: 'judge'
  mode: EvalMode
  cwd: string
  request: string
  reply: string
  rubric: string
  /** Mock mode only (self-test): the judge model's canned answer. */
  mockReply?: string
  outFile: string
}

export type WorkerJob = WorkerTurnJob | WorkerJudgeJob

export interface ToolEvent {
  name: string
  args: Record<string, unknown>
  /** undefined when only the tool name is known (sub-agent calls, cleared results). */
  ok?: boolean
  output?: string
  /** Sub-agent role, for calls made by a delegated agent. */
  agent?: string
}

export interface Usage {
  requests: number
  /** Every input token sent (uncached + cache reads + cache writes): the context size. */
  inputTokens: number
  outputTokens: number
  /** Input billed at the normal input rate: neither read from nor written to a cache. */
  uncachedInputTokens?: number
  /** Input read from the provider's prompt cache. */
  cacheReadTokens?: number
  /** Input written to the cache; the 5-minute / 1-hour parts when the provider reports them. */
  cacheWriteTokens?: number
  cacheWrite5mTokens?: number
  cacheWrite1hTokens?: number
  /** Compaction summary requests (cold summarizer or continuation) and their input tokens. */
  summarizerRequests?: number
  summarizerInputTokens?: number
  /** Failed model requests by kind: "400 invalid_request_error", "429", "stream overloaded_error", "network". */
  apiErrors?: Record<string, number>
  /** Priced with the rate table (live runs with prices); left out of a total that has unpriced calls. */
  costUsd?: number
  /** Calls whose model has no rates: the cost of anything that includes them is "unpriced", never $0. */
  unpricedRequests?: number
  /** Cost of the compaction summary requests alone. */
  summarizerCostUsd?: number
}

/** Context compactions of a task: tier 1 (old tool results cleared), tier 2 (summarized), and how tier 2 was written. */
export interface CompactionCounts {
  tier1: number
  tier2: number
  /** Tier-2 summaries by path, when the engine logs it (cache-aware option on): continuation, cold, mechanical, reused. */
  paths?: Record<string, number>
  /** Tier 2 with the mechanical summary (the summarizer failed or was skipped). */
  mechanical: number
}

export interface TranscriptEntry {
  role: string
  name?: string
  content: string
}

export interface TurnTrace {
  prompt: string
  reply: string
  /** Model turns runHeadlessAgent reported (0 = answered without the model, e.g. the Saga offer). */
  modelTurns: number
  sessionId?: string
  durationMs: number
  /** direct | plan | team | compare | design | saga | saga-offer */
  workflow: string
  contextNotices: string[]
  tools: ToolEvent[]
  /** Total over every model call of the turn (main, helpers, sub-agents), metered at the HTTP layer. */
  usage: Usage
  /** Main-model calls only, from the engine's own [usage] lines. */
  mainUsage: Usage
  probes: Record<string, { first: boolean; last: boolean; any: boolean }>
  /** Main-model requests seen (tools attached). */
  mainRequests: number
  transcript: TranscriptEntry[]
  /** The engine's `[agent-update]` and `[agent-status]` lines, in order. */
  events?: string[]
  /** Hosts the mock-mode network guard refused. */
  blockedHosts: string[]
  /** Tier-2 summary paths the engine logged (`[context] summary path=…`), in order. */
  summaryPaths?: string[]
  error?: string
  infoTail: string[]
}

export interface JudgeOutcome {
  score?: number
  reasons?: string
  raw?: string
  error?: string
  usage: Usage
}

export type GraderStatus = 'pass' | 'fail' | 'skip'

export interface GraderResult {
  id: string
  type: GraderType
  status: GraderStatus
  detail: string
}

export type TaskStatus = 'pass' | 'fail' | 'error' | 'timeout' | 'budget' | 'skipped'

export interface TaskResult {
  id: string
  category: TaskCategory
  description: string
  status: TaskStatus
  /** Passed graders / graded (non-skipped) graders. */
  score: number
  graders: GraderResult[]
  turns: TurnTrace[]
  usage: Usage
  costUsd?: number
  compactions?: CompactionCounts
  durationMs: number
  judge?: JudgeOutcome
  error?: string
  /** Which mock script ran (self-test). */
  variant?: 'pass' | 'fail'
  repeat?: number
}

export interface CategorySummary {
  tasks: number
  passed: number
  passRate: number
  meanScore: number
}

export interface RunSummary {
  tasks: number
  passed: number
  passRate: number
  meanScore: number
  byCategory: Record<string, CategorySummary>
  usage: Usage
  costUsd?: number
  compactions?: CompactionCounts
  wallMs: number
}

export interface RunResults {
  version: 1
  startedAt: string
  finishedAt: string
  mode: EvalMode
  git?: { commit?: string; branch?: string; dirty?: boolean }
  provider?: { model?: string; protocol?: string; host?: string; worker?: string }
  options: Record<string, unknown>
  /** Live runs with rates: what the dollar budget was charged (unpriced calls at the highest rates). */
  budgetSpentUsd?: number
  summary: RunSummary
  tasks: TaskResult[]
}
