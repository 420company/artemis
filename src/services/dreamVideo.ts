import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  buildDreamPaths,
  findLatestDreamBody,
  loadDreamIndex,
  readDreamBody,
  updateDreamEntry,
  type DreamEntry,
} from './dreamStore.js'
import { createVisualProvider } from '../tools/visual/providers/interface.js'
import { buildDirectedVideoPrompt } from '../tools/visual/videoDirector.js'
import { normalizeVideoDurationForProvider } from '../tools/visual/videoParams.js'
import {
  analyzeNarrative,
  buildSagaConstitution,
  narrativeKeywordFallback,
} from '../tools/visual/sagaNarrative.js'
import {
  buildVisualSetupRequiredMessage,
  describeVisualProvider,
  resolveConfiguredVisualProvider,
} from '../utils/visualGenerationConfig.js'
import type { UiLocale } from '../cli/locale.js'
import { DEFAULT_UI_LOCALE, pickLocale } from '../cli/locale.js'

export interface DreamVideoCapability {
  ok: boolean
  provider?: string
  model?: string
  source?: string
  reason?: string
}

export interface GenerateDreamVideoOptions {
  cwd: string
  /** Defaults to latest indexed dream. */
  id?: string
  duration?: number
  ratio?: string
  generateAudio?: boolean
  watermark?: boolean
  /** Status callback for CLI HUD ticks. */
  onStatus?: (text: string) => void
  locale?: UiLocale
}

export interface GenerateDreamVideoResult {
  ok: boolean
  reason?: string
  entry?: DreamEntry
  videoPath?: string
  provider?: string
  model?: string
  directedPrompt?: string
}

const DEFAULT_DREAM_VIDEO_DURATION = 5
const DEFAULT_DREAM_VIDEO_RATIO = '16:9'

