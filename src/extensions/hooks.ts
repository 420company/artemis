import { PermissionManager } from '../security/permissions.js';
import { executeAction } from '../tools/index.js';
import { truncate } from '../utils/fs.js';
import { evaluatePluginPolicyIntent } from './pluginPolicy.js';
import {
  discoverPlugins,
  type DiscoveredPlugin,
  type PluginHookName,
} from './plugins.js';

type PluginHookRunResult = {
  plugin: DiscoveredPlugin;
  command: string;
  ok: boolean;
  outcome: 'executed' | 'policy_blocked' | 'permission_blocked' | 'failed';
  summary: string;
};

export type PluginHookBatchResult = {
  event: PluginHookName;
  results: PluginHookRunResult[];
};

async function runPluginHook(options: {
  cwd: string;
  event: PluginHookName;
  plugin: DiscoveredPlugin;
  permissionManager: PermissionManager;
}): Promise<PluginHookRunResult> {
  const command = options.plugin.hooks?.[options.event] ?? '';
  const policyDecision = evaluatePluginPolicyIntent(
    options.plugin.status,
    options.plugin.enabled,
    options.plugin.policy,
    {
      type: 'run_command',
      command,
    },
  );
  if (!policyDecision.allowed) {
    return {
      plugin: options.plugin,
      command,
      ok: false,
      outcome: 'policy_blocked',
      summary: policyDecision.reason,
    };
  }

  const action = {
    type: 'run_command' as const,
    command,
  };
  const permissionDecision = await options.permissionManager.authorize(action);
  if (!permissionDecision.allowed) {
    return {
      plugin: options.plugin,
      command,
      ok: false,
      outcome: 'permission_blocked',
      summary: permissionDecision.reason,
    };
  }

  const result = await executeAction(action, {
    cwd: options.cwd,
  });
  return {
    plugin: options.plugin,
    command,
    ok: result.ok,
    outcome: result.ok ? 'executed' : 'failed',
    summary: truncate(result.output, 220),
  };
}

export async function runPluginHooks(options: {
  cwd: string;
  event: PluginHookName;
  permissionManager: PermissionManager;
}): Promise<PluginHookBatchResult> {
  const discovery = await discoverPlugins(options.cwd);
  const candidates = discovery.plugins.filter(
    (plugin) =>
      plugin.enabled &&
      plugin.status === 'ready' &&
      Boolean(plugin.hooks?.[options.event]),
  );

  const results: PluginHookRunResult[] = [];
  for (const plugin of candidates) {
    results.push(
      await runPluginHook({
        cwd: options.cwd,
        event: options.event,
        plugin,
        permissionManager: options.permissionManager,
      }),
    );
  }

  return {
    event: options.event,
    results,
  };
}
