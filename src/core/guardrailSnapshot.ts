import path from 'node:path';
import { pathExists, readTextFileSafe } from '../utils/fs.js';

type GuardrailDescriptor = {
  path: string;
  checks: RegExp[];
  summary: string;
};

const GUARDRAIL_DESCRIPTORS: GuardrailDescriptor[] = [
  {
    path: 'src/cli/parseArgs.ts',
    checks: [
      /function isPermissionMode/i,
      /Invalid --permission-mode value\./,
      /Dangerous shortcut: forces --permission-mode PRODUCER/,
      /if \(current === '--whosyourdaddy'\)/,
      /last explicit permission flag wins/i,
      /permissionMode = 'PRODUCER';/,
      /permissionModeExplicit = true;/,
    ],
    summary:
      "src/cli/parseArgs.ts defines isPermissionMode(), documents --whosyourdaddy as a dangerous PRODUCER shortcut, throws 'Invalid --permission-mode value.' on bad input, sets permissionModeExplicit=true when the shortcut is used, and keeps the last explicit permission flag authoritative.",
  },
  {
    path: 'src/cli/runCli.ts',
    checks: [
      /export function assertValidAgentRuntimePolicies/i,
      /export function assertValidToolRegistryIntegrity/i,
      /export function shouldUseInteractiveWorkflowPermissions/i,
      /assertValidAgentRuntimePolicies\(\);/,
      /assertValidToolRegistryIntegrity\(\);/,
      /const effectivePermissionMode =/,
      /new PermissionManager\(\s*effectivePermissionMode,\s*shouldUseInteractiveWorkflowPermissions\(promptIO\),\s*\)/s,
    ],
    summary:
      'src/cli/runCli.ts hard-fails on both validateAgentRuntimePolicies() and validateToolRegistryIntegrity() before execution, then derives effectivePermissionMode and passes it into new PermissionManager(effectivePermissionMode, shouldUseInteractiveWorkflowPermissions(promptIO)) so prompt mode stays interactive on real terminals.',
  },
  {
    path: 'src/cli/doctor.ts',
    checks: [
      /export async function buildDoctorReport/i,
      /Live provider tests: skipped/,
      /await probeProviderConfig\(probe\.config\)/,
      /Provider profiles are stored in plain text on disk\./,
    ],
    summary:
      'src/cli/doctor.ts builds a first-class diagnostics report covering the active data root, provider file path, inline override state, saved provider routing, and optional live provider probes.',
  },
  {
    path: 'src/cli/interactive.ts',
    checks: [
      /function isPermissionMode/i,
      /export function resolveInteractivePermissionModeChange/i,
      /Permission mode locked by CLI flag ->/,
      /context\.permissionManager\.setMode\(change\.mode \?\? context\.permissionManager\.getMode\(\)\)/,
    ],
    summary:
      'src/cli/interactive.ts validates /mode through resolveInteractivePermissionModeChange() and refuses interactive overrides when the CLI started the session with an explicit locked permission mode.',
  },
  {
    path: 'src/cli/interactive.ts',
    checks: [
      /const advice = await maybeUpgradeWorkflow\(/,
      /const result = await runWorkflowMode\(/,
      /permissionManager: context\.permissionManager,/,
      /context\.ensureSpecialistProvider \?\?\s*providerRouter\.ensureSpecialistProvider/s,
      /context\.resolveProvider \?\?\s*providerRouter\.resolveProvider/s,
    ],
    summary:
      'src/cli/interactive.ts routes free-form interactive input through maybeUpgradeWorkflow() and runWorkflowMode() while reusing the current session permission manager plus the active provider router for specialist resolution, so unlocked interactive runs do not silently swap permission or provider context.',
  },
  {
    path: 'src/channels/runtime.ts',
    checks: [
      /new PermissionManager\(\s*options\.permissionMode,\s*false,\s*\)/s,
      /case '\/tools':/,
      /getDetailedToolManifest\(/,
      /const result = await runWorkflowMode\(/,
    ],
    summary:
      'src/channels/runtime.ts constructs new PermissionManager(options.permissionMode, false) before dispatching remote workflow commands and exposes /tools remotely so channel runtimes can inspect tool metadata.',
  },
  {
    path: 'src/security/permissions.ts',
    checks: [
      /getToolPermissionCategory\(/,
      /constructor\(mode: PermissionMode, interactive: boolean\)/,
      /this\.mode === 'read-only'/,
      /blocked by read-only mode/,
    ],
    summary:
      'src/security/permissions.ts derives permission categories from the tool registry metadata, uses the second PermissionManager constructor parameter only for interactive prompting, and still enforces read-only mode separately for write/shell actions.',
  },
  {
    path: 'src/providers/health.ts',
    checks: [
      /export function inspectInlineProviderConfig/i,
      /status: 'incomplete'/,
      /export async function probeProviderConfig/i,
      /Reply with exactly OK\./,
      /Provider connection test timed out after/,
    ],
    summary:
      'src/providers/health.ts inspects inline ARTEMIS_* overrides for missing fields and provides a reusable Reply-with-exactly-OK connection probe with timeout handling.',
  },
  {
    path: 'src/providers/onboarding.ts',
    checks: [
      /export async function promptForVerifiedProviderProfile/i,
      /Testing provider connection for/,
      /Connection test failed\. Retry this setup, save anyway, or cancel\?/,
      /const inlineConfig = inspectInlineProviderConfig\(options\.config\);/,
    ],
    summary:
      'src/providers/onboarding.ts now validates inline env/flag overrides with exact missing-field errors and runs a provider connection test before saving interactive execution or brain profiles.',
  },
  {
    path: 'src/utils/fs.ts',
    checks: [
      /export function resolveInsideRoot/i,
      /Path escapes working directory:/,
    ],
    summary:
      'src/utils/fs.ts enforces resolveInsideRoot(root, inputPath) and throws "Path escapes working directory" when a file action tries to traverse outside the workspace root.',
  },
  {
    path: 'src/core/agentProfiles.ts',
    checks: [
      /export function getDelegatedPermissionMode/i,
      /role === 'builder' \|\| role === 'designer'/,
      /return baseMode;/,
      /return 'read-only';/,
      /export function validateAgentRuntimePolicies/i,
      /\$\{role\} runtime policy must not allow delegate_task/,
      /specialist role \$\{role\} should stay read-only but allows:/,
    ],
    summary:
      'src/core/agentProfiles.ts clamps delegated permissions at the role-policy layer: builder/designer inherit the parent mode for execution, analysis specialists stay read-only, and validateAgentRuntimePolicies() rejects role/action matrices that contradict those rules.',
  },
  {
    path: 'src/core/delegatedPermissions.ts',
    checks: [
      /export function getDelegatedChildPermissionMode/i,
      /export function createDelegatedChildPermissionManager/i,
      /role === 'builder' && phase === 'proposal'/,
      /return 'read-only';/,
      /return getDelegatedPermissionMode\(role, parentMode\);/,
      /return parentPermissionManager\.fork\(/,
    ],
    summary:
      'src/core/delegatedPermissions.ts centralizes delegated child permission binding: builder proposal sessions are forced to read-only, builder/designer execution inherits the parent write mode, and analysis specialists fold through getDelegatedPermissionMode(role, parentMode).',
  },
  {
    path: 'src/core/agent.ts',
    checks: [
      /validateProfileAction\(profile, action\)/,
      /options\.permissionManager\.authorize\(action\)/,
    ],
    summary:
      'src/core/agent.ts checks validateProfileAction(profile, action) and then calls options.permissionManager.authorize(action) before executeAgentAction(), so write and shell executors are only reached after the runtime guardrails allow them.',
  },
  {
    path: 'src/core/agent.ts',
    checks: [
      /await recordDelegatedChildBinding\(/,
      /Delegated Child Runtime Bound/,
      /child_permission_mode=/,
      /const \{ allowed, denied \} = await resolveActionPermissions\(\s*delegateBatch,/s,
      /await options\.ensureSpecialistProvider\?\.\(\s*allowed\.map\(\(action\) => action\.role\),/s,
    ],
    summary:
      'src/core/agent.ts centralizes delegated child permission binding, records child_permission_mode workflow evidence, and filters delegate_task actions through profile and permission guardrails before any specialist-provider bootstrap runs for the surviving roles.',
  },
  {
    path: 'src/core/agent.ts',
    checks: [
      /const \{ allowed, denied \} = await resolveActionPermissions\(\s*delegateBatch,/s,
      /const \{ allowed, denied \} = await resolveActionPermissions\(\[action\], options\);/s,
      /await executeAuthorizedAction\(session, allowed\[0\], options, true\)/,
    ],
    summary:
      'src/core/agent.ts routes both batched and single generated actions through resolveActionPermissions() before executeAuthorizedAction(), so assistant-created actions hit PermissionManager authorization before execution.',
  },
  {
    path: 'src/tools/registry.ts',
    checks: [
      /permissionCategory:/,
      /executionMode:/,
      /export function renderDetailedToolManifest/i,
      /export function getToolPermissionCategory/i,
      /export function getToolExecutionMode/i,
      /export function validateToolAction/i,
      /export function validateToolRegistryIntegrity/i,
      /duplicate tool definition for/,
      /must use permissionCategory=/,
      /should use executionMode=/,
      /tool registry is missing a definition for/,
      /runtime-managed tool .* must not define a direct executor/,
      /read tool \$\{tool\.type\} should stay parallelSafe/,
      /mutating tool \$\{tool\.type\} should not be parallelSafe/,
      /value > 0/,
      /validateOptionalNonEmptyString/,
      /validateAgentRoleValue/,
      /return tool\.validate\(action\)/,
    ],
    summary:
      'src/tools/registry.ts now acts as the single source of truth for tool descriptions, permissionCategory, executionMode, validators, and detailed /tools manifest rendering, while self-auditing duplicate/missing definitions, runtime-managed executor drift, and parallelSafe invariants.',
  },
  {
    path: 'src/core/workflowAdvisor.ts',
    checks: [
      /getWorkflowDisplayName/,
      /better suited for \$\{getWorkflowDisplayName\(advice\.recommended\)\} mode/,
      /\[advisor\] upgraded to \$\{getWorkflowDisplayName\(advice\.recommended\)\}/,
      /recommended=\$\{getWorkflowDisplayName\(advice\.recommended\)\}/,
    ],
    summary:
      'src/core/workflowAdvisor.ts keeps the internal brainstorm workflow while rendering the public niko label in upgrade prompts, advisor logs, and workflow records.',
  },
  {
    path: 'src/tools/index.ts',
    checks: [
      /function buildExecutionErrorFallbackResult/i,
      /return buildExecutionErrorFallbackResult\(action, error\)/,
      /The action was rejected before executor dispatch\./,
      /Tool execution failed for \$\{action\.type\}:/,
    ],
    summary:
      'src/tools/index.ts rejects runtime-managed tools before executor dispatch and catches tool executor exceptions into structured ok=false results with the tool label via buildExecutionErrorFallbackResult().',
  },
  {
    path: 'scripts/runtimeSmoke.ts',
    checks: [
      /getDetailedToolManifest/,
      /buildDoctorReport/,
      /getPermissionCategoryForActionType\('approve_builder_execution'\)/,
      /getToolExecutionMode\('delegate_task'\)/,
      /parseRemoteCommand\('\/doctor'\)/,
      /provider health inspection should report incomplete inline overrides/,
      /doctor report should surface incomplete inline provider overrides before runtime use/,
      /parseRemoteCommand\('\/tools'\)/,
      /remote \/tools should expose the detailed tool manifest/,
      /Invalid arguments for tool read_file:/,
      /maxResults must be a positive integer/,
      /pattern must be a non-empty string/,
      /timeoutMs must be a positive integer/,
      /--whosyourdaddy should act as a full-access shortcut for PRODUCER mode/,
      /later --whosyourdaddy flags should override earlier explicit permission modes/,
      /later --permission-mode flags should override earlier --whosyourdaddy shortcuts/,
      /workflow CLI runs should preserve interactive permission prompting when console prompt IO is available/,
      /interactive \/mode should not override an explicitly locked CLI permission mode/,
      /builder execution should inherit the parent PRODUCER mode/,
      /builder proposal children should always bind to read-only mode before approval/,
      /approved builder execution children should inherit the parent edit mode/,
      /non-builder delegated children should stay read-only even when the parent mode is broader/,
      /specialist child permission managers should stay read-only even when the parent mode allows writes/,
      /builder proposal sessions should stay read-only before explicit approval/,
      /Generated delegate action passed through PermissionManager before specialist bootstrap/,
      /Generated write action passed through PermissionManager before execution/,
      /tool registry integrity should stay aligned with the action union and executor\/runtime-managed split/,
      /tool manifest should render .* so \/tools stays aligned with the registry/,
      /workflow advisor prompts should use the public niko label instead of the internal brainstorm mode name/,
      /Invalid arguments for tool approve_builder_execution:/,
      /role must be one of: planner, researcher, builder, reviewer, ideation specialist \(brainstormer\), arbiter/,
      /after must be a non-empty string/,
      /replaceAll must be a boolean/,
      /rejected before executor dispatch/,
      /Tool execution failed for apply_patch:/,
      /Patch did not contain any file operations/,
      /Path escapes working directory: \.\.\/escape\.txt/,
      /Tool execution failed for insert_in_file:/,
      /outside the file bounds/,
    ],
    summary:
      'scripts/runtimeSmoke.ts already exercises the --whosyourdaddy full-access alias, doctor/inline-provider diagnostics, startup registry integrity assertions, detailed /tools metadata coverage, registry-derived permission categories and execution modes, remote /tools and /doctor exposure, delegated permission binding for builder/specialist child sessions, workflow CLI prompt interactivity, generated action authorization for write_file/delegate_task, registry-driven validation across read_file, search_files, list_files, replace_in_file, malformed optional strings, run_command, delegate_task, approve_builder_execution, workspace traversal blocking, plus src/tools/index.ts exception handling through apply_patch and insert_in_file executor failures.',
  },
  {
    path: 'scripts/workflowSmoke.ts',
    checks: [
      /builder child workflow should record its delegated runtime binding/,
      /builder execution workflow should record the inherited child permission mode/,
      /assert\.equal\(workflow\?\.includes\('Niko Completed'\), true\);/,
      /assert\.equal\(workflow\?\.includes\('Brainstorm Completed'\), false\);/,
    ],
    summary:
      'scripts/workflowSmoke.ts verifies Niko workflow labeling and confirms builder child workflows record delegated runtime binding plus inherited child_permission_mode during Athena execution.',
  },
  {
    path: 'src/core/agent.ts',
    checks: [
      /const result = await executeAgentAction\(session, action, options\);/,
      /return \{\s*action,\s*ok: false,\s*output: message,\s*\}/s,
    ],
    summary:
      'src/core/agent.ts wraps executeAgentAction() in a try/catch and returns { action, ok: false, output: message } on tool failures.',
  },
  {
    path: 'src/tools/readFile.ts',
    checks: [
      /Continue with startLine=/,
    ],
    summary:
      'src/tools/readFile.ts tells the model how to continue chunked reads instead of treating truncation as a blocker.',
  },
];

export async function buildGuardrailSnapshot(
  cwd: string,
  options?: {
    maxNotes?: number;
  },
): Promise<string> {
  const maxNotes = options?.maxNotes ?? 20;
  const notes: string[] = [];

  for (const descriptor of GUARDRAIL_DESCRIPTORS) {
    const absolute = path.join(cwd, descriptor.path);
    if (!(await pathExists(absolute))) {
      continue;
    }

    const content = await readTextFileSafe(absolute);
    if (!descriptor.checks.every((check) => check.test(content))) {
      continue;
    }

    notes.push(`- ${descriptor.summary}`);
    if (notes.length >= maxNotes) {
      break;
    }
  }

  if (notes.length === 0) {
    return '';
  }

  return [
    'Known runtime guardrails already present:',
    ...notes,
  ].join('\n');
}
