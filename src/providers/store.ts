import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { resolveDataRootDir } from '../utils/fs.js';
import { normalizeProviderProtocol } from './factory.js';
import type {
  ArtemisSetupConfig,
  AuxiliaryModelRoute,
  AuxiliaryModelTask,
  CustomProviderConfig,
  ProviderProfile,
  ProviderStoreData,
  VisualModelConfig,
} from './types.js';
import { ensureDir, pathExists } from '../utils/fs.js';
import { detectModelContextLength } from './modelContext.js';

function getDefaultSetupConfig(): ArtemisSetupConfig {
  return {
    agent: {
      maxIterations: 90,
      toolProgress: 'all',
      compression: {
        enabled: true,
      },
      sessionReset: {
        mode: 'both',
        idleMinutes: 1440,
        dailyHour: 4,
      },
    },
    terminal: {
      backend: 'local',
    },
    voice: {
      stt: {
        enabled: true,
        provider: 'local',
        engine: 'auto',
        localModel: 'base',
        language: '',
      },
      tts: {
        provider: 'edge',
        voice: 'en-US-AriaNeural',
      },
      voice: {
        recordKey: 'ctrl+b',
        maxRecordingSeconds: 120,
        autoTts: false,
        beepEnabled: true,
        silenceThreshold: 200,
        silenceDuration: 3,
      },
    },
    tools: {
      enabled: {
        web: true,
        browser: true,
        terminal: true,
        file: true,
        code_execution: true,
        vision: true,
        image_gen: true,
        moa: false,
        tts: true,
        stt: true,
        skills: true,
        todo: true,
        memory: true,
        session_search: true,
        clarify: true,
        delegation: true,
        cronjob: true,
        messaging: true,
        rl: false,
        homeassistant: false,
      },
      providers: {
        browser: 'local',
        tts: 'edge',
        stt: 'local',
      },
    },
    providerRotation: {},
    migrations: {
      imageGenDefaultEnabled: true,
    },
  };
}

function mergeSetupConfigWithDefaults(rawSetup: Partial<ArtemisSetupConfig>): ArtemisSetupConfig {
  const defaults = getDefaultSetupConfig();
  const merged: ArtemisSetupConfig = {
    agent: {
      ...defaults.agent,
      ...(rawSetup.agent ?? {}),
      compression: {
        ...defaults.agent.compression,
        ...(rawSetup.agent?.compression ?? {}),
      },
      sessionReset: {
        ...defaults.agent.sessionReset,
        ...(rawSetup.agent?.sessionReset ?? {}),
      },
    },
    terminal: {
      ...defaults.terminal,
      ...(rawSetup.terminal ?? {}),
      ssh: {
        ...(rawSetup.terminal?.ssh ?? {}),
      },
      resources: {
        ...(rawSetup.terminal?.resources ?? {}),
      },
    },
    voice: {
      stt: {
        ...defaults.voice.stt,
        ...(rawSetup.voice?.stt ?? {}),
      },
      tts: {
        ...defaults.voice.tts,
        ...(rawSetup.voice?.tts ?? {}),
      },
      voice: {
        ...defaults.voice.voice,
        ...(rawSetup.voice?.voice ?? {}),
      },
    },
    tools: {
      enabled: {
        ...defaults.tools.enabled,
        ...(rawSetup.tools?.enabled ?? {}),
      },
      providers: {
        ...defaults.tools.providers,
        ...(rawSetup.tools?.providers ?? {}),
      },
    },
    providerRotation: rawSetup.providerRotation ?? {},
    migrations: {
      ...(rawSetup.migrations ?? {}),
    },
  };

  // Artemis 0.1.71 originally shipped Full Setup with image generation disabled,
  // which hid generate_image/generate_video from Windows npm installs. Upgrade
  // that legacy default once so existing users get the corrected tool surface;
  // subsequent manual disables in newer builds are preserved by the migration flag.
  if (merged.migrations?.imageGenDefaultEnabled !== true) {
    merged.tools.enabled.image_gen = true;
    merged.migrations = {
      ...(merged.migrations ?? {}),
      imageGenDefaultEnabled: true,
    };
  }

  return merged;
}

function getEmptyStore(): ProviderStoreData {
  return {
    profiles: [],
    customProviders: [],
    auxiliaryModels: {},
    setup: getDefaultSetupConfig(),
    visualProfile: {
      enabled: false,
      image: {
        provider: 'byteplus',
        apiKey: '',
        baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
        model: 'seedream-5-0-260128',
        defaultParams: {
          size: '2K',
          quality: 'standard',
          style: 'realistic',
          watermark: false,
        },
      },
      video: {
        enabled: false,
        provider: 'byteplus',
        apiKey: '',
        baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
        model: 'seedance-1-5-pro-251215',
        defaultParams: {
          duration: '10s',
          resolution: '1080p',
          quality: 'standard',
          style: 'realistic',
          format: 'mp4',
          framerate: '30fps',
          watermark: false,
        },
      },
    },
  };
}

