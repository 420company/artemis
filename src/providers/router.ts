import type { AgentRole } from '../core/types.js';
import { CliSettingsStore } from '../cli/settings.js';
import { pickLocale, type UiLocale } from '../cli/locale.js';
import {
  createInteractivePromptIO,
  choosePromptBoolean,
} from '../cli/prompt.js';
import {
  promptForVerifiedProviderProfile,
} from './onboarding.js';
import { ProviderStore } from './store.js';
import {
  createTrackedProviderFromConfig,
  formatProviderUsageTelemetry,
} from './telemetry.js';
import type {
  ChatProvider,
  PromptIO,
  ProviderRequestOptions,
  ProviderResponse,
  ProviderProfile,
  ProviderTarget,
} from './types.js';
import type { SessionMessage } from '../core/types.js';

const SPECIALIST_ROLES = new Set<AgentRole>([
  'planner',
  'researcher',
  'reviewer',
  'architect',
  'designer',
  'qa',
]);

export type ProviderRouter = {
  ensureSpecialistProvider(roles: AgentRole[]): Promise<void>;
  resolveProvider(target: ProviderTarget): ChatProvider;
};

type CreateProviderRouterOptions = {
  cwd: string;
  mainProvider: ChatProvider;
  promptIO?: PromptIO;
  onInfo?: (message: string) => void;
  createProviderFromProfile?: (profile: ProviderProfile) => ChatProvider;
};

type RoutedProviderCandidate = {
  id: string;
  label: string;
  kind: 'main' | 'specialist';
  provider: ChatProvider;
};

