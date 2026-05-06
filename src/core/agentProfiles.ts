import type { AgentAction, AgentRole, PermissionMode } from './types.js';
import { getPermissionCategoryForActionType } from '../security/permissions.js';

export type ExecutionProfile = 'main' | AgentRole;

const READ_ONLY_ACTION_TYPES: AgentAction['type'][] = [
  'list_files',
  'read_file',
  'search_files',
  'lookup_docs',
  'deep_research',
  'mcp_read_resource',
  'mcp_get_prompt',
];

const BUILDER_ACTION_TYPES: AgentAction['type'][] = [
  ...READ_ONLY_ACTION_TYPES,
  'write_file',
  'insert_in_file',
  'replace_in_file',
  'apply_patch',
  'run_command',
  'generate_image',
  'generate_video',
];

const DESIGNER_ACTION_TYPES: AgentAction['type'][] = [
  ...BUILDER_ACTION_TYPES,
];

export const AGENT_ROLE_DESCRIPTIONS: Record<AgentRole, string> = {
  planner: 'Break work into a concrete execution plan with minimal tool use.',
  researcher: 'Collect evidence from the repo and summarize facts precisely.',
  builder: 'Implement targeted code or content changes with minimal churn.',
  reviewer: 'Check for bugs, regressions, risks, and verification gaps.',
  brainstormer:
    'Use a Diverge -> Converge workflow to clarify constraints, compare options, and recommend a plan.',
  arbiter:
    'Judge competing proposals and critiques, then decide the safest high-signal path.',
  architect: 'Analyze system architecture and design optimal solutions.',
  designer: 'Design UI/UX and visual components for the solution.',
  qa: 'Define quality assurance strategy and testing approaches.',
};

export function getAgentRoleInstructions(role: AgentRole): string[] {
  switch (role) {
    case 'planner':
      return [
        'Agent role: planner.',
        'Your job is to decompose the task into an efficient sequence.',
        'Prefer read-only investigation and concrete action plans.',
        'Do not make edits unless the parent agent explicitly delegated build work to you.',
      ];
    case 'researcher':
      return [
        'Agent role: researcher.',
        'Your job is to inspect the repo and return evidence-backed findings.',
        'Prefer list_files, search_files, and read_file.',
        'If a target file is large, read it in chunks rather than assuming one read saw the whole file.',
        'Avoid edits and shell commands unless absolutely necessary.',
      ];
    case 'builder':
      return [
        'Agent role: builder.',
        'Your job is to make precise, minimal changes that satisfy the delegated task from the parent agent.',
        'Treat the delegated task as the highest priority and do not drift into unrelated cleanup.',
        'If the task is ambiguous, inspect the repo, form a concrete solution, and report that proposal back before editing.',
        'Only execute code changes after the parent agent explicitly approves execution.',
        'Re-read the file context before each edit and verify the resulting file after the edit lands.',
        'For rename-style work, explicitly sweep direct refs, type refs, string literals, dynamic imports, re-exports, tests, and mocks.',
        'Prefer apply_patch for multi-hunk or multi-file edits that need stable context.',
        'Prefer replace_in_file over full-file rewrite when editing existing files.',
        'After code changes, run relevant verification commands or explicitly state why verification was not possible.',
        'Leave the repo in a coherent state and explain what changed.',
      ];
    case 'reviewer':
      return [
        'Agent role: reviewer.',
        'Your job is to find defects, risks, edge cases, and missing verification.',
        'Default to read-only investigation and concrete findings.',
        'Do not make edits unless explicitly required for validation.',
      ];
    case 'brainstormer':
      return [
        'Agent role: brainstormer.',
        'Your job is to turn ambiguous technical requests into a focused plan.',
        'First clarify hidden constraints, then diverge across 4-6 different approaches, then converge on one recommendation.',
        'Keep the output compact: avoid long essays and avoid generating more options than needed.',
        'Default to read-only exploration and do not make edits unless the user explicitly asks for implementation.',
      ];
    case 'arbiter':
      return [
        'Agent role: arbiter.',
        'Your job is to judge a proposal against a critique and decide the best next move.',
        'Prefer decisions backed by evidence and concrete tradeoffs, not rhetoric.',
        'Keep the verdict compact and actionable.',
        'Default to read-only analysis and do not make edits.',
      ];
    case 'architect':
      return [
        'Agent role: architect.',
        'Your job is to analyze system architecture and design optimal solutions.',
        'Focus on scalability, maintainability, and extensibility of the system.',
        'Identify potential architectural patterns and trade-offs.',
        'Provide architectural recommendations and design specifications.',
        'Default to read-only analysis and do not make edits.',
      ];
    case 'designer':
      return [
        'Agent role: designer.',
        'Your job is to design UI/UX and visual components for the solution.',
        'Consider user experience and visual design best practices.',
        'Provide design recommendations, wireframe ideas, and concrete UI assets when the task asks for them.',
        'Focus on creating intuitive and aesthetically pleasing interfaces.',
        'When the parent task asks for implementation, SVG, logo, theme, or frontend files, create or modify the requested files directly.',
      ];
    case 'qa':
      return [
        'Agent role: qa.',
        'Your job is to define quality assurance strategy and testing approaches.',
        'Identify potential testing methods, tools, and frameworks.',
        'Consider performance, security, and reliability testing.',
        'Provide QA recommendations and test plan outlines.',
        'Default to read-only analysis and do not make edits.',
      ];
    default: {
      const exhaustive: never = role;
      return [String(exhaustive)];
    }
  }
}

