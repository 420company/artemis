export type PluginPolicyCategory = 'read' | 'write' | 'shell' | 'delegate';

export type NormalizedPluginPolicy = {
  read: boolean;
  write: boolean;
  shell: boolean;
  delegate: boolean;
  commandPrefixes: string[];
};

export type PluginExecutionIntent =
  | {
      type: 'run_command';
      command: string;
    }
  | {
      type: 'write';
      target?: string;
    }
  | {
      type: 'delegate_task';
      role?: string;
    };

export type PluginPolicyDecision = {
  allowed: boolean;
  reason: string;
};

const DEFAULT_POLICY: NormalizedPluginPolicy = {
  read: false,
  write: false,
  shell: false,
  delegate: false,
  commandPrefixes: [],
};

const SHELL_CAPABILITIES = new Set(['commands', 'hooks', 'shell']);
const WRITE_CAPABILITIES = new Set(['writes', 'edits', 'patches']);
const DELEGATE_CAPABILITIES = new Set(['agents', 'delegation', 'delegate']);

function normalizeCommandPrefix(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function normalizePluginPolicy(input: unknown): {
  policy: NormalizedPluginPolicy;
  issues: string[];
} {
  if (input === undefined) {
    return {
      policy: { ...DEFAULT_POLICY },
      issues: [],
    };
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      policy: { ...DEFAULT_POLICY },
      issues: ['Plugin policy must be an object when provided.'],
    };
  }

  const record = input as Record<string, unknown>;
  const issues: string[] = [];

  function readBooleanField(
    field: keyof Pick<NormalizedPluginPolicy, 'read' | 'write' | 'shell' | 'delegate'>,
  ): boolean {
    const value = record[field];
    if (value === undefined) {
      return false;
    }
    if (typeof value !== 'boolean') {
      issues.push(`Plugin policy field "${field}" must be boolean.`);
      return false;
    }
    return value;
  }

  let commandPrefixes: string[] = [];
  if (record.commandPrefixes !== undefined) {
    if (!Array.isArray(record.commandPrefixes)) {
      issues.push('Plugin policy field "commandPrefixes" must be an array of strings.');
    } else {
      commandPrefixes = [...new Set(
        record.commandPrefixes
          .filter(
            (entry): entry is string =>
              typeof entry === 'string' && entry.trim().length > 0,
          )
          .map(normalizeCommandPrefix),
      )];
      if (
        commandPrefixes.length !== record.commandPrefixes.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).length
      ) {
        issues.push(
          'Plugin policy field "commandPrefixes" must contain only non-empty strings.',
        );
      }
    }
  }

  return {
    policy: {
      read: readBooleanField('read'),
      write: readBooleanField('write'),
      shell: readBooleanField('shell'),
      delegate: readBooleanField('delegate'),
      commandPrefixes,
    },
    issues,
  };
}

export function getRequiredPluginPolicyCategories(
  capabilities: string[],
): PluginPolicyCategory[] {
  const required = new Set<PluginPolicyCategory>();

  for (const capability of capabilities.map((entry) => entry.toLowerCase().trim())) {
    if (SHELL_CAPABILITIES.has(capability)) {
      required.add('shell');
    }
    if (WRITE_CAPABILITIES.has(capability)) {
      required.add('write');
    }
    if (DELEGATE_CAPABILITIES.has(capability)) {
      required.add('delegate');
    }
  }

  return [...required];
}

export function getPluginPolicyGateIssues(options: {
  enabled: boolean;
  capabilities: string[];
  policy: NormalizedPluginPolicy;
}): string[] {
  if (!options.enabled) {
    return [];
  }

  const issues: string[] = [];
  const required = getRequiredPluginPolicyCategories(options.capabilities);

  if (required.includes('shell') && !options.policy.shell) {
    issues.push(
      'Plugin capabilities require shell access, but policy.shell is not enabled.',
    );
  }
  if (
    required.includes('shell') &&
    options.policy.shell &&
    options.policy.commandPrefixes.length === 0
  ) {
    issues.push(
      'Shell-enabled plugins must declare policy.commandPrefixes.',
    );
  }
  if (required.includes('write') && !options.policy.write) {
    issues.push(
      'Plugin capabilities require write access, but policy.write is not enabled.',
    );
  }
  if (required.includes('delegate') && !options.policy.delegate) {
    issues.push(
      'Plugin capabilities require delegate access, but policy.delegate is not enabled.',
    );
  }

  return issues;
}

export function buildPluginPolicySummary(
  policy: NormalizedPluginPolicy | undefined,
): string | undefined {
  if (!policy) {
    return undefined;
  }

  const flags = [
    policy.read ? 'read' : '',
    policy.write ? 'write' : '',
    policy.shell ? 'shell' : '',
    policy.delegate ? 'delegate' : '',
    policy.commandPrefixes.length > 0
      ? `prefixes=${policy.commandPrefixes.join(',')}`
      : '',
  ].filter(Boolean);

  return flags.length > 0 ? flags.join(' ') : 'none';
}

function commandMatchesPrefix(command: string, prefix: string): boolean {
  if (command === prefix) {
    return true;
  }

  if (!command.startsWith(`${prefix} `)) {
    return false;
  }

  const remainder = command.slice(prefix.length).trimStart();
  return !/[&|;><`\r\n]/.test(remainder);
}

export function evaluatePluginPolicyIntent(
  status: 'ready' | 'gated' | 'invalid',
  enabled: boolean,
  policy: NormalizedPluginPolicy | undefined,
  intent: PluginExecutionIntent,
): PluginPolicyDecision {
  if (!enabled) {
    return {
      allowed: false,
      reason: 'plugin is disabled',
    };
  }

  if (status !== 'ready') {
    return {
      allowed: false,
      reason: `plugin is ${status} and cannot execute until it passes the policy gate`,
    };
  }

  if (!policy) {
    return {
      allowed: false,
      reason: 'plugin policy is missing',
    };
  }

  switch (intent.type) {
    case 'run_command': {
      if (!policy.shell) {
        return {
          allowed: false,
          reason: 'plugin policy does not allow shell execution',
        };
      }
      const normalizedCommand = normalizeCommandPrefix(intent.command);
      const matchedPrefix = policy.commandPrefixes.find((prefix) =>
        commandMatchesPrefix(normalizedCommand, prefix),
      );

      if (!matchedPrefix) {
        return {
          allowed: false,
          reason: 'command is outside the plugin command prefix allowlist',
        };
      }

      return {
        allowed: true,
        reason: `allowed by plugin command prefix ${matchedPrefix}`,
      };
    }
    case 'write':
      return policy.write
        ? { allowed: true, reason: 'allowed by plugin write policy' }
        : { allowed: false, reason: 'plugin policy does not allow write actions' };
    case 'delegate_task':
      return policy.delegate
        ? { allowed: true, reason: 'allowed by plugin delegate policy' }
        : {
            allowed: false,
            reason: 'plugin policy does not allow delegated agent execution',
          };
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}