function getInteractiveState(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function createConsolePromptIO(): PromptIO {
  if (!getInteractiveState()) {
    return {
      available: false,
      ask: async () => '',
      write: () => {},
      choose: async ({ choices, initialIndex = 0 }) =>
        choices[Math.min(Math.max(initialIndex, 0), choices.length - 1)].value,
    };
  }
  return createInteractivePromptIO();
}

function isSpecialistRole(role: AgentRole): boolean {
  return SPECIALIST_ROLES.has(role);
}

function shouldUseSpecialistProvider(target: ProviderTarget): boolean {
  return target !== 'main' && isSpecialistRole(target);
}

function getUniqueSpecialistRoles(roles: AgentRole[]): AgentRole[] {
  return [...new Set(roles.filter(isSpecialistRole))];
}

function getProviderPriority(
  target: ProviderTarget,
  candidate: RoutedProviderCandidate,
): number {
  if (target === 'main') {
    return candidate.kind === 'main' ? 100 : 55;
  }

  if (target === 'builder' || target === 'brainstormer' || target === 'arbiter') {
    return candidate.kind === 'main' ? 96 : 60;
  }

  if (shouldUseSpecialistProvider(target)) {
    return candidate.kind === 'specialist' ? 98 : 82;
  }

  // 
  return candidate.kind === 'main' ? 92 : 58;
}

// 
function isAnalyticalTask(task: string): boolean {
  const analyticalKeywords = [
    '分析', '研究', '检查', '评估', '总结', '理解', '探索',
    'analyze', 'research', 'examine', 'evaluate', 'summarize', 'understand', 'explore'
  ];
  return analyticalKeywords.some(keyword => 
    task.toLowerCase().includes(keyword.toLowerCase())
  );
}

// 
function isExecutionTask(task: string): boolean {
  const executionKeywords = [
    '实现', '开发', '编写', '修改', '创建', '部署', '运行',
    'implement', 'develop', 'write', 'modify', 'create', 'deploy', 'run'
  ];
  return executionKeywords.some(keyword => 
    task.toLowerCase().includes(keyword.toLowerCase())
  );
}

// 
export function shouldUseRavenForTask(task: string): boolean {
  return isAnalyticalTask(task) && !isExecutionTask(task);
}

function rankCandidates(
  target: ProviderTarget,
  candidates: RoutedProviderCandidate[],
): RoutedProviderCandidate[] {
  return [...candidates].sort((left, right) => {
    const scoreDelta =
      getProviderPriority(target, right) - getProviderPriority(target, left);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    return left.kind.localeCompare(right.kind);
  });
}

export function formatProviderRoutingPolicy(labels?: {
  mainLabel?: string;
  specialistLabel?: string;
}, locale: UiLocale = 'en'): string {
  const main = labels?.mainLabel ?? 'main';
  const specialist = labels?.specialistLabel ?? 'specialist';

  return [
    pickLocale(locale, {
      zh: '路由策略',
      en: 'Routing policy',
    }),
    pickLocale(locale, {
      zh: `- 执行路径（main、builder、design synthesis、niko synthesis、arbiter）-> 优先 ${main}，失败时回退到 ${specialist}`,
      en: `- execution path (main, builder, design synthesis, niko synthesis, arbiter) -> ${main} first, ${specialist} fallback`,
    }),
    pickLocale(locale, {
      zh: `- specialist 路径（planner、researcher、reviewer、designer、architect、qa）-> 配置后优先 ${specialist}，否则回退到 ${main}`,
      en: `- specialist path (planner, researcher, reviewer, designer, architect, qa) -> ${specialist} first when configured, ${main} fallback`,
    }),
    pickLocale(locale, {
      zh: '- 如果首选 provider 出错，Artemis 会在同一轮重试下一优先级 provider',
      en: '- if the preferred provider errors, Artemis retries the same turn on the next-ranked provider',
    }),
  ].join('\n');
}

async function promptForSpecialistProfile(
  promptIO: PromptIO,
  store: ProviderStore,
  locale: UiLocale = 'en',
): Promise<ProviderProfile | undefined> {
  const data = await store.load();
  return promptForVerifiedProviderProfile(promptIO, data, {
    heading: pickLocale(locale, {
      zh: 'Specialist API 设置',
      en: 'Specialist API setup',
    }),
    defaultAlias: pickLocale(locale, {
      zh: 'Athena specialist',
      en: 'Athena specialist',
    }),
    defaultIdPrefix: 'specialist',
    cancellationLabel: pickLocale(locale, {
      zh: '取消设置',
      en: 'cancel setup',
    }),
  }, locale);
}

export async function createProviderRouter(
  options: CreateProviderRouterOptions,
): Promise<ProviderRouter> {
  const store = new ProviderStore(options.cwd);
  const data = await store.load();
  const uiLocale = (await new CliSettingsStore(options.cwd).load()).uiLocale;
  const mainProfile = store.getDefaultMainProfile(data);
  let specialistProfile = store.getProfile(data, data.specialistProfileId);
  
  const createProviderFromProfile =
    options.createProviderFromProfile ??
    ((profile: ProviderProfile) =>
      createTrackedProviderFromConfig(profile, {
        cwd: options.cwd,
        profileId: profile.id,
        profileLabel: profile.label ?? profile.id,
      }));
  let specialistProvider = specialistProfile
    ? createProviderFromProfile(specialistProfile)
    : undefined;
  let promptHandled = false;
  const mainLabel = mainProfile?.label ?? mainProfile?.id ?? 'main';

  if (specialistProfile) {
    options.onInfo?.(
      `[providers] loaded specialist profile ${specialistProfile.id} (${specialistProfile.model})`,
    );
  }

  return {
    async ensureSpecialistProvider(roles: AgentRole[]): Promise<void> {
      const specialistRoles = getUniqueSpecialistRoles(roles);

      if (
        specialistRoles.length === 0 ||
        specialistProvider ||
        promptHandled
      ) {
        return;
      }

      promptHandled = true;

      if (!options.promptIO?.available) {
        options.onInfo?.(
          pickLocale(uiLocale, {
            zh: '[providers] 当前没有交互终端可用；specialist 角色将继续使用主执行模型',
            en: '[providers] no interactive prompt available; specialists will stay on the main provider',
          }),
        );
        return;
      }

      const roleLabel = specialistRoles.join(', ');
      const plural = specialistRoles.length > 1 ? 's' : '';
      const shouldConfigure = await choosePromptBoolean(options.promptIO, {
        title: pickLocale(uiLocale, {
          zh: `这个工作流即将启动 specialist agent${plural}（${roleLabel}）。要为这些 agent 单独接一套更便宜的外部 API 吗？`,
          en: `This workflow is about to launch specialist agent${plural} (${roleLabel}). Use a cheaper external API for these agents?`,
        }),
        yesLabel: pickLocale(uiLocale, {
          zh: '是，立即配置',
          en: 'Yes, configure now',
        }),
        noLabel: pickLocale(uiLocale, {
          zh: '否，继续使用执行模型',
          en: 'No, keep using the execution model',
        }),
        yesDescription: pickLocale(uiLocale, {
          zh: '给 planner、researcher、reviewer 等 specialist 单独接一套 API。',
          en: 'Attach a separate API for planner, researcher, reviewer, and similar specialist roles.',
        }),
        noDescription: pickLocale(uiLocale, {
          zh: 'specialist 角色继续复用当前执行 API。',
          en: 'Keep specialist roles on the current execution API.',
        }),
        defaultValue: false,
      });

      if (!shouldConfigure) {
        options.onInfo?.(
          pickLocale(uiLocale, {
            zh: '[providers] specialist 角色将继续使用主执行模型',
            en: '[providers] specialists will stay on the main provider',
          }),
        );
        return;
      }

      const profile = await promptForSpecialistProfile(
        options.promptIO,
        store,
        uiLocale,
      );
      if (!profile) {
        options.onInfo?.(
          pickLocale(uiLocale, {
            zh: '[providers] specialist provider 设置已取消',
            en: '[providers] specialist provider setup cancelled',
          }),
        );
        return;
      }

      const nextData = await store.upsertProfile(profile);
      nextData.specialistProfileId = profile.id;
      await store.save(nextData);

      specialistProfile = profile;
      specialistProvider = createProviderFromProfile(profile);
      options.onInfo?.(
        pickLocale(uiLocale, {
          zh: `[providers] specialist 角色已切到 ${profile.id} (${profile.model})`,
          en: `[providers] specialists routed to ${profile.id} (${profile.model})`,
        }),
      );
    },

    resolveProvider(target: ProviderTarget, task?: string): ChatProvider {
      const buildCandidates = (): RoutedProviderCandidate[] => {
        const candidates: RoutedProviderCandidate[] = [
          {
            id: 'main',
            label: mainLabel,
            kind: 'main',
            provider: options.mainProvider,
          },
        ];

        if (specialistProvider && specialistProfile) {
          candidates.push({
            id: specialistProfile.id,
            label: specialistProfile.label ?? specialistProfile.id,
            kind: 'specialist',
            provider: specialistProvider,
          });
        }

        return candidates;
      };

      const rankForTarget = (candidates: RoutedProviderCandidate[]): RoutedProviderCandidate[] => {
        let ranked = rankCandidates(target, candidates);
        if (task) {
          const isRavenTask = shouldUseRavenForTask(task);

          if (isRavenTask && candidates.length > 1) {
            ranked = rankCandidates('planner', candidates);
          } else if (candidates.length > 1 && isExecutionTask(task)) {
            ranked = rankCandidates('builder', candidates);
          }
        }

        return ranked;
      };

      const tryRankedProviders = async (
        run: (candidate: RoutedProviderCandidate) => Promise<ProviderResponse>,
      ): Promise<ProviderResponse> => {
        const ranked = rankForTarget(buildCandidates());
        let lastError: unknown;

        for (let index = 0; index < ranked.length; index += 1) {
          const candidate = ranked[index]!;
          try {
            if (ranked.length > 1) {
              options.onInfo?.(
                `[providers] target=${target} try=${candidate.label} rank=${index + 1}/${ranked.length}`,
              );
            }
            const result = await run(candidate);
            if (ranked.length > 1) {
              const telemetry = formatProviderUsageTelemetry(result.usage, {
                includeProfile: false,
              });
              options.onInfo?.(
                `[providers] target=${target} selected=${candidate.label}${telemetry ? ` ${telemetry}` : ''}`,
              );
            }
            return result;
          } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            options.onInfo?.(
              `[providers] target=${target} provider=${candidate.label} failed: ${message}`,
            );
          }
        }

        if (lastError instanceof Error) {
          throw lastError;
        }

        throw new Error(`No provider available for target=${target}.`);
      };

      return {
        get supportsNativeToolCalls() {
          return buildCandidates().some((candidate) => candidate.provider.supportsNativeToolCalls === true);
        },
        get supportsImages() {
          return buildCandidates().some((candidate) => candidate.provider.supportsImages === true);
        },
        async complete(
          messages: SessionMessage[],
          requestOptions?: ProviderRequestOptions,
        ) {
          return tryRankedProviders((candidate) =>
            candidate.provider.complete(messages, requestOptions),
          );
        },
        async completeStream(
          messages: SessionMessage[],
          onChunk: (delta: string) => void,
          requestOptions?: ProviderRequestOptions,
        ) {
          return tryRankedProviders((candidate) =>
            typeof candidate.provider.completeStream === 'function'
              ? candidate.provider.completeStream(messages, onChunk, requestOptions)
              : candidate.provider.complete(messages, requestOptions),
          );
        },
      };
    },
  };
}
