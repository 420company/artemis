import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentRole } from '../core/types.js';
import { pickLocale, type UiLocale } from '../cli/locale.js';
import { pathExists, resolveDataRootDir, truncate } from '../utils/fs.js';
import {
  buildPluginPolicySummary,
  getPluginPolicyGateIssues,
  normalizePluginPolicy,
  type NormalizedPluginPolicy,
} from './pluginPolicy.js';

export type PluginSource = 'workspace' | 'data-root';
export type PluginStatus = 'ready' | 'gated' | 'invalid';
export type PluginHookName = 'beforeWorkflow' | 'afterWorkflow';
export type PluginHookDefinition = Partial<Record<PluginHookName, string>>;
export type PluginCommandAction =
  | {
      type: 'run_command';
      command: string;
      timeoutMs?: number;
    }
  | {
      type: 'write_file';
      path: string;
      content: string;
    }
  | {
      type: 'insert_in_file';
      path: string;
      content: string;
      after?: string;
      before?: string;
      atLine?: number;
    }
  | {
      type: 'replace_in_file';
      path: string;
      find: string;
      replace: string;
      replaceAll?: boolean;
    }
  | {
      type: 'apply_patch';
      patch: string;
    }
  | {
      type: 'delegate_task';
      role: AgentRole;
      task: string;
      maxTurns?: number;
    };
export type PluginCommandDefinition = {
  id: string;
  description?: string;
  action: PluginCommandAction;
};

export type DiscoveredPlugin = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
  source: PluginSource;
  dirPath: string;
  manifestPath?: string;
  instructionsFile?: string;
  instructionsPath?: string;
  capabilities: string[];
  hooks?: PluginHookDefinition;
  commands: PluginCommandDefinition[];
  policy?: NormalizedPluginPolicy;
  status: PluginStatus;
  gateIssues: string[];
  issues: string[];
};

export type PluginDiscoveryResult = {
  roots: Array<{ source: PluginSource; path: string; exists: boolean }>;
  plugins: DiscoveredPlugin[];
};

type PluginManifest = {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  enabled?: unknown;
  capabilities?: unknown;
  hooks?: unknown;
  commands?: unknown;
  instructionsFile?: unknown;
  policy?: unknown;
};

function normalizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizePluginHooks(input: unknown): {
  hooks?: PluginHookDefinition;
  issues: string[];
} {
  if (input === undefined) {
    return { hooks: undefined, issues: [] };
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      hooks: undefined,
      issues: ['Plugin hooks must be an object when provided.'],
    };
  }

  const record = input as Record<string, unknown>;
  const hooks: PluginHookDefinition = {};
  const issues: string[] = [];

  for (const key of ['beforeWorkflow', 'afterWorkflow'] as const) {
    const value = record[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string' || !value.trim()) {
      issues.push(`Plugin hook "${key}" must be a non-empty string.`);
      continue;
    }
    hooks[key] = value.trim();
  }

  return {
    hooks: Object.keys(hooks).length > 0 ? hooks : undefined,
    issues,
  };
}

