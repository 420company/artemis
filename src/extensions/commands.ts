import type { AgentAction, SessionRecord } from '../core/types.js';
import { runBuilderProposalAgent, runSpecialistAgent } from '../core/agent.js';
import {
  getChangedFilesForAction,
  isVerificationCommand,
} from '../core/verification.js';
import { pickLocale, type UiLocale } from '../cli/locale.js';
import type { ChatProvider, ProviderTarget } from '../providers/types.js';
import { PermissionManager } from '../security/permissions.js';
import { SessionStore } from '../storage/sessions.js';
import { executeAction } from '../tools/index.js';
import {
  buildPluginsReport,
  discoverPlugins,
  type DiscoveredPlugin,
  type PluginCommandDefinition,
} from './plugins.js';
import { evaluatePluginPolicyIntent } from './pluginPolicy.js';

type PluginExecutableAction = Extract<
  AgentAction,
  | { type: 'run_command' }
  | { type: 'write_file' }
  | { type: 'insert_in_file' }
  | { type: 'replace_in_file' }
  | { type: 'apply_patch' }
  | { type: 'delegate_task' }
>;

export type ParsedPluginCommand =
  | { type: 'list' }
  | { type: 'run'; pluginId: string; command: string }
  | { type: 'invalid'; reason: string };

export type PluginCommandResult = {
  ok: boolean;
  reply: string;
  view: 'list' | 'execution' | 'usage';
};

export type PluginRuntimeContext = {
  session: SessionRecord;
  sessionStore: SessionStore;
  provider: ChatProvider;
  maxTurns: number;
  ensureSpecialistProvider?: (roles: import('../core/types.ts').AgentRole[]) => Promise<void>;
  resolveProvider?: (target: ProviderTarget) => ChatProvider;
  onInfo?: (message: string) => void;
};

function normalizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildPluginUsage(locale: UiLocale): string {
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en });
  return [
    `${t('用法', 'Usage')}:`,
    'plugins',
    'plugins run <plugin-id> <command...>',
    'plugins exec <plugin-id> <command-id> [args...]',
    'plugins exec <plugin-id> <command-id> [args...]',
    '',
    t(
      '示例: plugins run git-tools "git status --short"',
      'Example: plugins run git-tools "git status --short"',
    ),
    t(
      '示例: plugins run reviewer review src/app.ts',
      'Example: plugins exec reviewer review src/app.ts',
    ),
  ].join('\n');
}

export function parsePluginCommand(input: string): ParsedPluginCommand {
  const trimmed = input.trim();
  if (!trimmed) {
    return { type: 'list' };
  }

  const [subcommand, ...rest] = trimmed.split(/\s+/);
  if (subcommand === 'exec') {
    const [pluginId, commandId, ...args] = rest;
    if (!pluginId || !commandId) {
      return {
        type: 'invalid',
        reason: 'plugins exec requires both a plugin id and a command id.',
      };
    }

    return {
      type: 'run',
      pluginId,
      command: [commandId, ...args].join(' ').trim(),
    };
  }

  if (subcommand !== 'run' && subcommand !== 'exec') {
    return {
      type: 'invalid',
      reason: `Unknown plugins subcommand: ${subcommand}`,
    };
  }

  const [pluginId, ...commandParts] = rest;
  if (!pluginId || commandParts.length === 0) {
    return {
      type: 'invalid',
      reason: `plugins ${subcommand} requires both a plugin id and a command.`,
    };
  }

  return {
    type: 'run',
    pluginId,
    command: commandParts.join(' ').trim(),
  };
}

function findPluginBySelector(
  selector: string,
  plugins: DiscoveredPlugin[],
): DiscoveredPlugin | undefined {
  const normalizedSelector = normalizeId(selector);
  return plugins.find(
    (plugin) =>
      plugin.id === normalizedSelector ||
      normalizeId(plugin.name) === normalizedSelector,
  );
}

function findPluginCommand(
  plugin: DiscoveredPlugin,
  commandId: string,
): PluginCommandDefinition | undefined {
  const normalized = normalizeId(commandId);
  return plugin.commands.find((command) => command.id === normalized);
}

function interpolateTemplate(
  template: string,
  options: {
    plugin: DiscoveredPlugin;
    command: PluginCommandDefinition;
    args: string[];
  },
): string {
  return template.replace(/\{\{\s*([a-z0-9._-]+)\s*\}\}/gi, (_, token) => {
    const normalizedToken = String(token).toLowerCase();
    if (normalizedToken === 'args') {
      return options.args.join(' ');
    }
    if (normalizedToken === 'plugin') {
      return options.plugin.id;
    }
    if (normalizedToken === 'command') {
      return options.command.id;
    }
    if (/^arg\d+$/.test(normalizedToken)) {
      const index = Number.parseInt(normalizedToken.slice(3), 10);
      return Number.isNaN(index) ? '' : (options.args[index] ?? '');
    }
    return '';
  });
}