export async function checkDreamVideoCapability(cwd: string): Promise<DreamVideoCapability> {
  const configured = await resolveConfiguredVisualProvider(cwd, 'video')
  if (!configured) {
    return { ok: false, reason: buildVisualSetupRequiredMessage('video') }
  }

  try {
    const provider = await createVisualProvider(configured.config, 'video')
    if (!provider.supportsVideos || !provider.generateVideo) {
      return {
        ok: false,
        provider: configured.provider,
        model: configured.model,
        source: configured.source,
        reason: `configured visual provider does not support video generation: ${configured.provider}`,
      }
    }
    return {
      ok: true,
      provider: configured.provider,
      model: configured.model,
      source: configured.source,
    }
  } catch (err) {
    return {
      ok: false,
      provider: configured.provider,
      model: configured.model,
      source: configured.source,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function generateDreamVideo(options: GenerateDreamVideoOptions): Promise<GenerateDreamVideoResult> {
  const locale = options.locale ?? DEFAULT_UI_LOCALE
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en })
  const selected = await selectDream(options.id)
  if (!selected) {
    return { ok: false, reason: options.id ? `${t('找不到梦境', 'Dream not found')}: ${options.id}` : t('找不到梦境', 'No dream found') }
  }

  options.onStatus?.(t('🌙 检查梦境视频能力…', '🌙 Checking dream video capability…'))
  const configured = await resolveConfiguredVisualProvider(options.cwd, 'video')
  if (!configured) {
    return { ok: false, entry: selected.entry, reason: buildVisualSetupRequiredMessage('video') }
  }

  const provider = await createVisualProvider(configured.config, 'video')
  if (!provider.supportsVideos || !provider.generateVideo) {
    return {
      ok: false,
      entry: selected.entry,
      provider: configured.provider,
      model: configured.model,
      reason: `${t('已配置的视觉 provider 不支持视频生成', 'configured visual provider does not support video generation')}: ${configured.provider}`,
    }
  }

  const videoConfig = configured.config.video
  const model = videoConfig.model || configured.model
  const duration = normalizeVideoDurationForProvider(
    options.duration ?? DEFAULT_DREAM_VIDEO_DURATION,
    videoConfig.provider,
    model,
  )
  const ratio = options.ratio ?? DEFAULT_DREAM_VIDEO_RATIO
  options.onStatus?.(t('🌙 分析梦境日记的主角 / “上帝”…', '🌙 Analyzing the dream journal protagonist / “god”…'))
  const narrative = await analyzeNarrative({
    cwd: options.cwd,
    userText: buildDreamVideoAnalysisText(selected.entry, selected.body),
  }) ?? narrativeKeywordFallback({
    userText: selected.body,
    hasFaceLikelyInImages: false,
  })
  const prompt = buildDreamVideoSourcePrompt(selected.entry, selected.body, narrative)
  const directed = buildDirectedVideoPrompt({
    prompt,
    provider: videoConfig.provider,
    model,
    duration,
    ratio,
    referenceImageCount: 0,
  })

  options.onStatus?.(`${t('🌙 生成梦境视频', '🌙 Generating dream video')}: ${describeVisualProvider(configured.config, 'video')}…`)
  const result = await provider.generateVideo({
    prompt: directed.directedPrompt,
    model,
    duration,
    ratio,
    generateAudio: options.generateAudio ?? false,
    watermark: options.watermark ?? videoConfig.defaultParams.watermark,
  })

  if (!result.success || !result.assetPath) {
    return {
      ok: false,
      entry: selected.entry,
      provider: configured.provider,
      model,
      reason: result.error ?? t('视频生成没有返回产物', 'video generation returned no asset'),
      directedPrompt: directed.directedPrompt,
    }
  }

  const { videoPath } = buildDreamPaths(selected.entry.id)
  await writeFile(videoPath, await readGeneratedAsset(result.assetPath, options.cwd))
  const updated = await updateDreamEntry(selected.entry.id, { videoPath })

  return {
    ok: true,
    entry: updated ?? { ...selected.entry, videoPath },
    videoPath,
    provider: configured.provider,
    model,
    directedPrompt: directed.directedPrompt,
  }
}

async function readGeneratedAsset(assetPath: string, cwd: string): Promise<Buffer> {
  const dataUrl = parseDataUrl(assetPath)
  if (dataUrl) return dataUrl

  if (/^https?:\/\//i.test(assetPath)) {
    const response = await fetch(assetPath)
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }

  return readFile(path.isAbsolute(assetPath) ? assetPath : path.resolve(cwd, assetPath))
}

function parseDataUrl(dataUrl: string): Buffer | null {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
  if (!match) return null
  const payload = match[3] ?? ''
  return match[2]
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8')
}

async function selectDream(id?: string): Promise<{ entry: DreamEntry; body: string } | null> {
  if (!id) return findLatestDreamBody()

  const entry = (await loadDreamIndex()).find(item => item.id === id)
  if (!entry) return null
  const body = await readDreamBody(id)
  if (!body) return null
  return { entry, body }
}

function buildDreamVideoAnalysisText(entry: DreamEntry, body: string): string {
  return [
    `Dream id: ${entry.id}`,
    'Analyze this Artemis dream journal before video generation. Identify the central “god” / protagonist: it may be a human, animal, creature, object, place, weather system, abstract symbol, or recurring motif. Extract world-model parameters for a coherent dream video.',
    cleanDreamBody(body, 1600),
  ].join('\n')
}

function cleanDreamBody(body: string, maxChars: number): string {
  return body
    .replace(/^<!--[^]*?-->\s*/m, '')
    .replace(/### (?:学到了什么|What I learned)[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
}

function buildDreamVideoSourcePrompt(entry: DreamEntry, body: string, narrative: Awaited<ReturnType<typeof analyzeNarrative>>): string {
  const compactBody = body
    .replace(/^<!--[^]*?-->\s*/m, '')
    .replace(/### (?:学到了什么|What I learned)[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200)
  const resolvedNarrative = narrative ?? narrativeKeywordFallback({ userText: compactBody, hasFaceLikelyInImages: false })
  const protagonist = resolvedNarrative.protagonist
  const nonHumanPerspective = protagonist.type !== 'character'
    ? [
        'Non-human protagonist rule: the camera and story perspective must orbit the identified god directly. If the god is an object, creature, place, atmosphere, or symbol, do NOT force a generic human narrator. Use object-level / creature-level / environment-level cinematography: macro tracking, subjective motion, surrounding reactions, symbolic point-of-view, and recurring visual rhymes that make the non-human god feel intentional and alive.',
      ]
    : []

  return [
    `Dream id: ${entry.id}`,
    'Create a poetic cinematic video from this Artemis dream. FIRST treat the dream journal as source material, then obey the extracted protagonist / “god” model below.',
    buildSagaConstitution(resolvedNarrative),
    `[Dream Video Narrative Entity Map]\n${JSON.stringify(resolvedNarrative, null, 2)}`,
    ...nonHumanPerspective,
    compactBody,
    'Visual priorities: preserve the dream symbols, restrained motion, clear focal point, soft cinematic lighting, coherent physical movement, no readable text, no logos, no UI. Every shot must keep orbiting the identified god/protagonist, not a random new subject.',
  ].join(' ')
}