function isAgentRole(value: unknown): value is AgentRole {
  return (
    value === 'planner' ||
    value === 'researcher' ||
    value === 'builder' ||
    value === 'reviewer' ||
    value === 'brainstormer' ||
    value === 'arbiter'
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function normalizePluginCommands(input: unknown): {
  commands: PluginCommandDefinition[];
  issues: string[];
} {
  if (input === undefined) {
    return {
      commands: [],
      issues: [],
    };
  }

  if (!Array.isArray(input)) {
    return {
      commands: [],
      issues: ['Plugin commands must be an array when provided.'],
    };
  }

  const commands: PluginCommandDefinition[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of input.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push(`Plugin command #${index + 1} must be an object.`);
      continue;
    }

    const record = entry as Record<string, unknown>;
    const id =
      typeof record.id === 'string' && record.id.trim()
        ? normalizeId(record.id)
        : '';
    if (!id) {
      issues.push(`Plugin command #${index + 1} is missing a valid id.`);
      continue;
    }
    if (seen.has(id)) {
      issues.push(`Duplicate plugin command id detected: ${id}.`);
      continue;
    }

    const description =
      typeof record.description === 'string' && record.description.trim()
        ? truncate(record.description.trim(), 160)
        : undefined;
    const type =
      typeof record.type === 'string' && record.type.trim()
        ? record.type.trim()
        : '';

    if (type === 'run_command') {
      const command =
        typeof record.command === 'string' && record.command.trim()
          ? record.command.trim()
          : '';
      if (!command) {
        issues.push(`Plugin command ${id} requires a non-empty command.`);
        continue;
      }

      seen.add(id);
      commands.push({
        id,
        description,
        action: {
          type: 'run_command',
          command,
          timeoutMs: isPositiveInteger(record.timeoutMs)
            ? record.timeoutMs
            : undefined,
        },
      });
      continue;
    }

    if (type === 'write_file') {
      const filePath =
        typeof record.path === 'string' && record.path.trim()
          ? record.path.trim()
          : '';
      const content =
        typeof record.content === 'string' ? record.content : undefined;
      if (!filePath) {
        issues.push(`Plugin command ${id} requires a non-empty path.`);
        continue;
      }
      if (content === undefined) {
        issues.push(`Plugin command ${id} requires a string content field.`);
        continue;
      }

      seen.add(id);
      commands.push({
        id,
        description,
        action: {
          type: 'write_file',
          path: filePath,
          content,
        },
      });
      continue;
    }

    if (type === 'insert_in_file') {
      const filePath =
        typeof record.path === 'string' && record.path.trim()
          ? record.path.trim()
          : '';
      const content =
        typeof record.content === 'string' && record.content.trim()
          ? record.content
          : undefined;
      const anchorCount = [
        typeof record.after === 'string' ? record.after : undefined,
        typeof record.before === 'string' ? record.before : undefined,
        record.atLine,
      ].filter((value) => value !== undefined).length;
      if (!filePath) {
        issues.push(`Plugin command ${id} requires a non-empty path.`);
        continue;
      }
      if (content === undefined) {
        issues.push(`Plugin command ${id} requires a non-empty content field.`);
        continue;
      }
      if (anchorCount !== 1) {
        issues.push(
          `Plugin command ${id} requires exactly one anchor: after, before, or atLine.`,
        );
        continue;
      }
      if (
        record.atLine !== undefined &&
        !isPositiveInteger(record.atLine)
      ) {
        issues.push(`Plugin command ${id} atLine must be a positive integer.`);
        continue;
      }

      seen.add(id);
      commands.push({
        id,
        description,
        action: {
          type: 'insert_in_file',
          path: filePath,
          content,
          after:
            typeof record.after === 'string' && record.after.trim()
              ? record.after
              : undefined,
          before:
            typeof record.before === 'string' && record.before.trim()
              ? record.before
              : undefined,
          atLine: isPositiveInteger(record.atLine) ? record.atLine : undefined,
        },
      });
      continue;
    }

    if (type === 'replace_in_file') {
      const filePath =
        typeof record.path === 'string' && record.path.trim()
          ? record.path.trim()
          : '';
      const find =
        typeof record.find === 'string' && record.find.trim()
          ? record.find
          : '';
      const replace =
        typeof record.replace === 'string' ? record.replace : undefined;
      if (!filePath) {
        issues.push(`Plugin command ${id} requires a non-empty path.`);
        continue;
      }
      if (!find) {
        issues.push(`Plugin command ${id} requires non-empty find text.`);
        continue;
      }
      if (replace === undefined) {
        issues.push(`Plugin command ${id} requires a string replace field.`);
        continue;
      }
      if (
        record.replaceAll !== undefined &&
        typeof record.replaceAll !== 'boolean'
      ) {
        issues.push(`Plugin command ${id} replaceAll must be boolean when provided.`);
        continue;
      }

      seen.add(id);
      commands.push({
        id,
        description,
        action: {
          type: 'replace_in_file',
          path: filePath,
          find,
          replace,
          replaceAll: record.replaceAll === true,
        },
      });
      continue;
    }

    if (type === 'apply_patch') {
      const patch =
        typeof record.patch === 'string' && record.patch.trim()
          ? record.patch
          : '';
      if (!patch) {
        issues.push(`Plugin command ${id} requires a non-empty patch.`);
        continue;
      }

      seen.add(id);
      commands.push({
        id,
        description,
        action: {
          type: 'apply_patch',
          patch,
        },
      });
      continue;
    }

    if (type === 'delegate_task') {
      if (!isAgentRole(record.role)) {
        issues.push(
          `Plugin command ${id} requires role to be planner, researcher, builder, reviewer, ideation specialist (brainstormer), or arbiter.`,
        );
        continue;
      }
      const task =
        typeof record.task === 'string' && record.task.trim()
          ? record.task.trim()
          : '';
      if (!task) {
        issues.push(`Plugin command ${id} requires a non-empty task.`);
        continue;
      }
      if (
        record.maxTurns !== undefined &&
        !isPositiveInteger(record.maxTurns)
      ) {
        issues.push(`Plugin command ${id} maxTurns must be a positive integer.`);
        continue;
      }

      seen.add(id);
      commands.push({
        id,
        description,
        action: {
          type: 'delegate_task',
          role: record.role,
          task,
          maxTurns: isPositiveInteger(record.maxTurns)
            ? record.maxTurns
            : undefined,
        },
      });
      continue;
    }

    issues.push(
      `Plugin command ${id} uses unsupported type "${type}".`,
    );
  }

  return {
    commands,
    issues,
  };
}

async function loadPluginFromDirectory(options: {
  root: string;
  name: string;
  source: PluginSource;
}): Promise<DiscoveredPlugin> {
  const dirPath = path.join(options.root, options.name);
  const manifestPath = path.join(dirPath, '.artemis-plugin', 'plugin.json');
  const issues: string[] = [];

  if (!(await pathExists(manifestPath))) {
    issues.push('Missing .artemis-plugin/plugin.json.');
    return {
      id: normalizeId(options.name),
      name: options.name,
      enabled: true,
      source: options.source,
      dirPath,
      manifestPath,
      capabilities: [],
      commands: [],
      status: 'invalid',
      gateIssues: [],
      issues,
    };
  }

  let parsed: PluginManifest;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as PluginManifest;
  } catch (error) {
    return {
      id: normalizeId(options.name),
      name: options.name,
      enabled: true,
      source: options.source,
      dirPath,
      manifestPath,
      capabilities: [],
      commands: [],
      status: 'invalid',
      gateIssues: [],
      issues: [
        `Invalid plugin manifest JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }

  const name =
    typeof parsed.name === 'string' && parsed.name.trim()
      ? parsed.name.trim()
      : options.name;
  const version =
    typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : undefined;
  const description =
    typeof parsed.description === 'string' && parsed.description.trim()
      ? truncate(parsed.description.trim(), 160)
      : undefined;
  const enabled = parsed.enabled !== false;
  const capabilities = Array.isArray(parsed.capabilities)
    ? parsed.capabilities
        .filter(
          (entry): entry is string =>
            typeof entry === 'string' && entry.trim().length > 0,
        )
        .map((entry) => entry.trim())
    : [];
  const configuredInstructionsFile =
    typeof parsed.instructionsFile === 'string' &&
    parsed.instructionsFile.trim().length > 0
      ? parsed.instructionsFile.trim()
      : undefined;
  const defaultInstructionsPath = path.join(
    dirPath,
    '.artemis-plugin',
    'PLUGIN.md',
  );
  const defaultInstructionsExists = await pathExists(defaultInstructionsPath);
  const instructionsFile =
    configuredInstructionsFile ??
    (defaultInstructionsExists ? 'PLUGIN.md' : undefined);
  const instructionsPath = instructionsFile
    ? path.join(dirPath, '.artemis-plugin', instructionsFile)
    : undefined;
  const normalizedHooks = normalizePluginHooks(parsed.hooks);
  const normalizedCommands = normalizePluginCommands(parsed.commands);
  const normalizedPolicy = normalizePluginPolicy(parsed.policy);

  if (!version) {
    issues.push('Plugin manifest is missing version.');
  }
  if (
    configuredInstructionsFile &&
    instructionsPath &&
    !(await pathExists(instructionsPath))
  ) {
    issues.push(
      `Plugin instructions file is missing: ${configuredInstructionsFile}.`,
    );
  }
  issues.push(
    ...normalizedHooks.issues,
    ...normalizedCommands.issues,
    ...normalizedPolicy.issues,
  );

  const derivedCapabilities = [
    ...normalizedCommands.commands.flatMap((command) => {
      switch (command.action.type) {
        case 'run_command':
          return ['commands'];
        case 'write_file':
        case 'insert_in_file':
        case 'replace_in_file':
        case 'apply_patch':
          return ['writes'];
        case 'delegate_task':
          return ['delegate'];
        default:
          return [];
      }
    }),
    ...(normalizedHooks.hooks ? ['hooks'] : []),
  ];

  const gateIssues = getPluginPolicyGateIssues({
    enabled,
    capabilities: [...capabilities, ...derivedCapabilities],
    policy: normalizedPolicy.policy,
  });

  return {
    id: normalizeId(name),
    name,
    version,
    description,
    enabled,
    source: options.source,
    dirPath,
    manifestPath,
    instructionsFile,
    instructionsPath,
    capabilities,
    hooks: normalizedHooks.hooks,
    commands: normalizedCommands.commands,
    policy: normalizedPolicy.policy,
    status:
      issues.length > 0 ? 'invalid' : gateIssues.length > 0 ? 'gated' : 'ready',
    gateIssues,
    issues: [...issues, ...gateIssues],
  };
}

export async function discoverPlugins(
  cwd: string,
): Promise<PluginDiscoveryResult> {
  const roots = [
    {
      source: 'workspace' as const,
      path: path.join(cwd, 'plugins'),
    },
    {
      source: 'data-root' as const,
      path: path.join(resolveDataRootDir(cwd), 'plugins'),
    },
  ];

  const discovered: DiscoveredPlugin[] = [];

  for (const root of roots) {
    if (!(await pathExists(root.path))) {
      continue;
    }

    const entries = await readdir(root.path, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      discovered.push(
        await loadPluginFromDirectory({
          root: root.path,
          name: entry.name,
          source: root.source,
        }),
      );
    }
  }

  const duplicates = new Map<string, number>();
  for (const plugin of discovered) {
    duplicates.set(plugin.id, (duplicates.get(plugin.id) ?? 0) + 1);
  }

  const plugins = discovered
    .map((plugin) =>
      (duplicates.get(plugin.id) ?? 0) > 1
        ? {
            ...plugin,
            status: 'invalid' as const,
            issues: [...plugin.issues, 'Duplicate plugin id detected.'],
          }
        : plugin,
    )
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    roots: await Promise.all(
      roots.map(async (root) => ({
        ...root,
        exists: await pathExists(root.path),
      })),
    ),
    plugins,
  };
}

function buildPluginLine(plugin: DiscoveredPlugin): string {
  const policySummary = buildPluginPolicySummary(plugin.policy);

  return [
    `- ${plugin.id}`,
    `[${plugin.source} ${plugin.status} ${plugin.enabled ? 'enabled' : 'disabled'}]`,
    plugin.version ? `version=${plugin.version}` : '',
    plugin.description ? `desc=${truncate(plugin.description, 100)}` : '',
    plugin.capabilities.length > 0
      ? `caps=${plugin.capabilities.join(',')}`
      : '',
    plugin.hooks
      ? `hooks=${Object.keys(plugin.hooks).join(',')}`
      : '',
    plugin.commands.length > 0
      ? `commands=${plugin.commands.map((command) => command.id).join(',')}`
      : '',
    policySummary ? `policy=${policySummary}` : '',
    plugin.instructionsFile ? `instructions=${plugin.instructionsFile}` : '',
    `path=${plugin.dirPath}`,
    plugin.issues.length > 0
      ? `issues=${truncate(plugin.issues.join(' '), 120)}`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function buildPluginsReport(
  result: PluginDiscoveryResult,
  locale: UiLocale = 'en',
): string {
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en });
  const ready = result.plugins.filter((plugin) => plugin.status === 'ready').length;
  const gated = result.plugins.filter((plugin) => plugin.status === 'gated').length;
  const invalid = result.plugins.filter((plugin) => plugin.status === 'invalid').length;
  const enabled = result.plugins.filter((plugin) => plugin.enabled).length;
  const lines = [
    `${t('插件总数', 'Total plugins')}: ${result.plugins.length}`,
    `${t('可用', 'Ready')}: ${ready}`,
    `${t('受限', 'Gated')}: ${gated}`,
    `${t('无效', 'Invalid')}: ${invalid}`,
    `${t('已启用', 'Enabled')}: ${enabled}`,
    '',
    ...result.roots.map(
      (root) =>
        `${t(
          root.source === 'workspace' ? '工作区目录' : '数据目录',
          root.source === 'workspace' ? 'Workspace root' : 'Data-root',
        )}: ${root.path} (${root.exists ? t('存在', 'present') : t('缺失', 'missing')})`,
    ),
  ];

  if (result.plugins.length === 0) {
    lines.push('');
    lines.push(t('当前没有发现本地 plugins。', 'No local plugins discovered.'));
    return lines.join('\n');
  }

  lines.push('');
  lines.push(...result.plugins.map(buildPluginLine));
  return lines.join('\n');
}