function materializePluginAction(options: {
  plugin: DiscoveredPlugin;
  command: PluginCommandDefinition;
  args: string[];
}): PluginExecutableAction {
  const action = options.command.action;
  switch (action.type) {
    case 'run_command':
      return {
        type: 'run_command',
        command: interpolateTemplate(action.command, options).trim(),
        timeoutMs: action.timeoutMs,
      };
    case 'write_file':
      return {
        type: 'write_file',
        path: interpolateTemplate(action.path, options).trim(),
        content: interpolateTemplate(action.content, options),
      };
    case 'insert_in_file':
      return {
        type: 'insert_in_file',
        path: interpolateTemplate(action.path, options).trim(),
        content: interpolateTemplate(action.content, options),
        after: action.after
          ? interpolateTemplate(action.after, options)
          : undefined,
        before: action.before
          ? interpolateTemplate(action.before, options)
          : undefined,
        atLine: action.atLine,
      };
    case 'replace_in_file':
      return {
        type: 'replace_in_file',
        path: interpolateTemplate(action.path, options).trim(),
        find: interpolateTemplate(action.find, options),
        replace: interpolateTemplate(action.replace, options),
        replaceAll: action.replaceAll,
      };
    case 'apply_patch':
      return {
        type: 'apply_patch',
        patch: interpolateTemplate(action.patch, options),
      };
    case 'delegate_task':
      return {
        type: 'delegate_task',
        role: action.role,
        task: interpolateTemplate(action.task, options).trim(),
        maxTurns: action.maxTurns,
      };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function describePluginAction(action: PluginExecutableAction): string {
  switch (action.type) {
    case 'run_command':
      return `run_command ${action.command}`;
    case 'write_file':
      return `write_file ${action.path}`;
    case 'insert_in_file':
      return `insert_in_file ${action.path}`;
    case 'replace_in_file':
      return `replace_in_file ${action.path}`;
    case 'apply_patch':
      return 'apply_patch';
    case 'delegate_task':
      return `delegate_task ${action.role} ${action.task}`;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function buildPluginExecutionReply(options: {
  locale: UiLocale;
  title: string;
  plugin?: DiscoveredPlugin;
  command?: string;
  action?: string;
  policyReason?: string;
  permissionReason?: string;
  output?: string;
}): string {
  const t = (zh: string, en: string) => pickLocale(options.locale, { zh, en });
  return [
    options.title,
    options.plugin ? `${t('插件', 'Plugin')}: ${options.plugin.id}` : '',
    options.command ? `${t('命令', 'Command')}: ${options.command}` : '',
    options.action ? `${t('动作', 'Action')}: ${options.action}` : '',
    options.policyReason ? `${t('策略', 'Policy')}: ${options.policyReason}` : '',
    options.permissionReason
      ? `${t('权限', 'Permission')}: ${options.permissionReason}`
      : '',
    options.output ? `${t('输出', 'Output')}:\n${options.output}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function getPluginIntentForAction(action: PluginExecutableAction) {
  switch (action.type) {
    case 'run_command':
      return {
        type: 'run_command' as const,
        command: action.command,
      };
    case 'write_file':
    case 'insert_in_file':
    case 'replace_in_file':
    case 'apply_patch':
      return {
        type: 'write' as const,
        target: 'path' in action ? action.path : 'patch',
      };
    case 'delegate_task':
      return {
        type: 'delegate_task' as const,
        role: action.role,
      };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

async function persistPluginActionSideEffects(options: {
  action: PluginExecutableAction;
  ok: boolean;
  runtime?: PluginRuntimeContext;
}): Promise<void> {
  if (!options.runtime || !options.ok) {
    return;
  }

  const { action, runtime } = options;
  let changed = false;

  const changedFiles = getChangedFilesForAction(action);
  if (changedFiles.length > 0) {
    runtime.sessionStore.recordChangedFiles(runtime.session, changedFiles);
    changed = true;
  }

  if (
    action.type === 'run_command' &&
    isVerificationCommand(action.command)
  ) {
    runtime.sessionStore.recordVerificationCommand(
      runtime.session,
      action.command,
      true,
    );
    changed = true;
  }

  if (changed) {
    await runtime.sessionStore.save(runtime.session);
  }
}

async function executePluginAction(options: {
  action: PluginExecutableAction;
  cwd: string;
  permissionManager: PermissionManager;
  runtime?: PluginRuntimeContext;
}): Promise<{ ok: boolean; output: string; permissionReason: string }> {
  const permissionDecision = await options.permissionManager.authorize(
    options.action,
  );
  if (!permissionDecision.allowed) {
    return {
      ok: false,
      output: '',
      permissionReason: permissionDecision.reason,
    };
  }

  if (options.action.type === 'delegate_task') {
    if (!options.runtime) {
      return {
        ok: false,
        output:
          'Plugin delegate commands require an active session runtime. Use interactive, resume, or remote mode first.',
        permissionReason: permissionDecision.reason,
      };
    }

    if (options.action.role === 'builder') {
      const builderProposal = await runBuilderProposalAgent(
        options.runtime.session,
        options.action.task,
        {
          cwd: options.cwd,
          provider: options.runtime.provider,
          sessionStore: options.runtime.sessionStore,
          permissionManager: options.permissionManager,
          maxTurns: options.action.maxTurns ?? options.runtime.maxTurns,
          ensureSpecialistProvider: options.runtime.ensureSpecialistProvider,
          resolveProvider: options.runtime.resolveProvider,
          onInfo: options.runtime.onInfo,
        },
      );

      return {
        ok: true,
        output: JSON.stringify(
          {
            role: builderProposal.role,
            sessionId: builderProposal.session.id,
            status: 'approval_required',
            turns: builderProposal.result.turns,
            reply: builderProposal.result.reply,
          },
          null,
          2,
        ),
        permissionReason: permissionDecision.reason,
      };
    }

    const specialist = await runSpecialistAgent(
      options.runtime.session,
      options.action.role,
      options.action.task,
      {
        cwd: options.cwd,
        provider: options.runtime.provider,
        sessionStore: options.runtime.sessionStore,
        permissionManager: options.permissionManager,
        maxTurns: options.action.maxTurns ?? options.runtime.maxTurns,
        ensureSpecialistProvider: options.runtime.ensureSpecialistProvider,
        resolveProvider: options.runtime.resolveProvider,
        onInfo: options.runtime.onInfo,
      },
    );

    return {
      ok: true,
      output: JSON.stringify(
        {
          role: specialist.role,
          sessionId: specialist.session.id,
          turns: specialist.result.turns,
          reply: specialist.result.reply,
        },
        null,
        2,
      ),
      permissionReason: permissionDecision.reason,
    };
  }

  const result = await executeAction(options.action, {
    cwd: options.cwd,
  });
  await persistPluginActionSideEffects({
    action: options.action,
    ok: result.ok,
    runtime: options.runtime,
  });
  return {
    ok: result.ok,
    output: result.output,
    permissionReason: permissionDecision.reason,
  };
}

export async function runPluginCommand(options: {
  cwd: string;
  body: string;
  permissionManager: PermissionManager;
  locale?: UiLocale;
  runtime?: PluginRuntimeContext;
}): Promise<PluginCommandResult> {
  const locale = options.locale ?? 'en';
  const parsed = parsePluginCommand(options.body);

  if (parsed.type === 'list') {
    return {
      ok: true,
      view: 'list',
      reply: buildPluginsReport(await discoverPlugins(options.cwd), locale),
    };
  }

  if (parsed.type === 'invalid') {
    return {
      ok: false,
      view: 'usage',
      reply: [parsed.reason, '', buildPluginUsage(locale)].join('\n'),
    };
  }

  const discovered = await discoverPlugins(options.cwd);
  const plugin = findPluginBySelector(parsed.pluginId, discovered.plugins);
  if (!plugin) {
    return {
      ok: false,
      view: 'usage',
      reply: [
        `Unknown plugin: ${parsed.pluginId}`,
        '',
        buildPluginUsage(locale),
      ].join('\n'),
    };
  }

  const commandSelector = parsed.command.split(/\s+/).filter(Boolean)[0];
  const commandArgs = parsed.command.split(/\s+/).filter(Boolean).slice(1);
  const manifestCommand = commandSelector
    ? findPluginCommand(plugin, commandSelector)
    : undefined;
  const action = manifestCommand
    ? materializePluginAction({
        plugin,
        command: manifestCommand,
        args: commandArgs,
      })
    : ({
        type: 'run_command',
        command: parsed.command,
      } satisfies PluginExecutableAction);

  const policyDecision = evaluatePluginPolicyIntent(
    plugin.status,
    plugin.enabled,
    plugin.policy,
    getPluginIntentForAction(action),
  );
  if (!policyDecision.allowed) {
    return {
      ok: false,
      view: 'execution',
      reply: buildPluginExecutionReply({
        locale,
        title: 'Plugin command blocked by the policy gate.',
        plugin,
        command: parsed.command,
        action: describePluginAction(action),
        policyReason: policyDecision.reason,
      }),
    };
  }

  const result = await executePluginAction({
    action,
    cwd: options.cwd,
    permissionManager: options.permissionManager,
    runtime: options.runtime,
  });

  if (!result.ok && !result.output) {
    return {
      ok: false,
      view: 'execution',
      reply: buildPluginExecutionReply({
        locale,
        title: 'Plugin command blocked by the permission layer.',
        plugin,
        command: parsed.command,
        action: describePluginAction(action),
        policyReason: policyDecision.reason,
        permissionReason: result.permissionReason,
      }),
    };
  }

  return {
    ok: result.ok,
    view: 'execution',
    reply: buildPluginExecutionReply({
      locale,
      title: result.ok
        ? 'Plugin command executed.'
        : 'Plugin command failed.',
      plugin,
      command: parsed.command,
      action: describePluginAction(action),
      policyReason: policyDecision.reason,
      permissionReason: result.permissionReason,
      output: result.output,
    }),
  };
}