function findCompleteJsonValueEnd(raw: string): number | undefined {
  const start = raw.search(/\S/);
  if (start < 0) return undefined;

  const first = raw[start];
  if (first !== '{' && first !== '[') return undefined;

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return index + 1;
      if (depth < 0) return undefined;
    }
  }

  return undefined;
}

function ensureProviderStoreObject(value: unknown, filePath: string): Partial<ProviderStoreData> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Partial<ProviderStoreData>;
  }
  throw new Error(`Invalid provider store JSON at ${filePath}: expected a JSON object`);
}

function parseProviderStoreJson(raw: string, filePath: string): {
  data: Partial<ProviderStoreData>;
  repairedTrailingJunk: boolean;
} {
  try {
    return {
      data: ensureProviderStoreObject(JSON.parse(raw), filePath),
      repairedTrailingJunk: false,
    };
  } catch (error) {
    const end = findCompleteJsonValueEnd(raw);
    const trailing = end === undefined ? '' : raw.slice(end);

    if (end !== undefined && trailing.trim().length > 0) {
      try {
        return {
          data: ensureProviderStoreObject(JSON.parse(raw.slice(0, end)), filePath),
          repairedTrailingJunk: true,
        };
      } catch {
        // Fall through to the original parse error below.
      }
    }

    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid provider store JSON at ${filePath}: ${detail}`);
  }
}

export class ProviderStore {
  private readonly rootDir: string;
  private readonly filePath: string;

  constructor(cwd: string) {
    this.rootDir = resolveDataRootDir(cwd);
    this.filePath = path.join(this.rootDir, 'providers.json');
  }

  async ensure(): Promise<void> {
    await ensureDir(this.rootDir);
  }

  async load(): Promise<ProviderStoreData> {
    await this.ensure();

    if (!(await pathExists(this.filePath))) {
      return getEmptyStore();
    }

    const raw = await readFile(this.filePath, 'utf8');
    const loaded = parseProviderStoreJson(raw, this.filePath);
    const parsed = loaded.data;

    const empty = getEmptyStore();
    const customProviders = Array.isArray(parsed.customProviders)
      ? parsed.customProviders.filter((entry): entry is CustomProviderConfig =>
          typeof entry?.id === 'string' &&
          typeof entry?.label === 'string' &&
          typeof entry?.baseUrl === 'string' &&
          typeof entry?.model === 'string'
        )
      : [];
    const auxiliaryModels =
      typeof parsed.auxiliaryModels === 'object' && parsed.auxiliaryModels !== null
        ? parsed.auxiliaryModels as Partial<Record<AuxiliaryModelTask, AuxiliaryModelRoute>>
        : {};
    const rawSetup = typeof parsed.setup === 'object' && parsed.setup !== null
      ? parsed.setup as Partial<ArtemisSetupConfig>
      : {};
    const setup = mergeSetupConfigWithDefaults(rawSetup);

    const data: ProviderStoreData = {
      profiles: Array.isArray(parsed.profiles)
        ? parsed.profiles
            .filter((entry): entry is ProviderProfile => typeof entry?.id === 'string')
            .map((entry) => ({
              ...entry,
              protocol: normalizeProviderProtocol(entry.protocol),
            }))
        : [],
      defaultMainProfileId:
        typeof parsed.defaultMainProfileId === 'string'
          ? parsed.defaultMainProfileId
          : undefined,
      specialistProfileId:
        typeof parsed.specialistProfileId === 'string'
          ? parsed.specialistProfileId
          : undefined,
      memoryProfile: parsed.memoryProfile,
      customProviders,
      auxiliaryModels,
      setup,
      visualProfile: parsed.visualProfile || empty.visualProfile,
    };
    if (loaded.repairedTrailingJunk) {
      await this.save(data);
    }
    return data;
  }

  async save(data: ProviderStoreData): Promise<void> {
    await this.ensure();
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  async upsertProfile(profile: ProviderProfile): Promise<ProviderStoreData> {
    const data = await this.load();
    const existingIndex = data.profiles.findIndex(
      (entry) => entry.id === profile.id,
    );

    if (existingIndex >= 0) {
      data.profiles[existingIndex] = profile;
    } else {
      data.profiles.push(profile);
    }

    await this.save(data);
    return data;
  }

  async refreshProfileContextLength(id: string): Promise<ProviderProfile | undefined> {
    const data = await this.load();
    const index = data.profiles.findIndex((entry) => entry.id === id);
    if (index < 0) return undefined;

    const profile = data.profiles[index]!;
    const detected = await detectModelContextLength(profile);
    if (!detected.contextLength || detected.source === 'unknown') {
      return profile;
    }

    const refreshed: ProviderProfile = {
      ...profile,
      contextLength: detected.contextLength,
      contextLengthSource: detected.source,
      contextLengthCheckedAt: detected.checkedAt,
    };
    data.profiles[index] = refreshed;

    if (data.customProviders?.length) {
      data.customProviders = data.customProviders.map((provider) => {
        if (provider.baseUrl !== refreshed.baseUrl || provider.model !== refreshed.model) return provider;
        return {
          ...provider,
          contextLength: refreshed.contextLength,
          contextLengthSource: refreshed.contextLengthSource,
          contextLengthCheckedAt: refreshed.contextLengthCheckedAt,
        };
      });
    }

    await this.save(data);
    return refreshed;
  }

  async refreshContextLengths(): Promise<ProviderStoreData> {
    const data = await this.load();
    let changed = false;
    const refreshedByKey = new Map<string, ProviderProfile>();

    const refreshProfile = async (profile: ProviderProfile): Promise<ProviderProfile> => {
      const detected = await detectModelContextLength(profile);
      if (!detected.contextLength || detected.source === 'unknown') return profile;
      const refreshed: ProviderProfile = {
        ...profile,
        contextLength: detected.contextLength,
        contextLengthSource: detected.source,
        contextLengthCheckedAt: detected.checkedAt,
      };
      refreshedByKey.set(`${refreshed.baseUrl}\n${refreshed.model}`, refreshed);
      changed = true;
      return refreshed;
    };

    data.profiles = await Promise.all(data.profiles.map(refreshProfile));

    if (data.customProviders?.length) {
      data.customProviders = data.customProviders.map((provider) => {
        const matched = refreshedByKey.get(`${provider.baseUrl}\n${provider.model}`);
        if (!matched) return provider;
        changed = true;
        return {
          ...provider,
          contextLength: matched.contextLength,
          contextLengthSource: matched.contextLengthSource,
          contextLengthCheckedAt: matched.contextLengthCheckedAt,
        };
      });
    }

    if (changed) {
      await this.save(data);
    }
    return data;
  }

  async setSpecialistProfile(id: string): Promise<ProviderStoreData> {
    const data = await this.load();
    data.specialistProfileId = id;
    await this.save(data);
    return data;
  }

  async setDefaultMainProfile(id: string): Promise<ProviderStoreData> {
    const data = await this.load();
    data.defaultMainProfileId = id;
    await this.save(data);
    return data;
  }

  async setVisualProfile(config: VisualModelConfig): Promise<ProviderStoreData> {
    const data = await this.load();
    data.visualProfile = {
      ...data.visualProfile,
      ...config,
    };
    await this.save(data);
    return data;
  }

  async updateSetupConfig(
    updater: (setup: ArtemisSetupConfig, data: ProviderStoreData) => ArtemisSetupConfig,
  ): Promise<ProviderStoreData> {
    const data = await this.load();
    data.setup = updater(data.setup ?? getDefaultSetupConfig(), data);
    await this.save(data);
    return data;
  }

  async setAuxiliaryModelRoute(
    task: AuxiliaryModelTask,
    route: AuxiliaryModelRoute,
  ): Promise<ProviderStoreData> {
    const data = await this.load();
    data.auxiliaryModels = {
      ...(data.auxiliaryModels ?? {}),
      [task]: route,
    };
    await this.save(data);
    return data;
  }

  async upsertCustomProvider(provider: CustomProviderConfig): Promise<ProviderStoreData> {
    const data = await this.load();
    const customProviders = data.customProviders ?? [];
    const index = customProviders.findIndex((entry) => entry.id === provider.id);
    if (index >= 0) {
      customProviders[index] = provider;
    } else {
      customProviders.push(provider);
    }
    data.customProviders = customProviders;
    await this.save(data);
    return data;
  }

  getVisualProfile(data: ProviderStoreData): VisualModelConfig {
    return data.visualProfile ?? getEmptyStore().visualProfile!;
  }

  getProfile(
    data: ProviderStoreData,
    id: string | undefined,
  ): ProviderProfile | undefined {
    if (!id) {
      return undefined;
    }

    return data.profiles.find((entry) => entry.id === id);
  }

  getDefaultMainProfile(
    data: ProviderStoreData,
  ): ProviderProfile | undefined {
    if (data.defaultMainProfileId) {
      return this.getProfile(data, data.defaultMainProfileId);
    }

    if (!data.specialistProfileId && data.profiles.length === 1) {
      return data.profiles[0];
    }

    return data.profiles.find(
      (entry) => entry.id !== data.specialistProfileId,
    );
  }
}
