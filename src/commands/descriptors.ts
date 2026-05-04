export type CommandGroup =
  | 'core'
  | 'workflow'
  | 'knowledge'
  | 'models'
  | 'project'
  | 'permissions';

export type LocalizedText = {
  zh: string;
  en: string;
};

export type CommandDescriptor = {
  id: string;
  group: CommandGroup;
  cli?: string;
  slash?: string;
  remote?: string;
  autocomplete?: boolean;
  quickValue?: string;
  desc: LocalizedText;
};

export const COMMAND_GROUP_ORDER: CommandGroup[] = [
  'core',
  'workflow',
  'knowledge',
  'models',
  'project',
  'permissions',
];

export const COMMAND_GROUP_TITLES: Record<CommandGroup, LocalizedText> = {
  core: { zh: 'Core', en: 'Core' },
  workflow: { zh: 'Workflow', en: 'Workflow' },
  knowledge: { zh: 'Docs and research', en: 'Docs and research' },
  models: { zh: 'Models and configuration', en: 'Models and configuration' },
  project: { zh: 'Project and platform', en: 'Project and platform' },
  permissions: {
    zh: 'Permissions and verification',
    en: 'Permissions and verification',
  },
};

export const COMMAND_DESCRIPTORS: CommandDescriptor[] = [
  {
    id: 'start',
    group: 'core',
    slash: '/start',
    remote: '/start',
    desc: { zh: 'Activate the current remote session', en: 'Activate the current remote session' },
  },
  {
    id: 'help',
    group: 'core',
    cli: 'help',
    slash: '/help',
    remote: '/help',
    autocomplete: true,
    desc: { zh: 'Show help', en: 'Show help' },
  },
  {
    id: 'commands',
    group: 'core',
    cli: 'commands',
    slash: '/commands',
    remote: '/commands',
    autocomplete: true,
    desc: { zh: 'Show the unified command catalog', en: 'Show the unified command catalog' },
  },
  {
    id: 'new',
    group: 'core',
    slash: '/new',
    remote: '/new',
    desc: { zh: 'Start a new session', en: 'Start a new session' },
  },
  {
    id: 'language',
    group: 'core',
    slash: '/language',
    autocomplete: true,
    quickValue: '/language',
    desc: { zh: 'Switch the interface language', en: 'Switch the interface language' },
  },
  {
    id: 'sessions',
    group: 'core',
    cli: 'sessions',
    slash: '/session',
    remote: '/session',
    autocomplete: true,
    desc: { zh: 'Inspect the current session state', en: 'Inspect the current session state' },
  },
  {
    id: 'history',
    group: 'core',
    slash: '/history',
    autocomplete: true,
    desc: { zh: 'Show recent messages', en: 'Show recent messages' },
  },
  {
    id: 'context',
    group: 'core',
    slash: '/context',
    remote: '/context',
    autocomplete: true,
    quickValue: '/context',
    desc: { zh: 'Inspect the recent context snapshot', en: 'Inspect the recent context snapshot' },
  },
  {
    id: 'sponsor',
    group: 'core',
    cli: 'sponsor',
    slash: '/sponsor',
    remote: '/sponsor',
    autocomplete: true,
    desc: { zh: 'Show sponsorship details', en: 'Show sponsorship details' },
  },
  {
    id: 'version',
    group: 'core',
    cli: 'version',
    slash: '/version',
    remote: '/version',
    autocomplete: true,
    desc: { zh: 'Show the version', en: 'Show the version' },
  },
  {
    id: 'newborn',
    group: 'core',
    slash: '/newborn',
    autocomplete: true,
    quickValue: '/newborn',
    desc: { zh: '清空所有配置并重新引导设置', en: 'Wipe all config and re-run onboarding' },
  },
  {
    id: 'soul',
    group: 'core',
    slash: '/soul',
    autocomplete: true,
    quickValue: '/soul start',
    desc: { zh: '启动 soul.md 人格配置引导', en: 'Start the soul.md personality setup' },
  },
  {
    id: 'run',
    group: 'workflow',
    cli: 'run <prompt> [--bg]',
    remote: '/direct <task>',
    desc: { zh: 'Run a task directly', en: 'Run a task directly' },
  },
  {
    id: 'athena',
    group: 'workflow',
    cli: 'athena <prompt> [--bg]',
    slash: '/athena <task>',
    remote: '/athena <task>',
    autocomplete: true,
    desc: {
      zh: '启动 Athena 工作流，进行大型多模块研究与执行',
      en: 'Start the Athena workflow for large multi-module research and execution',
    },
  },
  {
    id: 'design',
    group: 'workflow',
    cli: 'design <prompt> [--bg]',
    slash: '/design <task>',
    remote: '/design <task>',
    autocomplete: true,
    desc: {
      zh: '启动 Design 工作流：先做设计，再真实实现',
      en: 'Start the Design workflow: design first, then implement',
    },
  },
  {
    id: 'niko',
    group: 'workflow',
    cli: 'niko <prompt> [--bg]',
    slash: '/niko <task>',
    remote: '/niko <task>',
    autocomplete: true,
    desc: {
      zh: '启动 Niko 工作流：先构思，再执行',
      en: 'Start the Niko workflow: ideate first, then execute',
    },
  },
  {
    id: 'contest',
    group: 'workflow',
    cli: 'contest <prompt> [--bg]',
    slash: '/contest <task>',
    remote: '/contest <task>',
    autocomplete: true,
    desc: {
      zh: '启动 Contest 工作流：比较候选路径，裁决后执行',
      en: 'Start the Contest workflow: compare candidate paths, choose one, then execute',
    },
  },
  {
    id: 'nidhogg',
    group: 'workflow',
    cli: 'nidhogg <prompt> [--bg]',
    slash: '/nidhogg <task>',
    remote: '/nidhogg <task>',
    autocomplete: true,
    desc: {
      zh: '启动 Nidhogg 工作流：对抗式打磨实现，逐轮逼近最优',
      en: 'Start the Nidhogg workflow: harden the implementation through adversarial rounds',
    },
  },
  {
    id: 'plan',
    group: 'workflow',
    slash: '/plan',
    remote: '/plan',
    autocomplete: true,
    desc: { zh: 'Show the current execution plan', en: 'Show the current execution plan' },
  },
  {
    id: 'tasks',
    group: 'workflow',
    cli: 'tasks [sessionId] [add <task>|start <id>|done <id>|block <id>|pending <id>|remove <id>|clear]',
    slash: '/tasks [add <text>|start <id>|done <id>|block <id>|pending <id>|remove <id>|clear]',
    remote: '/tasks [add <text>|start <id>|done <id>|block <id>|pending <id>|remove <id>|clear]',
    autocomplete: true,
    desc: { zh: 'Show or manage the task board', en: 'Show or manage the task board' },
  },
  {
    id: 'runtimes',
    group: 'workflow',
    cli: 'runtimes [sessionId]',
    slash: '/runtimes [interrupt <id>|interrupt-all|clear-finished|clear-all]',
    remote: '/runtimes [interrupt <id>|interrupt-all|clear-finished|clear-all]',
    autocomplete: true,
    quickValue: '/runtimes',
    desc: { zh: 'Inspect or interrupt persisted runtimes', en: 'Inspect or interrupt persisted runtimes' },
  },
  {
    id: 'heimdall',
    group: 'workflow',
    cli: 'heimdall [show|threads [n]|events [--tail <n>] [--after <offset>]|follow [--after <offset>] [--timeout <seconds>]|upload <path...>|cleanup] [sessionId|--last] [--json]',
    slash: '/heimdall [threads [n]|events [n] [--after <offset>]|follow [--after <offset>] [--timeout <seconds>]|upload <path...>|cleanup]',
    remote: '/heimdall [threads [n]|events [n] [--after <offset>]|follow [--after <offset>] [--timeout <seconds>]|upload <path...>|cleanup]',
    autocomplete: true,
    quickValue: '/heimdall',
    desc: {
      zh: '查看或控制 Heimdall 引擎线程、上传区、阻塞状态与事件流',
      en: 'Inspect or control Heimdall engine threads, uploads, blocked states, and event streams',
    },
  },
  {
    id: 'summary',
    group: 'workflow',
    slash: '/summary',
    remote: '/summary',
    autocomplete: true,
    desc: { zh: 'Show the current summary', en: 'Show the current summary' },
  },
  {
    id: 'workflow',
    group: 'workflow',
    slash: '/workflow',
    remote: '/workflow',
    autocomplete: true,
    desc: { zh: 'Show the workflow record', en: 'Show the workflow record' },
  },
  {
    id: 'resume',
    group: 'workflow',
    cli: 'resume [sessionId|--last] [prompt]',
    desc: { zh: 'Resume a session', en: 'Resume a session' },
  },
  {
    id: 'ps',
    group: 'workflow',
    cli: 'ps [--all]',
    slash: '/ps [--all]',
    remote: '/ps [--all]',
    autocomplete: true,
    desc: { zh: 'List persisted runtime processes', en: 'List persisted runtime processes' },
  },
  {
    id: 'logs',
    group: 'workflow',
    cli: 'logs <runtimeId> [--messages <n>]',
    slash: '/logs <runtimeId> [--messages <n>]',
    remote: '/logs <runtimeId> [--messages <n>]',
    autocomplete: true,
    desc: { zh: 'Show runtime logs', en: 'Show runtime logs' },
  },
  {
    id: 'wait',
    group: 'workflow',
    cli: 'wait <runtimeId> [--timeout <seconds>] [--messages <n>]',
    slash: '/wait <runtimeId> [--timeout <seconds>] [--messages <n>]',
    remote: '/wait <runtimeId> [--timeout <seconds>] [--messages <n>]',
    autocomplete: true,
    desc: { zh: 'Wait for a runtime to reach a terminal state', en: 'Wait for a runtime to reach a terminal state' },
  },
  {
    id: 'attach',
    group: 'workflow',
    cli: 'attach <runtimeId>',
    slash: '/attach <runtimeId>',
    remote: '/attach <runtimeId>',
    autocomplete: true,
    desc: { zh: 'Attach to the session behind a runtime', en: 'Attach to the session behind a runtime' },
  },
  {
    id: 'kill',
    group: 'workflow',
    cli: 'kill <runtimeId>',
    slash: '/kill <runtimeId>',
    remote: '/kill <runtimeId>',
    autocomplete: true,
    desc: { zh: 'Interrupt a runtime', en: 'Interrupt a runtime' },
  },
  {
    id: 'docs',
    group: 'knowledge',
    cli: 'docs <query>',
    slash: '/docs <query>',
    remote: '/docs <query>',
    autocomplete: true,
    desc: { zh: 'Look up documentation', en: 'Look up documentation' },
  },
  {
    id: 'search-engine',
    group: 'knowledge',
    cli: 'search-engine [bing|google]',
    slash: '/search-engine [bing|google]',
    remote: '/search-engine [bing|google]',
    autocomplete: true,
    desc: { zh: 'Switch the docs search backend', en: 'Switch the docs search backend' },
  },
  {
    id: 'research-engine',
    group: 'knowledge',
    cli: 'research-engine [builtin|gemini-deep-research]',
    slash: '/research-engine [builtin|gemini-deep-research]',
    remote: '/research-engine [builtin|gemini-deep-research]',
    autocomplete: true,
    desc: { zh: 'Switch the research engine', en: 'Switch the research engine' },
  },
  {
    id: 'research',
    group: 'knowledge',
    slash: '/research <query>',
    remote: '/research <query>',
    autocomplete: true,
    quickValue: '/research repo risk review',
    desc: { zh: 'Run the deep research shortcut alias', en: 'Run the deep research shortcut alias' },
  },
  {
    id: 'deep-research',
    group: 'knowledge',
    cli: 'deep-research <query>',
    slash: '/deep-research <query>',
    remote: '/deep-research <query>',
    autocomplete: true,
    desc: { zh: 'Run a deep research query', en: 'Run a deep research query' },
  },
  {
    id: 'deep-research-config',
    group: 'knowledge',
    cli: 'deep-research-config',
    slash: '/deep-research-config',
    autocomplete: true,
    desc: { zh: 'Configure deep research', en: 'Configure deep research' },
  },
  {
    id: 'providers',
    group: 'models',
    cli: 'providers',
    slash: '/providers',
    remote: '/providers',
    autocomplete: true,
    quickValue: '/providers',
    desc: { zh: 'Show saved provider profiles', en: 'Show saved provider profiles' },
  },
  {
    id: 'model',
    group: 'models',
    slash: '/model',
    autocomplete: true,
    quickValue: '/model',
    desc: { zh: 'Switch the current execution model', en: 'Switch the current execution model' },
  },
  {
    id: 'model-config',
    group: 'models',
    slash: '/model:config',
    remote: '/model:config',
    autocomplete: true,
    quickValue: '/model:config',
    desc: { zh: 'Reopen the API setup wizard', en: 'Reopen the API setup wizard' },
  },
  {
    id: 'mind',
    group: 'models',
    slash: '/mind',
    remote: '/mind',
    autocomplete: true,
    quickValue: '/mind',
    desc: { zh: 'Swap the Forge and Raven APIs', en: 'Swap the Forge and Raven APIs' },
  },
  {
    id: 'doublekill',
    group: 'models',
    cli: 'doublekill',
    slash: '/doublekill',
    remote: '/doublekill',
    autocomplete: true,
    quickValue: '/doublekill',
    desc: { zh: 'Configure or inspect dual-model mode', en: 'Configure or inspect dual-model mode' },
  },
  {
    id: 'bifrost',
    group: 'models',
    cli: 'bifrost',
    slash: '/bifrost',
    remote: '/bifrost',
    autocomplete: true,
    quickValue: '/bifrost',
    desc: { zh: 'Configure Raven and dual-model mode', en: 'Configure Raven and dual-model mode' },
  },
  {
    id: 'bragi',
    group: 'project',
    cli: 'bragi [telegram|discord|lark|wechat|run <platform>|sessions [platform]|config <platform>|reset <platform>]',
    slash: '/bragi',
    autocomplete: true,
    quickValue: '/bragi',
    desc: { zh: 'Inspect or configure the native communications control plane', en: 'Inspect or configure the native communications control plane' },
  },
  {
    id: 'telegram',
    group: 'models',
    cli: 'telegram',
    slash: '/telegram',
    autocomplete: true,
    quickValue: '/telegram',
    desc: {
      zh: 'Telegram 兼容入口（推荐使用 artemis bragi telegram）',
      en: 'Telegram compatibility entry point (recommended: artemis bragi telegram)',
    },
  },
  {
    id: 'telegram-config',
    group: 'models',
    slash: '/telegram:config',
    autocomplete: true,
    quickValue: '/telegram:config',
    desc: { zh: 'Telegram 配置兼容入口', en: 'Telegram compatibility config entry point' },
  },
  {
    id: 'artemis-md',
    group: 'project',
    cli: 'artemis-md',
    slash: '/artemis-md',
    remote: '/artemis-md',
    autocomplete: true,
    desc: { zh: 'Audit Artemis.MD', en: 'Audit Artemis.MD' },
  },
  {
    id: 'revise-artemis-md',
    group: 'project',
    cli: 'revise-artemis-md [sessionId] [--apply]',
    slash: '/revise-artemis-md [--apply]',
    remote: '/revise-artemis-md [--apply]',
    autocomplete: true,
    desc: { zh: 'Generate or apply Artemis.MD improvements', en: 'Generate or apply Artemis.MD improvements' },
  },
  {
    id: 'wordup',
    group: 'project',
    cli: 'wordup [resume <sessionId|snapshot.md> [prompt]|last [prompt]|sessions|now]',
    slash: '/wordup',
    remote: '/wordup',
    autocomplete: true,
    quickValue: '/wordup',
    desc: { zh: 'Enable autosave snapshots or resume a saved session', en: 'Enable autosave snapshots or resume a saved session' },
  },
  {
    id: 'wordupnow',
    group: 'project',
    cli: 'wordupnow',
    slash: '/wordupnow',
    remote: '/wordupnow',
    autocomplete: true,
    desc: { zh: 'Save a fresh snapshot now', en: 'Save a fresh snapshot now' },
  },
  {
    id: 'mcp',
    group: 'project',
    cli: 'mcp [doctor|probe [id]|get <id>|import-json <path>|import-project [path]|add-http <id> <url>|add-sse <id> <url>|add-stdio <id> <command...>|enable <id>|disable <id>|remove <id>|auth <id> <state>|clear-error <id>|reset-state <id>]',
    slash: '/mcp [doctor|probe [id]|get <id>|import-json <path>|import-project [path]|add-http <id> <url>|add-sse <id> <url>|add-stdio <id> <command...>|enable <id>|disable <id>|remove <id>|auth <id> <state>|clear-error <id>|reset-state <id>]',
    remote: '/mcp [doctor|probe [id]|get <id>|import-json <path>|import-project [path]|add-http <id> <url>|add-sse <id> <url>|add-stdio <id> <command...>|enable <id>|disable <id>|remove <id>|auth <id> <state>|clear-error <id>|reset-state <id>]',
    autocomplete: true,
    quickValue: '/mcp',
    desc: { zh: 'Show or manage MCP servers', en: 'Show or manage MCP servers' },
  },
  {
    id: 'skills',
    group: 'project',
    cli: 'skills',
    slash: '/skills',
    remote: '/skills',
    autocomplete: true,
    quickValue: '/skills',
    desc: { zh: '浏览、推荐和查看内置技能', en: 'Browse, recommend, and inspect built-in skills' },
  },
  {
    id: 'odin',
    group: 'project',
    cli: 'odin [skills|events|search <query>]',
    slash: '/odin [skills|events|search <query>]',
    autocomplete: true,
    quickValue: '/odin',
    desc: { zh: 'Inspect the native Odin skill evolution layer', en: 'Inspect the native Odin skill evolution layer' },
  },
  {
    id: 'plugins',
    group: 'project',
    cli: 'plugins [run <plugin-id> <command...>]',
    slash: '/plugins',
    remote: '/plugins',
    autocomplete: true,
    quickValue: '/plugins',
    desc: { zh: 'Inspect or run local plugins', en: 'Inspect or run local plugins' },
  },
  {
    id: 'tools',
    group: 'project',
    slash: '/tools',
    remote: '/tools',
    autocomplete: true,
    desc: { zh: 'Show the tool manifest', en: 'Show the tool manifest' },
  },
  {
    id: 'agents',
    group: 'project',
    slash: '/agents',
    autocomplete: true,
    desc: { zh: 'Inspect agent roles', en: 'Inspect agent roles' },
  },
  {
    id: 'doctor',
    group: 'permissions',
    cli: 'doctor [--test-providers]',
    slash: '/doctor [test|--test-providers]',
    remote: '/doctor [test|--test-providers]',
    autocomplete: true,
    quickValue: '/doctor',
    desc: { zh: 'Inspect environment and configuration state', en: 'Inspect environment and configuration state' },
  },
  {
    id: 'evidence',
    group: 'permissions',
    cli: 'evidence [sessionId]',
    slash: '/evidence',
    remote: '/evidence',
    autocomplete: true,
    desc: { zh: 'Show the evidence graph', en: 'Show the evidence graph' },
  },
  {
    id: 'conflicts',
    group: 'permissions',
    cli: 'conflicts [sessionId]',
    slash: '/conflicts',
    remote: '/conflicts',
    autocomplete: true,
    desc: { zh: 'Show evidence conflicts', en: 'Show evidence conflicts' },
  },
  {
    id: 'verify',
    group: 'permissions',
    cli: 'verify [sessionId]',
    slash: '/verify',
    remote: '/verify',
    autocomplete: true,
    desc: { zh: 'Generate the minimal verification plan', en: 'Generate the minimal verification plan' },
  },
  {
    id: 'mode',
    group: 'permissions',
    slash: '/mode <prompt|read-only|accept-edits|accept-all>',
    remote: '/mode <prompt|read-only|accept-edits|accept-all>',
    autocomplete: true,
    desc: { zh: 'Switch the permission mode', en: 'Switch the permission mode' },
  },
  {
    id: 'whosyourdaddy',
    group: 'permissions',
    cli: 'whosyourdaddy',
    slash: '/whosyourdaddy',
    remote: '/whosyourdaddy',
    autocomplete: true,
    quickValue: '/whosyourdaddy',
    desc: { zh: 'Enable the autonomous no-confirmation mode', en: 'Enable the autonomous no-confirmation mode' },
  },
  {
    id: 'clear',
    group: 'core',
    slash: '/clear',
    autocomplete: true,
    desc: { zh: 'Clear the screen', en: 'Clear the screen' },
  },
  {
    id: 'exit',
    group: 'core',
    slash: '/exit',
    autocomplete: true,
    quickValue: '/exit',
    desc: { zh: 'Exit the current session', en: 'Exit the current session' },
  },
];