export function getDelegatedPermissionMode(
  role: AgentRole,
  baseMode: PermissionMode,
): PermissionMode {
  if (role === 'builder' || role === 'designer') {
    return baseMode;
  }

  return 'read-only';
}

export function getAllowedActionTypesForProfile(
  profile: ExecutionProfile,
): AgentAction['type'][] {
  if (profile === 'main') {
    return [
      'list_files',
      'read_file',
      'search_files',
      'lookup_docs',
      'deep_research',
      'mcp_call_tool',
      'mcp_read_resource',
      'mcp_get_prompt',
      'write_file',
      'insert_in_file',
      'replace_in_file',
      'apply_patch',
      'run_command',
      'delegate_task',
      'approve_builder_execution',
    ];
  }

  if (profile === 'builder') {
    return BUILDER_ACTION_TYPES;
  }

  if (profile === 'designer') {
    return DESIGNER_ACTION_TYPES;
  }

  return READ_ONLY_ACTION_TYPES;
}

export function validateProfileAction(
  profile: ExecutionProfile,
  action: AgentAction,
): { allowed: boolean; reason?: string } {
  if (
    profile !== 'main' &&
    action.type === 'mcp_call_tool' &&
    action.readOnly === true
  ) {
    return { allowed: true };
  }

  const allowedTypes = new Set(getAllowedActionTypesForProfile(profile));

  if (allowedTypes.has(action.type)) {
    return { allowed: true };
  }

  if (profile === 'builder' || profile === 'designer') {
    return {
      allowed: false,
      reason:
        `${profile} agents may inspect files, edit files, and run verification commands, but they cannot delegate new tasks or approve their own execution.`,
    };
  }

  return {
    allowed: false,
    reason:
      `${profile} agents are restricted to read-only investigation tools at runtime.`,
  };
}

export function getProfileActionPolicyInstructions(
  profile: ExecutionProfile,
): string[] {
  if (profile === 'main') {
    return [
      'Runtime action policy: main may use any registered tool, subject to permission mode and explicit approval requirements.',
    ];
  }

  return [
    `Runtime action policy: ${profile} may only use ${getAllowedActionTypesForProfile(profile).join(', ')}.`,
    profile === 'builder' || profile === 'designer'
      ? 'Do not delegate new tasks or call approve_builder_execution from inside this execution-capable specialist.'
      : 'Do not request write, shell, delegation, or approval tools from this specialist profile.',
  ];
}

export function validateAgentRuntimePolicies(): string[] {
  const issues: string[] = [];
  const roles = Object.keys(AGENT_ROLE_DESCRIPTIONS) as AgentRole[];

  for (const role of roles) {
    if (getAgentRoleInstructions(role).length === 0) {
      issues.push(`role ${role} has no runtime instructions`);
    }

    const allowedTypes = getAllowedActionTypesForProfile(role);
    if (allowedTypes.length === 0) {
      issues.push(`role ${role} has no allowed runtime actions`);
      continue;
    }

    const delegatedMode = getDelegatedPermissionMode(role, 'PRODUCER');
    if (delegatedMode === 'read-only') {
      const nonReadTypes = allowedTypes.filter(
        (type) => getPermissionCategoryForActionType(type) !== 'read',
      );
      if (nonReadTypes.length > 0) {
        issues.push(
          `role ${role} is read-only but allows non-read actions: ${nonReadTypes.join(', ')}`,
        );
      }
    }

    if (role === 'builder' || role === 'designer') {
      if (allowedTypes.includes('delegate_task')) {
        issues.push(`${role} runtime policy must not allow delegate_task`);
      }
      if (allowedTypes.includes('approve_builder_execution')) {
        issues.push(
          `${role} runtime policy must not allow approve_builder_execution`,
        );
      }
      continue;
    }

    const invalidSpecialistTypes = allowedTypes.filter(
      (type) => getPermissionCategoryForActionType(type) !== 'read',
    );
    if (invalidSpecialistTypes.length > 0) {
      issues.push(
        `specialist role ${role} should stay read-only but allows: ${invalidSpecialistTypes.join(', ')}`,
      );
    }
  }

  return issues;
}

export function getAgentRoleManifest(): string {
  return Object.entries(AGENT_ROLE_DESCRIPTIONS)
    .map(([role, description]) => `- ${role}: ${description}`)
    .join('\n');
}