export function getCommandUsage(
  descriptor: CommandDescriptor,
  surface: 'cli' | 'slash' | 'remote',
): string | undefined {
  return surface === 'cli'
    ? descriptor.cli
    : surface === 'slash'
      ? descriptor.slash
      : descriptor.remote;
}

export function getCommandDescriptors(options?: {
  surface?: 'cli' | 'slash' | 'remote';
  autocompleteOnly?: boolean;
  quickOnly?: boolean;
  query?: string;
}): CommandDescriptor[] {
  const surface = options?.surface;
  const query = options?.query?.trim().toLowerCase();

  return COMMAND_DESCRIPTORS.filter((descriptor) => {
    if (surface && !getCommandUsage(descriptor, surface)) {
      return false;
    }
    if (options?.autocompleteOnly && !descriptor.autocomplete) {
      return false;
    }
    if (options?.quickOnly && !descriptor.quickValue) {
      return false;
    }
    if (!query) {
      return true;
    }

    const haystack = [
      descriptor.id,
      descriptor.cli,
      descriptor.slash,
      descriptor.remote,
      descriptor.quickValue,
      descriptor.desc.zh,
      descriptor.desc.en,
    ]
      .filter((value): value is string => Boolean(value))
      .join('\n')
      .toLowerCase();

    return haystack.includes(query);
  });
}
