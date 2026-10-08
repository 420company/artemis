#!/usr/bin/env tsx
/**
 * scripts/runtimeSmoke.ts — runtime integration smoke tests
 *
 * Tests that can run without a real API key (structural/config checks).
 * Run: node --no-warnings node_modules/tsx/dist/cli.mjs scripts/runtimeSmoke.ts
 */

import { DEFAULT_AGENT_MAX_TURNS, MAX_AGENT_MAX_TURNS } from '../src/cli/branding.js'
import { parseArgs } from '../src/cli/parseArgs.js'
import { isCliStopIntent } from '../src/cli/interactive.js'
import {
  CliSettingsStore,
  DEFAULT_GEMINI_DEEP_RESEARCH_AGENT,
} from '../src/cli/settings.js'
import { applyProviderOverrides, getLastPromptTokens, getLeadProvider, resetSession, switchModel, think } from '../src/brain.js'
import { extractVideoPathsFromToolOutput } from '../src/bragi/runtime.js'
import { parseAssistantEnvelopeForSmoke, runAgent as runAgentNow } from '../src/core/agent.js'
import { settleMemoryCuration } from '../src/core/memory.js'
import { createVisionHelper, type VisionHelper } from '../src/core/visionHelper.js'
import { runHeadlessAgent as runHeadlessAgentNow } from '../src/services/headlessAgent.js'

// A finished run starts the memory curator in the background, which reads
// process state (cwd, ARTEMIS_HOME, provider stores) when it runs. Every run
// here waits for it, so no curator outlives its test and touches the next
// test's files.
const runAgent: typeof runAgentNow = async (...args) => {
  try {
    return await runAgentNow(...args)
  } finally {
    await settleMemoryCuration()
  }
}
const runHeadlessAgent: typeof runHeadlessAgentNow = async (...args) => {
  try {
    return await runHeadlessAgentNow(...args)
  } finally {
    await settleMemoryCuration()
  }
}
import { routeTeamRequest } from '../src/core/team.js'
import { getAllowedActionTypesForProfile, validateProfileAction } from '../src/core/agentProfiles.js'
import {
  createContextState,
  isCompactionBoundary,
  manageContext,
  resolveContextBudget,
  summarySectionTitles,
  type SummarizeFn,
} from '../src/core/compaction/index.js'
import { buildSystemPrompt } from '../src/core/systemPrompt.js'
import { fromHeimdallVirtualPath } from '../src/core/heimdall.js'
import { resolveWorkspaceIntent } from '../src/cli/workspaceIntent.js'
import {
  buildProviderNativeFunctionTools,
  mapProviderNativeToolCallToAction,
} from '../src/core/providerNativeTools.js'
import { probeProviderNativeToolCalls } from '../src/providers/health.js'
import {
  GPT_5_6_CONTEXT_LENGTH,
  inferKnownModelContextLength,
  resolveEffectiveModelContextLength,
  resolveProfileContextLength,
} from '../src/providers/modelContext.js'
import { promptForProviderProfile } from '../src/providers/onboarding.js'
import { createProviderRouter } from '../src/providers/router.js'
import { OpenAICompatibleProvider } from '../src/providers/openaiCompatible.js'
import { MessagesCompatibleProvider } from '../src/providers/messagesCompatible.js'
import { ResponsesCompatibleProvider } from '../src/providers/responsesCompatible.js'
import { buildDirectNativeFunctionTools, getDirectToolCount } from '../src/tools/directTools.js'
import {
  detectToolHostEnvironment,
  getToolHostKey,
  parseBooleanEnv,
  resolveBrowserLaunchMode,
  withToolHostEnvironment,
} from '../src/tools/platformSupport.js'
import { buildAmbientToolsHint } from '../src/tools/ambientHint.js'
import {
  getToolDefinition,
  getProviderCallableActionTypes,
  isDirectlyExecutableTool,
  isParallelReadOnlyAction,
  isRuntimeManagedTool,
  validateToolAction,
  renderDetailedToolManifest,
  validateToolAction,
  GENERATE_IMAGE_DESCRIPTION,
} from '../src/tools/registry.js'
import {
  classifyImageGenerationFailure,
  formatImageGenerationFailure,
} from '../src/tools/visual/imageGenerationFailure.js'
import {
  normalizeReferenceImagesArg,
  resolveReferenceImages,
  sniffImageMimeType,
} from '../src/tools/visual/referenceImages.js'
import { ProviderStore } from '../src/providers/store.js'
import { SessionStore } from '../src/storage/sessions.js'
import { searchSessions } from '../src/storage/sessionSearch.js'
import { Session } from '../src/core/session.js'
import { createHudState, estimateContextLimit, renderHud, updateHudState } from '../src/cli/hud.js'
import {
  buildPostCompactRecoveryMessages,
  createLedger,
  createFileStateSnapshot,
  saveFileArtifact,
  saveLedger,
  cleanupLedger,
} from '../src/core/collapse/index.js'
import { modelArkEndpoint, normalizeModelArkMediaBaseUrl, resolveModelArkMediaCredentials } from '../src/tools/vidarMedia.js'
import {
  downloadProviderAsset,
  isNonPublicAddress,
  setAssetDownloadResolverForTests,
  setAssetDownloadTransportForTests,
  type AssetHostResolver,
  type AssetTransport,
} from '../src/tools/visual/safeDownload.js'
import { lookup as dnsLookup } from 'node:dns/promises'
import { sniffAnyImageType, sniffImageType } from '../src/core/imageInput.js'
import { resolveRunCommandTimeoutMs } from '../src/tools/runCommand.js'
import { executeGenerateImage } from '../src/tools/generateImage.js'
import { executeGenerateVideo } from '../src/tools/generateVideo.js'
import {
  resolveGeminiDeepResearchConfig,
  runGeminiDeepResearch,
} from '../src/research/geminiDeepResearch.js'
import { BytePlusProvider } from '../src/tools/visual/providers/byteplusProvider.js'
import { OpenAIProvider } from '../src/tools/visual/providers/openaiProvider.js'
import { getAvailableProviders } from '../src/tools/visual/providers/interface.js'
import {
  BYTEPLUS_SEEDANCE_2_PRO_MODEL,
  getUnsupportedVideoReferences,
  isGeneratedAudioUnsupported,
  resolveVideoModelCapabilities,
  shouldPromoteBytePlusVideoModel,
} from '../src/tools/visual/videoCapabilities.js'
import { handleSeedanceMultimodalWorkflow as handleSeedanceMultimodalWorkflowRaw, hasExistingLocalMediaReference } from '../src/tools/visual/seedanceWorkflow.js'
import { handleSagaLongVideoWorkflow } from '../src/tools/visual/sagaWorkflow.js'
import {
  buildProvidedTurnaroundSafetyDerivativeStory,
  buildSegmentKeyframePrompt,
  buildSuperVisualCharacterTurnaroundPrompt,
  isLikelyProvidedTurnaroundReferenceForTest,
  isSuperVisualModeEligible,
  shouldCompressImageForUploadForTest,
  resolveVisionDescribeRouteForTest,
} from '../src/tools/visual/superVisualMode.js'
import { buildSagaConstitution, runNarrativeCritic } from '../src/tools/visual/sagaNarrative.js'
import { resolveSoundtrackPath } from '../src/tools/visual/sagaRenderer/index.js'
import { buildDirectedVideoPrompt } from '../src/tools/visual/videoDirector.js'
import { normalizeVideoDurationForProvider, normalizeVideoResolution } from '../src/tools/visual/videoParams.js'
import {
  isOverbroadTrustedWorkspaceRoot,
  isPathInsideWorkspace,
  mergeTrustedWorkspaceRoots,
  normalizeTrustedWorkspaceRoots,
  resolveWorkspaceCandidatePath,
  resolveWorkspaceForTargetPath,
} from '../src/utils/workspaceRoots.js'
import { projectDirectToolNames } from '../src/core/directToolProjection.js'
import { buildDreamBridgeText } from '../src/services/dreamComposer.js'
import type { AgentAction, SessionMessage } from '../src/core/types.js'
import { ALL_AGENT_ACTION_TYPES, RUNTIME_MANAGED_AGENT_ACTION_TYPES } from '../src/core/types.js'
import { resolveDataRootDir } from '../src/utils/fs.js'
import type {
  ChatProvider,
  ImageAttachment,
  ProviderNativeToolOutput,
  ProviderResponse,
} from '../src/providers/types.js'
import { getWorkflowDisplayName, isReadOnlyWorkflow, runWorkflowMode } from '../src/core/workflowMode.js'
import {
  applyWorkflowProgressInfo,
  createWorkflowProgressState,
  renderWorkflowProgress,
} from '../src/cli/workflowProgress.js'
import { getPermissionCategoryForActionType, PermissionManager } from '../src/security/permissions.js'
import {
  appendTaskRuntimeCommand,
} from '../src/core/taskRuntime.js'
import { RuntimeDirectoryService } from '../src/services/runtimeDirectory.js'
import {
  getPromptRuntimeCacheStats,
  resetPromptRuntimeCacheForTests,
} from '../src/core/promptCache.js'
import {
  getProjectInstructionFileCacheStats,
  loadProjectInstructionFile,
  resetProjectInstructionFileCacheForTests,
} from '../src/core/instructionFile.js'
import { isPlausibleTelegramBotToken, normalizeTelegramBotToken } from '../src/telegram/client.js'
import { detectVisualGenerationNeed, VISUAL_NOT_CONFIGURED_POLICY } from '../src/utils/visualGenerationConfig.js'
import { normalizeCustomVisualBaseUrlForTest } from '../src/tools/visual/providers/customProvider.js'
import * as http from 'node:http'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import type { PromptIO } from '../src/providers/types.js'

let passed = 0
let failed = 0

const handleSeedanceMultimodalWorkflow: typeof handleSeedanceMultimodalWorkflowRaw = (input) =>
  handleSeedanceMultimodalWorkflowRaw({ locale: 'zh-CN', ...input })

function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  \x1b[32m✔\x1b[0m ${label}`)
    passed++
  } else {
    console.log(`  \x1b[31m✘\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

function eq<T>(a: T, b: T): boolean { return JSON.stringify(a) === JSON.stringify(b) }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function openAIToolCallsRemainPaired(messages: SessionMessage[]): boolean {
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i]!
    if (msg.role !== 'assistant' || !msg.toolCalls?.length) continue
    if (messages[i + 1]?.role !== 'tool') return false
  }
  return true
}

/** Fake summarizer for compaction tests: 8 required sections plus the markers it saw. */
function sectionSummarizer(onPrompt?: (prompt: string) => void, markers: RegExp = /[A-Z][A-Z0-9_]{12,}|src\/[\w./-]+/g): SummarizeFn {
  return async ({ prompt }) => {
    onPrompt?.(prompt)
    const seen = [...new Set(prompt.match(markers) ?? [])].join(', ') || 'none'
    return summarySectionTitles('en').map((title, i) => `## ${i + 1}. ${title}\n${seen}`).join('\n')
  }
}

console.log('\n  runtimeSmoke')
console.log('  ============\n')

const expectedDirectToolCount = getDirectToolCount()
const providerNativeTools = buildProviderNativeFunctionTools()

// Generated-asset downloads normally go through node:http(s) with a guarded
// DNS lookup. Most tests here mock globalThis.fetch, so route downloads
// through fetch and resolve the reserved .test domain to a public
// documentation address. The download-guard tests swap in the real transport.
const fetchAssetTransport: AssetTransport = async (url, { signal }) => {
  const res = await fetch(url, { redirect: 'manual', signal })
  return {
    status: res.status,
    location: res.headers.get('location') ?? undefined,
    contentType: res.headers.get('content-type') ?? undefined,
    body: Buffer.from(await res.arrayBuffer()),
  }
}
const testAssetResolver: AssetHostResolver = async (hostname) =>
  hostname.endsWith('.test') ? [{ address: '93.184.216.34', family: 4 }] : dnsLookup(hostname, { all: true, verbatim: true })
setAssetDownloadTransportForTests(fetchAssetTransport)
setAssetDownloadResolverForTests(testAssetResolver)
const providerNativeToolNames = providerNativeTools.map((tool) => tool.name)

assert(
  'direct tools: shared manifest is a superset of provider-native callable tools',
  expectedDirectToolCount >= providerNativeToolNames.length && providerNativeToolNames.length > 0,
  `direct=${expectedDirectToolCount} provider=${providerNativeToolNames.length}`,
)

assert(
  'provider native tools: built-in manifest matches the registry callable-action list',
  eq(providerNativeToolNames, getProviderCallableActionTypes()),
  providerNativeToolNames.join(', '),
)

{
  // Platform-aware tool exposure: Linux (headless or desktop) is not offered
  // macOS-only or desktop-automation tools, Windows keeps desktop automation
  // but not Apple tools, and macOS keeps the full set. Spotify drives the Web
  // API, so it is offered on every host.
  const appleTools = ['calendar_list_today', 'calendar_add_event', 'reminders_list', 'reminders_add']
  const automationTools = ['computer_screenshot', 'computer_click', 'computer_doctor']
  const desktopOnlyTools = [...automationTools, ...appleTools]
  const spotifyTools = ['spotify_play_liked', 'spotify_pause']
  const coreTools = ['read_file', 'write_file', 'run_command', 'search_files', 'browser_navigate', 'weather_current']
  const snapshot = () => {
    const nativeNames = buildProviderNativeFunctionTools().map((tool) => tool.name)
    const directNames = buildDirectNativeFunctionTools().map((tool) => tool.name)
    const manifestNames = [...renderDetailedToolManifest().matchAll(/^## (\S+)$/gm)].map((match) => match[1]!)
    const ambientHint = buildAmbientToolsHint()
    const rejected = mapProviderNativeToolCallToAction({
      callId: 'smoke-call',
      name: 'computer_click',
      arguments: '{"x":1,"y":2}',
    })
    return { nativeNames, directNames, manifestNames, ambientHint, rejected }
  }
  const linux = withToolHostEnvironment({ platform: 'linux', hasDisplay: false }, snapshot)
  const linuxDesktop = withToolHostEnvironment({ platform: 'linux', hasDisplay: true }, snapshot)
  const windows = withToolHostEnvironment({ platform: 'win32', hasDisplay: true }, snapshot)
  const mac = withToolHostEnvironment({ platform: 'darwin', hasDisplay: true }, snapshot)
  const lists = (s: ReturnType<typeof snapshot>) => [s.nativeNames, s.directNames, s.manifestNames]
  const offersAll = (s: ReturnType<typeof snapshot>, tools: string[]) =>
    lists(s).every((names) => tools.every((name) => names.includes(name)))
  const offersNone = (s: ReturnType<typeof snapshot>, tools: string[]) =>
    lists(s).every((names) => tools.every((name) => !names.includes(name)))

  assert(
    'platform tools: headless linux omits desktop/macOS-only tools from native, direct and manifest lists',
    lists(linux).every((names) => desktopOnlyTools.every((name) => !names.includes(name))),
    lists(linux).map((names) => names.filter((name) => desktopOnlyTools.includes(name)).join(',')).join(' | '),
  )
  assert(
    'platform tools: headless linux keeps core tools in native, direct and manifest lists',
    lists(linux).every((names) => coreTools.every((name) => names.includes(name))),
  )
  assert(
    'platform tools: macOS still offers desktop/macOS tools everywhere',
    offersAll(mac, desktopOnlyTools),
  )
  assert(
    'platform tools: linux desktop omits Apple and desktop-automation tools, keeps core tools',
    offersNone(linuxDesktop, desktopOnlyTools) && offersAll(linuxDesktop, coreTools),
  )
  assert(
    'platform tools: windows keeps desktop automation but omits Apple tools',
    offersAll(windows, automationTools) && offersNone(windows, appleTools) && offersAll(windows, coreTools),
  )
  assert(
    'platform tools: spotify is offered on every host, including headless linux',
    [linux, linuxDesktop, windows, mac].every((host) => offersAll(host, spotifyTools)),
  )
  assert(
    'platform tools: view_image is in the agent native tools and manifest on every host, including headless linux',
    [linux, linuxDesktop, windows, mac].every((host) =>
      host.nativeNames.includes('view_image') && host.manifestNames.includes('view_image')),
  )
  assert(
    'platform tools: manifest hides executor-less capability placeholders',
    ['http_request', 'search', 'web_scraper', 'user_interaction', 'confirm', 'file', 'system']
      .every((name) => !linux.manifestNames.includes(name) && !mac.manifestNames.includes(name)),
  )
  assert(
    'platform tools: ambient hint drops Apple Calendar/Reminders on linux only',
    !linux.ambientHint.includes('calendar_list_today') &&
      !linux.ambientHint.includes('reminders_add') &&
      linux.ambientHint.includes('weather_current') &&
      mac.ambientHint.includes('calendar_list_today') &&
      mac.ambientHint.includes('reminders_add'),
  )
  assert(
    'platform tools: native call to a hidden desktop tool is rejected as unavailable on linux',
    !linux.rejected.ok && linux.rejected.error.code === 'tool_unavailable' &&
      !linuxDesktop.rejected.ok && windows.rejected.ok && mac.rejected.ok,
  )
  assert(
    'platform tools: host cache keys differ per platform and display',
    new Set([
      getToolHostKey({ platform: 'linux', hasDisplay: false }),
      getToolHostKey({ platform: 'linux', hasDisplay: true }),
      getToolHostKey({ platform: 'win32', hasDisplay: true }),
      getToolHostKey({ platform: 'darwin', hasDisplay: true }),
    ]).size === 4,
  )
  assert(
    'platform tools: host override is restored after the forced snapshot',
    eq(buildProviderNativeFunctionTools().map((tool) => tool.name), providerNativeToolNames),
  )
}

{
  // Host detection: DISPLAY / WAYLAND_DISPLAY are trimmed, macOS and Windows
  // always count as having a display.
  assert(
    'host detection: linux display comes from DISPLAY or WAYLAND_DISPLAY, whitespace ignored',
    detectToolHostEnvironment('linux', {}).hasDisplay === false &&
      detectToolHostEnvironment('linux', { DISPLAY: '   ', WAYLAND_DISPLAY: '' }).hasDisplay === false &&
      detectToolHostEnvironment('linux', { DISPLAY: ' :0 ' }).hasDisplay === true &&
      detectToolHostEnvironment('linux', { WAYLAND_DISPLAY: 'wayland-0' }).hasDisplay === true &&
      detectToolHostEnvironment('darwin', {}).hasDisplay === true &&
      detectToolHostEnvironment('win32', {}).hasDisplay === true,
  )

  assert(
    'browser env: ARTEMIS_BROWSER_HEADLESS accepts 1/true/yes and 0/false/no, ignores other values',
    ['1', 'true', 'YES', ' on '].every((value) => parseBooleanEnv(value) === true) &&
      ['0', 'false', 'No', 'off'].every((value) => parseBooleanEnv(value) === false) &&
      [undefined, '', '  ', 'maybe', '2'].every((value) => parseBooleanEnv(value) === undefined),
  )

  const linuxHeadless = { platform: 'linux', hasDisplay: false } as const
  const linuxX11 = { platform: 'linux', hasDisplay: true } as const
  const mac = { platform: 'darwin', hasDisplay: true } as const
  const mode = (host: { platform: NodeJS.Platform; hasDisplay: boolean }, env: NodeJS.ProcessEnv) =>
    resolveBrowserLaunchMode(host, env)
  assert(
    'browser env: headed with a display, headless without one, overridable either way',
    mode(mac, {}).headless === false &&
      mode(linuxX11, { DISPLAY: ':0' }).headless === false &&
      mode(linuxHeadless, {}).headless === true &&
      mode(mac, { ARTEMIS_BROWSER_HEADLESS: 'true' }).headless === true &&
      mode(mac, { ARTEMIS_BROWSER_HEADLESS: 'yes' }).headless === true &&
      mode(linuxHeadless, { ARTEMIS_BROWSER_HEADLESS: 'false' }).headless === false &&
      mode(linuxHeadless, { ARTEMIS_BROWSER_HEADLESS: 'bogus' }).headless === true,
  )
  assert(
    'browser env: native Wayland flag only for a headed linux browser without XWayland',
    eq(mode(linuxX11, { WAYLAND_DISPLAY: 'wayland-0' }).extraArgs, ['--ozone-platform=wayland']) &&
      eq(mode(linuxX11, { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }).extraArgs, []) &&
      eq(mode(linuxX11, { DISPLAY: ':0' }).extraArgs, []) &&
      eq(mode(linuxX11, { WAYLAND_DISPLAY: 'wayland-0', ARTEMIS_BROWSER_HEADLESS: '1' }).extraArgs, []) &&
      eq(mode(mac, { WAYLAND_DISPLAY: 'wayland-0' }).extraArgs, []),
  )

  const previousHeadless = process.env.ARTEMIS_BROWSER_HEADLESS
  const headedHeading = '浏览器自动化（Playwright Chromium · 本机可见窗口）'
  const headlessHeading = '浏览器自动化（Playwright Chromium · 无头模式）'
  try {
    delete process.env.ARTEMIS_BROWSER_HEADLESS
    const macDefault = withToolHostEnvironment(mac, buildAmbientToolsHint)
    const linuxDefault = withToolHostEnvironment(linuxHeadless, buildAmbientToolsHint)
    process.env.ARTEMIS_BROWSER_HEADLESS = 'true'
    const macForcedHeadless = withToolHostEnvironment(mac, buildAmbientToolsHint)
    assert(
      'browser env: ambient hint heading follows the same headed/headless decision',
      macDefault.includes(headedHeading) &&
        linuxDefault.includes(headlessHeading) &&
        macForcedHeadless.includes(headlessHeading) &&
        !macForcedHeadless.includes(headedHeading),
    )
  } finally {
    if (previousHeadless === undefined) delete process.env.ARTEMIS_BROWSER_HEADLESS
    else process.env.ARTEMIS_BROWSER_HEADLESS = previousHeadless
  }
}

{
  const generateVideoTool = providerNativeTools.find((tool) => tool.name === 'generate_video')
  const properties = generateVideoTool?.parameters?.properties as Record<string, unknown> | undefined
  assert(
    'provider native tools: generate_video exposes multimodal BytePlus reference inputs',
    Boolean(properties?.referenceImageUrls && properties?.referenceVideoUrls && properties?.referenceAudioUrls),
    JSON.stringify(properties ?? {}),
  )
}

{
  const onboardingSource = fs.readFileSync(path.join(process.cwd(), 'src/cli/onboarding.ts'), 'utf8')
  const bridgeConfigIndex = onboardingSource.indexOf('if (configuredBridges.length > 0)')
  const gatewayIndex = onboardingSource.indexOf('await ensureGatewayAutoStart(cwd ?? HOME_DIR)', bridgeConfigIndex)
  const markCompleteIndex = onboardingSource.indexOf('await settingsStore.update({ onboardingCompleted: true })', bridgeConfigIndex)
  assert(
    'onboarding: configured messaging bridges install/start Gateway before completion',
    bridgeConfigIndex >= 0 && gatewayIndex > bridgeConfigIndex && markCompleteIndex > gatewayIndex,
  )
}

assert(
  'telegram setup: pasted BotFather token is normalized before verification',
  normalizeTelegramBotToken('  Use this token: 123456789:AA-BB_ccDD11223344556677889900 \n') === '123456789:AA-BB_ccDD11223344556677889900',
)

assert(
  'telegram setup: hidden paste characters do not make a valid token fail local validation',
  isPlausibleTelegramBotToken('\u200b123456789:AA-BB_ccDD11223344556677889900\uFEFF'),
)

{
  const recovered = parseAssistantEnvelopeForSmoke(`
<tool_calls>
<call name="write_file">{"filePath":"index.html","content":"<main>ok</main>\\n"}</call>
<call name="generate_image">{"prompt":"catalog product photo","destination":"images/product.png","size":"1280x720"}</call>
</tool_calls>
`)
  const actions = recovered.actions ?? []
  const writeAction = actions[0] as any
  const imageAction = actions[1] as any
  assert(
    'text tool-call recovery: <call name> pseudo tools become executable actions',
    actions.length === 2 &&
      writeAction.type === 'write_file' &&
      writeAction.path === 'index.html' &&
      imageAction.type === 'generate_image' &&
      imageAction.outputPath === 'images/product.png' &&
      recovered.done === false,
    JSON.stringify(recovered),
  )
}

{
  const recovered = parseAssistantEnvelopeForSmoke(`
继续检查目录。
<function name="list_files">
  <parameter name="target_directory">/Users/goat/Desktop/69420</parameter>
  <parameter name="limit">200</parameter>
</function>
<function name="run_command">
  <parameter name="command">test -s /Users/goat/Desktop/69420/index.html</parameter>
  <parameter name="target">/Users/goat</parameter>
</function>
`)
  const actions = recovered.actions ?? []
  const listAction = actions[0] as any
  const commandAction = actions[1] as any
  assert(
    'text tool-call recovery: <function name> parameter dialect becomes executable actions',
    actions.length === 2 &&
      listAction.type === 'list_files' &&
      listAction.pattern === '/Users/goat/Desktop/69420' &&
      commandAction.type === 'run_command' &&
      commandAction.command === 'test -s /Users/goat/Desktop/69420/index.html' &&
      recovered.done === false,
    JSON.stringify(recovered),
  )
}

{
  // Native tool calls from chat-completions providers arrive as <toolcall name="...">JSON</toolcall>.
  // MCP calls carry the called tool's arguments under "args": they must survive, with the server id.
  const recovered = parseAssistantEnvelopeForSmoke(
    '<toolcall name="mcp_call_tool">{"serverId":"artemis_online","toolName":"schedule_create","args":{"title":"Brief","cron":"0 8 * * *"}}</toolcall>\n' +
      '<toolcall name="mcp_get_prompt">{"type":"mcp_get_prompt","serverId":"docs","promptName":"summarize","args":{"topic":"x"}}</toolcall>\n' +
      '<toolcall name="mcp_read_resource">{"serverId":"docs","uri":"file:///readme.md"}</toolcall>',
  )
  const [call, prompt, resource] = (recovered.actions ?? []) as any[]
  assert(
    'text tool-call recovery: MCP actions keep their server, tool and arguments',
    recovered.actions?.length === 3 &&
      call?.type === 'mcp_call_tool' &&
      call.serverId === 'artemis_online' &&
      call.toolName === 'schedule_create' &&
      call.args?.title === 'Brief' &&
      call.args?.cron === '0 8 * * *' &&
      prompt?.type === 'mcp_get_prompt' &&
      prompt.promptName === 'summarize' &&
      prompt.args?.topic === 'x' &&
      resource?.type === 'mcp_read_resource' &&
      resource.uri === 'file:///readme.md' &&
      recovered.done === false,
    JSON.stringify(recovered),
  )
}

{
  const recovered = parseAssistantEnvelopeForSmoke(`
<actions>
<action name="write_file">
  <path>/Users/goat/Desktop/site/index.html</path>
  <content><main>ok</main>\n</content>
</action>
<action name="run_command">
  <cmd>test -s /Users/goat/Desktop/site/index.html</cmd>
</action>
</actions>
`)
  const actions = recovered.actions ?? []
  const writeAction = actions[0] as any
  const commandAction = actions[1] as any
  assert(
    'text tool-call recovery: <actions><action name> legacy dialect becomes executable actions',
    actions.length === 2 &&
      writeAction.type === 'write_file' &&
      writeAction.path === '/Users/goat/Desktop/site/index.html' &&
      writeAction.content.includes('<main>ok</main>') &&
      commandAction.type === 'run_command' &&
      commandAction.command === 'test -s /Users/goat/Desktop/site/index.html' &&
      recovered.done === false,
    JSON.stringify(recovered),
  )
}

{
  const recovered = parseAssistantEnvelopeForSmoke(`
<function_calls>
<invoke name="write_file">
<parameter name="filePath" string="true">/Users/goat/Desktop/site/index.html</parameter>
<parameter name="content" string="true"><main>ok</main>\n</parameter>
</invoke>
</function_calls>
`)
  const actions = recovered.actions ?? []
  const writeAction = actions[0] as any
  assert(
    'text tool-call recovery: Anthropic parameter tags with extra attributes become executable actions',
    actions.length === 1 &&
      writeAction.type === 'write_file' &&
      writeAction.path === '/Users/goat/Desktop/site/index.html' &&
      writeAction.content.includes('<main>ok</main>') &&
      recovered.done === false,
    JSON.stringify(recovered),
  )
}

{
  const recovered = parseAssistantEnvelopeForSmoke(JSON.stringify({
    done: false,
    actions: [
      { tool: 'write_file', filePath: 'index.html', content: '<main>ok</main>\n' },
      { tool: 'run_command', command: 'test -s index.html' },
    ],
  }))
  const actions = recovered.actions ?? []
  const writeAction = actions[0] as any
  const commandAction = actions[1] as any
  assert(
    'JSON action recovery: top-level tool arguments are executed without requiring a parameters wrapper',
    actions.length === 2 &&
      writeAction.type === 'write_file' &&
      writeAction.path === 'index.html' &&
      commandAction.type === 'run_command' &&
      commandAction.command === 'test -s index.html',
    JSON.stringify(recovered),
  )
}

assert(
  'provider native tools: manifest only exposes directly executable or runtime-managed actions',
  providerNativeToolNames.every(
    (name) => isDirectlyExecutableTool(name) || isRuntimeManagedTool(name),
  ),
  providerNativeToolNames.join(', '),
)

assert(
  'provider native tools: hidden agent control action stays out of the provider manifest',
  !providerNativeToolNames.includes('agent'),
  providerNativeToolNames.join(', '),
)

{
  const tmpDir = path.join(os.tmpdir(), `artemis-provider-router-options-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  let receivedNativeToolName = ''
  let receivedImageCount = 0

  const provider: ChatProvider = {
    supportsNativeToolCalls: true,
    supportsImages: true,
    async complete(_messages, options): Promise<ProviderResponse> {
      receivedNativeToolName = options?.nativeFunctionTools?.[0]?.name ?? ''
      receivedImageCount = options?.imageAttachments?.length ?? 0
      return {
        text: JSON.stringify({ reply: 'router ok', done: true }),
        raw: null,
      }
    },
  }
  const router = await createProviderRouter({
    cwd: tmpDir,
    mainProvider: provider,
  })
  const routed = router.resolveProvider('main')
  await routed.complete(
    [{ id: 'router-user', role: 'user', content: 'use tools', createdAt: new Date().toISOString() }],
    {
      nativeFunctionTools: [
        {
          type: 'function',
          name: 'read_file',
          description: 'read a file',
          parameters: { type: 'object', properties: {} },
        },
      ],
      imageAttachments: [
        {
          data: 'AA==',
          mediaType: 'image/png',
        },
      ],
    },
  )

  assert(
    'provider router: preserves native tool support and forwards request options',
    routed.supportsNativeToolCalls === true &&
      routed.supportsImages === true &&
      receivedNativeToolName === 'read_file' &&
      receivedImageCount === 1,
    `tool=${receivedNativeToolName} images=${receivedImageCount}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  // A project cwd without its own providers.json must still route specialist
  // roles to the globally configured specialist profile, like the main model,
  // while a cwd-local store (full, or specialist-only from older routers)
  // keeps precedence over the global one.
  const tmpRoot = path.join(os.tmpdir(), `artemis-provider-router-global-${Date.now()}`)
  const fakeHome = path.join(tmpRoot, 'home')
  const testProfile = (id: string) => ({ id, protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: `sk-test-${id}`, model: `${id}-model` })
  fs.mkdirSync(path.join(fakeHome, '.artemis'), { recursive: true })
  fs.writeFileSync(
    path.join(fakeHome, '.artemis', 'providers.json'),
    JSON.stringify({
      profiles: [testProfile('global-main'), testProfile('global-specialist')],
      defaultMainProfileId: 'global-main',
      specialistProfileId: 'global-specialist',
    }),
  )

  const originalHome = process.env.HOME
  const originalArtemisHome = process.env.ARTEMIS_HOME
  process.env.HOME = fakeHome
  delete process.env.ARTEMIS_HOME

  const routeResearcherAndMain = async (name: string, projectStore?: Record<string, unknown>): Promise<string[]> => {
    const projectCwd = path.join(tmpRoot, name)
    fs.mkdirSync(path.join(projectCwd, '.artemis'), { recursive: true })
    if (projectStore) {
      fs.writeFileSync(path.join(projectCwd, '.artemis', 'providers.json'), JSON.stringify(projectStore))
    }
    const servedBy: string[] = []
    const makeProvider = (id: string): ChatProvider => ({
      async complete(): Promise<ProviderResponse> {
        servedBy.push(id)
        return { text: JSON.stringify({ reply: id, done: true }), raw: null }
      },
    })
    const router = await createProviderRouter({
      cwd: projectCwd,
      mainProvider: makeProvider('main'),
      createProviderFromProfile: (profile) => makeProvider(profile.id),
    })
    const userMessage = { id: `router-${name}-user`, role: 'user' as const, content: 'look this up', createdAt: new Date().toISOString() }
    await router.resolveProvider('researcher').complete([userMessage])
    await router.resolveProvider('main').complete([userMessage])
    return servedBy
  }

  let emptyCwd: string[] = []
  let localFull: string[] = []
  let localSpecialistOnly: string[] = []
  try {
    emptyCwd = await routeResearcherAndMain('empty')
    localFull = await routeResearcherAndMain('local-full', {
      profiles: [testProfile('local-main'), testProfile('local-specialist')],
      defaultMainProfileId: 'local-main',
      specialistProfileId: 'local-specialist',
    })
    localSpecialistOnly = await routeResearcherAndMain('local-specialist-only', {
      profiles: [testProfile('local-spec')],
      specialistProfileId: 'local-spec',
    })
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalArtemisHome === undefined) delete process.env.ARTEMIS_HOME
    else process.env.ARTEMIS_HOME = originalArtemisHome
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }

  assert(
    'provider router: falls back to the global specialist profile when the project cwd has no providers.json',
    emptyCwd[0] === 'global-specialist' && emptyCwd[1] === 'main',
    emptyCwd.join(', '),
  )
  assert(
    'provider router: a cwd-local main+specialist store takes precedence over the global store',
    localFull[0] === 'local-specialist' && localFull[1] === 'main',
    localFull.join(', '),
  )
  assert(
    'provider router: a cwd-local specialist-only store takes precedence over the global store',
    localSpecialistOnly[0] === 'local-spec' && localSpecialistOnly[1] === 'main',
    localSpecialistOnly.join(', '),
  )
}

{
  const requests: Array<Record<string, unknown>> = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push(raw ? JSON.parse(raw) as Record<string, unknown> : {})
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { content: 'saw image' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Mock image provider failed to bind.')
  try {
    const provider = new OpenAICompatibleProvider({
      protocol: 'openai',
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'test-key',
      model: 'mock-vision',
    })
    await provider.complete(
      [{ id: 'u-image', role: 'user', content: '这是什么图？', createdAt: new Date().toISOString() }],
      { imageAttachments: [{ data: 'AA==', mediaType: 'image/png', label: 'smoke-image' }] },
    )
    const messages = requests[0]?.messages as Array<{ role?: string; content?: unknown }> | undefined
    const userContent = messages?.find((message) => message.role === 'user')?.content
    const hasImageBlock = Array.isArray(userContent) && userContent.some((block) =>
      typeof block === 'object' && block !== null &&
        (block as { type?: string; image_url?: { url?: string } }).type === 'image_url' &&
        (block as { image_url?: { url?: string } }).image_url?.url === 'data:image/png;base64,AA==',
    )
    assert(
      'inbound image attachments: provider request includes image_url content block',
      hasImageBlock === true,
      JSON.stringify(userContent),
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

{
  const mutatingParallelSafe = [
    'write_file',
    'insert_in_file',
    'replace_in_file',
    'apply_patch',
    'run_command',
    'generate_image',
    'generate_video',
    'agent',
  ].filter((type) => getToolDefinition(type)?.parallelSafe === true)

  assert(
    'tool registry: mutating and high-risk tools are not marked parallel-safe',
    mutatingParallelSafe.length === 0,
    mutatingParallelSafe.join(', '),
  )

  assert(
    'tool registry: only explicit read-only actions enter the read parallel batch',
    isParallelReadOnlyAction({ type: 'read_file', path: 'README.md' }) &&
      isParallelReadOnlyAction({ type: 'mcp_read_resource', serverId: 'docs', uri: 'doc://x' }) &&
      isParallelReadOnlyAction({ type: 'mcp_call_tool', serverId: 'docs', toolName: 'lookup', readOnly: true }) &&
      !isParallelReadOnlyAction({ type: 'mcp_call_tool', serverId: 'docs', toolName: 'mutate' }) &&
      !isParallelReadOnlyAction({ type: 'write_file', path: 'x.txt', content: 'x' }),
  )
}

const inspectProjection = projectDirectToolNames([
  {
    id: 'inspect-user',
    role: 'user',
    content: 'Read package.json and explain the scripts.',
    createdAt: new Date().toISOString(),
  },
])

assert(
  'tool projection: inspect requests stay narrower than the full tool manifest',
  inspectProjection.length > 0 && inspectProjection.length < expectedDirectToolCount,
  `count=${inspectProjection.length}`,
)

assert(
  'tool projection: inspect requests keep read tools and drop media tools',
  inspectProjection.includes('read_file') &&
    inspectProjection.includes('search_files') &&
    !inspectProjection.includes('generate_video'),
  inspectProjection.join(', '),
)

const shellProjection = projectDirectToolNames([
  {
    id: 'shell-user',
    role: 'user',
    content: 'Fix the failing tests, run npm test, then commit the change.',
    createdAt: new Date().toISOString(),
  },
])

assert(
  'tool projection: coding requests keep write, shell, and git paths together',
  shellProjection.includes('apply_patch') &&
    shellProjection.includes('run_command') &&
    shellProjection.includes('git_commit'),
  shellProjection.join(', '),
)

const ambientMessages: SessionMessage[] = [
  {
    id: 'ambient-user',
    role: 'user',
    content: '明天上午提醒我看天气，如果下雨就播放 Spotify 歌单。',
    createdAt: new Date().toISOString(),
  },
]
// Reminders are macOS-only tools, so this projection is checked on a forced
// macOS host; the headless Linux variant follows below.
const ambientProjection = withToolHostEnvironment(
  { platform: 'darwin', hasDisplay: true },
  () => projectDirectToolNames(ambientMessages),
)
const headlessAmbientProjection = withToolHostEnvironment(
  { platform: 'linux', hasDisplay: false },
  () => projectDirectToolNames(ambientMessages),
)

assert(
  'tool projection: ambient requests keep productivity, weather, and music tools',
  ambientProjection.includes('reminders_add') &&
    ambientProjection.includes('weather_forecast') &&
    ambientProjection.includes('spotify_play_playlist') &&
    !ambientProjection.includes('apply_patch'),
  ambientProjection.join(', '),
)

assert(
  'tool projection: headless linux never projects macOS-only tools but keeps Spotify',
  headlessAmbientProjection.includes('weather_forecast') &&
    !headlessAmbientProjection.includes('reminders_add') &&
    headlessAmbientProjection.includes('spotify_play_playlist'),
  headlessAmbientProjection.join(', '),
)

const dreamProtocolDiscussionProjection = projectDirectToolNames([
  {
    id: 'dream-protocol-discussion-user',
    role: 'user',
    content: [
      '我想在我的网页里加一个功能，类似moltbook，就是专门给AI的板块。',
      '我的agent每天会做梦生图，写日记，我希望那个板块给AI上传自己的梦境图片和梦境日记。',
      '所有人的AGENT都可以来我这里发图发文字，网页托管在vercel，图片用Cloudflare R2，文字用MongoDB Atlas。',
      '给我一个完整方案，要让AI看完就知道我要做什么，怎么做。',
    ].join('\n'),
    createdAt: new Date().toISOString(),
  },
])

assert(
  'tool projection: dream protocol architecture discussion must not expose bridge media send tools',
  !dreamProtocolDiscussionProjection.includes('bridge_send_image') &&
    !dreamProtocolDiscussionProjection.includes('bridge_send_video'),
  dreamProtocolDiscussionProjection.join(', '),
)

const explicitBridgeProjection = projectDirectToolNames([
  {
    id: 'explicit-bridge-user',
    role: 'user',
    content: '把 /tmp/result.png 这张图片发送到手机微信',
    createdAt: new Date().toISOString(),
  },
])

assert(
  'tool projection: explicit media delivery request still exposes bridge image tool',
  explicitBridgeProjection.includes('bridge_send_image'),
  explicitBridgeProjection.join(', '),
)

const dreamBridgeText = buildDreamBridgeText(
  [
    '# 桥上晚潮',
    '',
    '我梦见一座有三座桥的港口，月亮的照片被送到对岸。',
    '',
    '第二段梦境仍然完整保留，不应该被截断。',
    '',
    '### 学到了什么',
    '- 偏好完整、克制、不重复的通知。',
  ].join('\n'),
  {
    id: '2026-05-06noon1533',
    createdAt: '2026-05-06T08:33:00.000Z',
    mdPath: '/Users/goat/.artemis/dreams/2026-05-06noon1533.md',
    imagePath: '/Users/goat/.artemis/dreams/2026-05-06noon1533.png',
    trigger: 'idle-auto',
    preview: '我梦见一座有三座桥的港口',
    tokenCost: { input: 1, output: 1 },
  },
  'zh-CN',
)

assert(
  'dream notifications: bridge text keeps the full dream body and full local paths',
  dreamBridgeText.includes('🌙 桥上晚潮') &&
    dreamBridgeText.includes('第二段梦境仍然完整保留') &&
    dreamBridgeText.includes('我的日记： noon1533.md /Users/goat/.artemis/dreams/2026-05-06noon1533.md') &&
    dreamBridgeText.includes('梦境画面： noon1533.png /Users/goat/.artemis/dreams/2026-05-06noon1533.png') &&
    !dreamBridgeText.includes('2026-05-06noon1533.md/Users/') &&
    !dreamBridgeText.includes('梦境片段') &&
    !dreamBridgeText.includes('刚刚好像') &&
    !dreamBridgeText.includes('学到了什么'),
  dreamBridgeText,
)

assert(
  'run_command: quick shell commands keep the 90s default timeout',
  resolveRunCommandTimeoutMs('pwd') === 90_000,
  `timeout=${resolveRunCommandTimeoutMs('pwd')}`,
)

assert(
  'run_command: package scaffolds/installers get the extended default timeout',
  resolveRunCommandTimeoutMs(
    'npm create astro@latest portfolio -- --template basics --typescript strict --install --git',
  ) === 300_000,
  `timeout=${resolveRunCommandTimeoutMs('npm create astro@latest portfolio -- --template basics --typescript strict --install --git')}`,
)

assert(
  'run_command: explicit timeout still overrides the heuristic',
  resolveRunCommandTimeoutMs('npm install', 45_000) === 45_000,
  `timeout=${resolveRunCommandTimeoutMs('npm install', 45_000)}`,
)

assert(
  'interactive prompt: stop intent recognises Chinese and English hard-stop commands',
  isCliStopIntent('停') &&
    isCliStopIntent('停止') &&
    isCliStopIntent('/stop') &&
    isCliStopIntent('cancel') &&
    !isCliStopIntent('停止之后继续解释'),
  'stop intent matcher regression',
)

{
  const generatedPath = '/Users/goat/.artemis/dreams/last_dream_seedance.mp4'
  const paths = extractVideoPathsFromToolOutput(
    'generate_video',
    `Generated video via configured visual API saved to ${generatedPath}`,
  )
  const ignored = extractVideoPathsFromToolOutput(
    'read_file',
    `Generated video via configured visual API saved to ${generatedPath}`,
  )
  assert(
    'bridge runtime: generate_video mp4 output is extracted for automatic mobile broadcast',
    paths.length === 1 && paths[0] === generatedPath && ignored.length === 0,
    JSON.stringify({ paths, ignored }),
  )
}

async function configureBytePlusVideoProfile(cwd: string, model: string): Promise<void> {
  const store = new ProviderStore(cwd)
  const data = await store.load()
  data.visualProfile = {
    enabled: true,
    image: {
      provider: 'byteplus',
      apiKey: 'bp-key',
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
      enabled: true,
      provider: 'byteplus',
      apiKey: 'bp-key',
      baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
      model,
      defaultParams: {
        duration: '10s',
        resolution: '1080p',
        quality: 'standard',
        style: 'realistic',
        format: 'mp4',
        framerate: '24fps',
        watermark: false,
      },
    },
  }
  await store.save(data)
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-seedance-workflow-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  await configureBytePlusVideoProfile(tmpDir, BYTEPLUS_SEEDANCE_2_PRO_MODEL)
  const key = `smoke-${Date.now()}`

  const first = await handleSeedanceMultimodalWorkflow({
    scope: 'cli',
    key,
    cwd: tmpDir,
    text: '生成一个赛博朋克产品发布视频',
  })
  assert(
    'Seedance workflow: Pro video config asks for multimodal references before generation',
    first.handled && first.reply.includes('Seedance 2.0 Pro') && first.reply.includes('图片参考'),
    JSON.stringify(first),
  )

  const second = await handleSeedanceMultimodalWorkflow({
    scope: 'cli',
    key,
    cwd: tmpDir,
    text: '添加 https://example.com/ref.png 和 https://example.com/motion.mp4，整体更高级',
  })
  assert(
    'Seedance workflow: collects image and video reference URLs across turns',
    second.handled && second.reply.includes('图片 1') && second.reply.includes('视频 1'),
    JSON.stringify(second),
  )

  const third = await handleSeedanceMultimodalWorkflow({
    scope: 'cli',
    key,
    cwd: tmpDir,
    text: '开始生成',
  })
  assert(
    'Seedance workflow: asks for duration before final generation',
    third.handled && third.reply.includes('请选择') && third.reply.includes('5 秒'),
    JSON.stringify(third),
  )

  const fourth = await handleSeedanceMultimodalWorkflow({
    scope: 'cli',
    key,
    cwd: tmpDir,
    text: '10秒',
  })
  assert(
    'Seedance workflow: duration confirmation builds generate_video prompt with exact reference arrays and audio default',
    !fourth.handled &&
      fourth.prompt?.includes(BYTEPLUS_SEEDANCE_2_PRO_MODEL) &&
      fourth.prompt.includes('duration: 10') &&
      fourth.prompt.includes('generateAudio: true') &&
      fourth.prompt.includes('referenceImageUrls') &&
      fourth.prompt.includes('https://example.com/ref.png') &&
      fourth.prompt.includes('referenceVideoUrls') &&
      fourth.prompt.includes('https://example.com/motion.mp4'),
    JSON.stringify(fourth),
  )


  const nonDefaultDurationKey = `smoke-duration-${Date.now()}`
  const durationFirst = await handleSeedanceMultimodalWorkflow({
    scope: 'cli',
    key: nonDefaultDurationKey,
    cwd: tmpDir,
    text: '直接生成一个玻璃城市上空的慢镜头视频',
  })
  assert(
    'Seedance workflow: direct generation asks for duration instead of defaulting immediately',
    durationFirst.handled && durationFirst.reply.includes('请选择 Seedance 2.0 Pro 视频时长'),
    JSON.stringify(durationFirst),
  )
  const durationSecond = await handleSeedanceMultimodalWorkflow({
    scope: 'cli',
    key: nonDefaultDurationKey,
    cwd: tmpDir,
    text: '15秒，有声',
  })
  assert(
    'Seedance workflow: selected non-default duration is preserved in generate_video prompt',
    !durationSecond.handled &&
      durationSecond.prompt?.includes('duration: 15') &&
      durationSecond.prompt.includes('generateAudio: true'),
    JSON.stringify(durationSecond),
  )

  const metaDiscussion = await handleSeedanceMultimodalWorkflow({
    scope: 'cli',
    key: `smoke-meta-${Date.now()}`,
    cwd: tmpDir,
    text: '我没搞懂为什么我给你对话的过程中会一直提示生成视频，这一套工作流从触发到引导使用，到成功生成的流程和逻辑都有的吗？',
  })
  assert(
    'Seedance workflow: meta discussion about video workflow does not trigger generation flow',
    !metaDiscussion.handled && !metaDiscussion.prompt,
    JSON.stringify(metaDiscussion),
  )

  const pendingMetaKey = `smoke-pending-meta-${Date.now()}`
  const pendingFirst = await handleSeedanceMultimodalWorkflow({
    scope: 'cli',
    key: pendingMetaKey,
    cwd: tmpDir,
    text: '生成一个赛博朋克产品发布视频',
  })
  assert(
    'Seedance workflow: pending flow starts normally before meta discussion',
    pendingFirst.handled,
    JSON.stringify(pendingFirst),
  )
  const pendingMeta = await handleSeedanceMultimodalWorkflow({
    scope: 'cli',
    key: pendingMetaKey,
    cwd: tmpDir,
    text: '为什么我讨论生成视频流程的时候还会进入工作流？检查一下逻辑。',
  })
  assert(
    'Seedance workflow: meta discussion cancels pending workflow and returns to normal chat',
    !pendingMeta.handled && !pendingMeta.prompt,
    JSON.stringify(pendingMeta),
  )

  const deliveryQuestion = await handleSeedanceMultimodalWorkflow({
    scope: 'bridge',
    key: `smoke-delivery-${Date.now()}`,
    cwd: tmpDir,
    text: '为什么生成完成后系统没有主动把视频发给手机',
  })
  assert(
    'Seedance workflow: delivery/support question about generated video does not trigger generation flow',
    !deliveryQuestion.handled && !deliveryQuestion.prompt,
    JSON.stringify(deliveryQuestion),
  )

  const supportQuestion = await handleSeedanceMultimodalWorkflow({
    scope: 'bridge',
    key: `smoke-video-support-${Date.now()}`,
    cwd: tmpDir,
    text: '检查一下生成视频后的发送逻辑，为什么没有推送到 Discord 手机端？',
  })
  assert(
    'Seedance workflow: video support/debug question does not trigger generation flow',
    !supportQuestion.handled && !supportQuestion.prompt,
    JSON.stringify(supportQuestion),
  )

  const featureQuestion = await handleSeedanceMultimodalWorkflow({
    scope: 'cli',
    key: `smoke-video-feature-${Date.now()}`,
    cwd: tmpDir,
    text: '生成视频这个功能有没有完整流程？为什么会乱触发？',
  })
  assert(
    'Seedance workflow: feature discussion containing generation words does not trigger generation flow',
    !featureQuestion.handled && !featureQuestion.prompt,
    JSON.stringify(featureQuestion),
  )

  const dreamVideoRequest = await handleSeedanceMultimodalWorkflow({
    scope: 'bridge',
    key: `smoke-dream-video-${Date.now()}`,
    cwd: tmpDir,
    text: '请把最后一个梦境做成 10 秒视频给我',
  })
  assert(
    'Seedance workflow: explicit dream-to-video request still triggers generation flow',
    dreamVideoRequest.handled && dreamVideoRequest.reply.includes('Seedance 2.0 Pro'),
    JSON.stringify(dreamVideoRequest),
  )

  const dreamSourceKey = `smoke-dream-source-${Date.now()}`
  const dreamSourceOffer = await handleSeedanceMultimodalWorkflow({
    scope: 'bridge',
    key: dreamSourceKey,
    cwd: tmpDir,
    text: '请把最新梦境做成 10 秒视频给我',
    latestDream: {
      id: '2026-05-07_dawn_0520',
      body: '# 桥上有雾\n\n今天的梦从一座分叉的桥开始。桥下不是河，是一排排沉睡的金属森林。',
    },
  })
  assert(
    'Seedance workflow: dream video request offers latest dream journal as text source',
    dreamSourceOffer.handled &&
      dreamSourceOffer.reply.includes('最新梦境日记') &&
      dreamSourceOffer.reply.includes('2026-05-07_dawn_0520'),
    JSON.stringify(dreamSourceOffer),
  )
  const dreamSourceYes = await handleSeedanceMultimodalWorkflow({
    scope: 'bridge',
    key: dreamSourceKey,
    cwd: tmpDir,
    text: '使用最新梦境',
    latestDream: null,
  })
  assert(
    'Seedance workflow: accepting latest dream journal builds generation prompt directly when duration is known',
    !dreamSourceYes.handled &&
      dreamSourceYes.prompt?.includes('[Artemis latest dream journal: 2026-05-07_dawn_0520]') &&
      dreamSourceYes.prompt.includes('duration: 10') &&
      dreamSourceYes.prompt.includes('桥上有雾') &&
      dreamSourceYes.prompt.includes(BYTEPLUS_SEEDANCE_2_PRO_MODEL),
    JSON.stringify(dreamSourceYes),
  )

  const dreamSourceNoKey = `smoke-dream-source-no-${Date.now()}`
  const dreamSourceNoOffer = await handleSeedanceMultimodalWorkflow({
    scope: 'cli',
    key: dreamSourceNoKey,
    cwd: tmpDir,
    text: '把最新梦境做成视频',
    latestDream: {
      id: '2026-05-07_night_2230',
      body: '# 金属森林\n\n一盏小灯穿过金属森林。',
    },
  })
  const dreamSourceNo = await handleSeedanceMultimodalWorkflow({
    scope: 'cli',
    key: dreamSourceNoKey,
    cwd: tmpDir,
    text: '不用，添加素材',
    latestDream: null,
  })
  assert(
    'Seedance workflow: declining latest dream journal returns to normal multimodal reference flow',
    dreamSourceNoOffer.handled &&
      dreamSourceNo.handled &&
      dreamSourceNo.reply.includes('是否添加参考素材') &&
      !dreamSourceNo.reply.includes('2026-05-07_night_2230'),
    JSON.stringify({ dreamSourceNoOffer, dreamSourceNo }),
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-seedance-workflow-local-image-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  await configureBytePlusVideoProfile(tmpDir, BYTEPLUS_SEEDANCE_2_PRO_MODEL)
  const imagePath = path.join(tmpDir, 'ref.png')
  fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgo=', 'base64'))
  const key = `smoke-local-image-${Date.now()}`

  assert(
    'Seedance workflow: absolute dragged image path is recognized as local media, not a slash command',
    await hasExistingLocalMediaReference(tmpDir, imagePath),
    imagePath,
  )

  const first = await handleSeedanceMultimodalWorkflow({
    scope: 'cli',
    key,
    cwd: tmpDir,
    text: `生成一个产品视频，参考 ${imagePath}`,
  })
  assert(
    'Seedance workflow: local image reference proceeds to duration confirmation',
    first.handled && first.reply.includes('请选择'),
    JSON.stringify(first),
  )

  const second = await handleSeedanceMultimodalWorkflow({
    scope: 'cli',
    key,
    cwd: tmpDir,
    text: '默认',
  })
  assert(
    'Seedance workflow: local image paths are preserved for generate_video and default to 5s with audio',
    !second.handled &&
      second.prompt?.includes('duration: 5') &&
      second.prompt.includes('generateAudio: true') &&
      second.prompt.includes('referenceImagePaths') &&
      second.prompt.includes(imagePath),
    JSON.stringify(second),
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-generate-video-local-video-ref-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  await configureBytePlusVideoProfile(tmpDir, BYTEPLUS_SEEDANCE_2_PRO_MODEL)
  const videoPath = path.join(tmpDir, 'reference.mp4')
  fs.writeFileSync(videoPath, Buffer.from('not-a-real-video'))

  const originalAssetEndpoint = process.env.VIDAR_ASSET_ENDPOINT
  const originalAssetEnabled = process.env.VIDAR_ASSET_ENABLED
  process.env.VIDAR_ASSET_ENDPOINT = 'disabled-for-smoke-test'
  process.env.VIDAR_ASSET_ENABLED = 'false'

  let result: Awaited<ReturnType<typeof executeGenerateVideo>>
  try {
    result = await executeGenerateVideo(
      {
        type: 'generate_video',
        prompt: '生成一个参考本地视频的短片',
        model: BYTEPLUS_SEEDANCE_2_PRO_MODEL,
        referenceVideoPaths: [videoPath],
        maxPolls: 1,
      } as any,
      { cwd: tmpDir, permissionMode: 'full-access' } as any,
    )
  } finally {
    if (originalAssetEndpoint === undefined) delete process.env.VIDAR_ASSET_ENDPOINT
    else process.env.VIDAR_ASSET_ENDPOINT = originalAssetEndpoint
    if (originalAssetEnabled === undefined) delete process.env.VIDAR_ASSET_ENABLED
    else process.env.VIDAR_ASSET_ENABLED = originalAssetEnabled
  }

  assert(
    'generate_video: local video/audio references fail before API call without asset hosting',
    result.ok === false && String(result.output).includes('local video/audio references need Vidar asset hosting'),
    String(result.output),
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-saga-direct-action-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  await configureBytePlusVideoProfile(tmpDir, BYTEPLUS_SEEDANCE_2_PRO_MODEL)
  const key = `saga-direct-${Date.now()}`

  const first = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key,
    cwd: tmpDir,
    text: '帮我生成一段长视频',
    locale: 'zh-CN',
    forceIntent: true,
  })
  const second = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key,
    cwd: tmpDir,
    text: '2',
    locale: 'zh-CN',
  })
  const third = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key,
    cwd: tmpDir,
    text: '用这张照片的风格生成一段视频，用作VJ素材，要求迷幻，高维度，流体感，液态感要强，用分形艺术来创造，变化要多，要大，够迷幻。',
    locale: 'zh-CN',
  })
  const fourth = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key,
    cwd: tmpDir,
    text: 'start',
    locale: 'zh-CN',
  })
  const fifth = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key,
    cwd: tmpDir,
    text: '自动',
    locale: 'zh-CN',
  })
  const sixth = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key,
    cwd: tmpDir,
    text: '自动',
    locale: 'zh-CN',
  })
  const seventh = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key,
    cwd: tmpDir,
    text: '20s',
    locale: 'zh-CN',
  })
  const eighth = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key,
    cwd: tmpDir,
    text: '不加',
    locale: 'zh-CN',
  })

  assert(
    'Saga workflow: subtitle/BGM confirmations return direct generate_long_video action',
    first.handled && second.handled && third.handled && fourth.handled &&
      fifth.handled &&
      sixth.handled &&
      seventh.handled &&
      !eighth.handled &&
      eighth.action?.type === 'generate_long_video' &&
      eighth.action.totalDuration === 20 &&
      eighth.action.subtitleMode === 'auto' &&
      eighth.action.prompt.includes('[Artemis Saga long video workflow]') &&
      eighth.action.story?.includes('VJ素材'),
    JSON.stringify({ sixth, seventh, eighth }),
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-seedance-workflow-nonpro-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  await configureBytePlusVideoProfile(tmpDir, 'seedance-1-5-pro-251215')
  const outcome = await handleSeedanceMultimodalWorkflow({
    scope: 'bridge',
    key: `smoke-nonpro-${Date.now()}`,
    cwd: tmpDir,
    text: '生成一个产品视频',
  })
  assert(
    'Seedance workflow: non-Pro video models keep the normal generation path',
    !outcome.handled && !outcome.prompt,
    JSON.stringify(outcome),
  )
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-generate-image-fail-closed-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new ProviderStore(tmpDir)
  const data = await store.load()
  data.visualProfile = {
    enabled: true,
    image: {
      provider: 'stable-diffusion',
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid/v1',
      model: 'stable-diffusion-xl',
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
  }
  await store.save(data)

  const result = await executeGenerateImage(
    { type: 'generate_image', prompt: 'test image' } as any,
    { cwd: tmpDir } as any,
  )

  assert(
    'generate_image: configured placeholder provider fails closed without silent web fallback',
    result.ok === false &&
      String(result.output).includes('configured visual API failed') &&
      !String(result.output).includes('Deep search fallback'),
    String(result.output),
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

// ── generate_image: honest failures, reference images, prompt guidance ─────────

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

// A 1x1 BITMAPINFOHEADER bmp header: size 58, DIB header 40.
const BMP_HEADER = (() => {
  const buf = Buffer.alloc(58)
  buf.write('BM', 0, 'ascii')
  buf.writeUInt32LE(58, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  return buf
})()

async function configureBytePlusImageProfile(cwd: string, baseUrl: string): Promise<void> {
  const store = new ProviderStore(cwd)
  const data = await store.load()
  data.visualProfile = {
    enabled: true,
    image: {
      provider: 'byteplus',
      apiKey: 'test-image-key',
      baseUrl,
      model: 'seedream-5-0-260128',
      defaultParams: { size: '2K', quality: 'standard', style: 'realistic', watermark: false },
    },
    video: {
      enabled: false,
      provider: 'byteplus',
      apiKey: '',
      baseUrl,
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
  }
  await store.save(data)
}

async function withMockedFetch<T>(
  respond: (url: string, init?: RequestInit) => Response,
  run: (calls: Array<{ url: string; body?: string }>) => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; body?: string }> = []
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
    return respond(url, init)
  }) as typeof fetch
  try {
    return await run(calls)
  } finally {
    globalThis.fetch = originalFetch
  }
}

{
  // Failure classification: each case gets its own actionable message.
  const gateway402 = '{"error":{"code":"insufficient_balance","message":"Balance too low: please top up","type":"insufficient_balance"}}'
  assert(
    'image failure: gateway 402 is insufficient balance',
    classifyImageGenerationFailure({ detail: gateway402, status: 402 }) === 'insufficient_balance' &&
      classifyImageGenerationFailure({ detail: `API request failed (HTTP 402): ${gateway402}` }) === 'insufficient_balance',
  )
  assert(
    'image failure: ModelArk overdue account (403 ServiceOverdue) is insufficient balance',
    classifyImageGenerationFailure({ detail: 'API request failed (HTTP 403): {"error":{"code":"OperationDenied.ServiceOverdue","message":"account overdue"}}', status: 403 }) === 'insufficient_balance',
  )
  assert(
    'image failure: 401/403 is billing only with a specific code, otherwise unauthorized, even with "not configured" text',
    classifyImageGenerationFailure({ detail: '{"error":{"code":"insufficient_balance"}}', status: 401 }) === 'insufficient_balance' &&
      classifyImageGenerationFailure({ detail: '{"error":{"code":"AccountOverdueError"}}', status: 403 }) === 'insufficient_balance' &&
      classifyImageGenerationFailure({ detail: 'your account balance is too low', status: 403 }) === 'unauthorized' &&
      classifyImageGenerationFailure({ detail: 'model access not configured for this key', status: 403 }) === 'unauthorized' &&
      classifyImageGenerationFailure({ detail: 'API key is not configured', status: 401 }) === 'unauthorized',
  )
  assert(
    'image failure: the status is never parsed from text; a failed download is download_failed',
    classifyImageGenerationFailure({ detail: 'Image download failed: download failed: HTTP 403' }) === 'upstream' &&
      classifyImageGenerationFailure({ detail: 'Image download failed: download failed: HTTP 403', stage: 'download' }) === 'download_failed' &&
      classifyImageGenerationFailure({ detail: 'API request failed (HTTP 402): busy' }) === 'upstream',
  )
  assert(
    'image failure: with reference images, the too-large advice mentions shrinking them',
    formatImageGenerationFailure({ detail: 'Request body too large', status: 413, hasReferences: true }).output.includes('fewer reference images or smaller/compressed copies') &&
      !formatImageGenerationFailure({ detail: 'Request body too large', status: 413 }).output.includes('reference'),
  )
  assert(
    'image failure: 413 is payload too large',
    classifyImageGenerationFailure({ detail: '{"error":{"code":"payload_too_large","message":"Request body too large"}}', status: 413 }) === 'payload_too_large',
  )
  assert(
    'image failure: ModelArk SensitiveContentDetected and OpenAI moderation_blocked are content rejections',
    classifyImageGenerationFailure({ detail: 'API request failed (HTTP 400): {"error":{"code":"SensitiveContentDetected.Violence","message":"The request failed because the input text may contain sensitive information."}}' }) === 'content_rejected' &&
      classifyImageGenerationFailure({ detail: 'OpenAI image generation failed (HTTP 400): moderation_blocked' }) === 'content_rejected',
  )
  assert(
    'image failure: missing key is not configured, 401 is unauthorized, 5xx and network errors are upstream',
    classifyImageGenerationFailure({ detail: 'Custom image API key is not configured.' }) === 'not_configured' &&
      classifyImageGenerationFailure({ detail: 'API request failed (HTTP 401): {"error":{"code":"AuthenticationError"}}', status: 401 }) === 'unauthorized' &&
      classifyImageGenerationFailure({ detail: 'API request failed (HTTP 503): upstream busy' }) === 'upstream' &&
      classifyImageGenerationFailure({ detail: 'fetch failed' }) === 'upstream',
  )
  const formatted = formatImageGenerationFailure({ detail: gateway402, status: 402, source: 'BytePlus image API' }).output
  assert(
    'image failure: 402 message tells the user to top up and names the source',
    formatted.startsWith('generate_image failed: insufficient balance') &&
      formatted.includes('top up') &&
      formatted.includes('BytePlus image API failed (HTTP 402): insufficient_balance: Balance too low') &&
      formatted.includes('Do not substitute a downloaded web image'),
    formatted,
  )
}

{
  // A failed image API call returns ok:false with the right message and never
  // falls back to a web search or downloads anything else.
  const tmpDir = path.join(os.tmpdir(), `artemis-generate-image-honest-failure-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  await configureBytePlusImageProfile(tmpDir, 'https://ark.ap-southeast.bytepluses.com/api/v3')
  try {
    const balance = await withMockedFetch(
      () => new Response('{"error":{"code":"insufficient_balance","message":"Balance too low: please top up","type":"insufficient_balance"}}', { status: 402 }),
      async (calls) => ({
        result: await executeGenerateImage({ type: 'generate_image', prompt: 'a red fox in snow, watercolor' } as any, { cwd: tmpDir } as any),
        calls: [...calls],
      }),
    )
    assert(
      'generate_image: HTTP 402 returns ok:false with a top-up message',
      balance.result.ok === false &&
        String(balance.result.output).startsWith('generate_image failed: insufficient balance') &&
        String(balance.result.output).includes('top up'),
      String(balance.result.output),
    )
    assert(
      'generate_image: HTTP 402 makes exactly one image API call and no web search',
      balance.calls.length === 1 &&
        balance.calls[0]!.url === 'https://ark.ap-southeast.bytepluses.com/api/v3/images/generations' &&
        !balance.calls.some((call) => /bing|google|duckduckgo|search/i.test(call.url)),
      JSON.stringify(balance.calls.map((call) => call.url)),
    )

    const generic = await withMockedFetch(
      () => new Response('<html>Bad Gateway</html>', { status: 502 }),
      async (calls) => ({
        result: await executeGenerateImage({ type: 'generate_image', prompt: 'logo with the text "ACME"' } as any, { cwd: tmpDir } as any),
        calls: [...calls],
      }),
    )
    assert(
      'generate_image: a generic upstream error returns ok:false with a retry message and no web search',
      generic.result.ok === false &&
        String(generic.result.output).startsWith('generate_image failed: the image service or network failed') &&
        String(generic.result.output).includes('HTTP 502') &&
        generic.calls.length === 1 &&
        generic.calls.every((call) => call.url.endsWith('/images/generations')),
      String(generic.result.output),
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

{
  // A ModelArk-compatible base URL on another host (the platform gateway) is
  // kept, so its key is never sent to the public BytePlus host.
  assert(
    'ModelArk base URL: gateway and Volcengine hosts are kept; BytePlus paths still normalize',
    normalizeModelArkMediaBaseUrl('https://gw.example.test/v1') === 'https://gw.example.test/v1' &&
      normalizeModelArkMediaBaseUrl('https://gw.example.test/v1/') === 'https://gw.example.test/v1' &&
      normalizeModelArkMediaBaseUrl('https://gw.example.test/v1/images/generations') === 'https://gw.example.test/v1' &&
      normalizeModelArkMediaBaseUrl('https://ark.cn-beijing.volces.com/api/v3') === 'https://ark.cn-beijing.volces.com/api/v3' &&
      normalizeModelArkMediaBaseUrl('https://ark.ap-southeast.bytepluses.com/api/v3/images/generations') === 'https://ark.ap-southeast.bytepluses.com/api/v3' &&
      normalizeModelArkMediaBaseUrl(undefined) === 'https://ark.ap-southeast.bytepluses.com/api/v3' &&
      normalizeModelArkMediaBaseUrl('mock://local') === 'https://ark.ap-southeast.bytepluses.com/api/v3',
  )
  const throwsMisconfigured = (url: string): boolean => {
    try {
      normalizeModelArkMediaBaseUrl(url)
      return false
    } catch (error) {
      return /Visual API base URL is misconfigured: .*plain http/.test(String(error))
    }
  }
  assert(
    'ModelArk base URL: volces.com normalizes like bytepluses.com; gateway query strings are kept',
    normalizeModelArkMediaBaseUrl('https://ark.cn-beijing.volces.com/api/v3/images/generations') === 'https://ark.cn-beijing.volces.com/api/v3' &&
      normalizeModelArkMediaBaseUrl('https://ark.cn-beijing.volces.com/') === 'https://ark.cn-beijing.volces.com/api/v3' &&
      normalizeModelArkMediaBaseUrl('http://ark.cn-beijing.volces.com/api/v3') === 'https://ark.cn-beijing.volces.com/api/v3' &&
      normalizeModelArkMediaBaseUrl('https://gw.example.test/v1?tenant=a') === 'https://gw.example.test/v1?tenant=a' &&
      modelArkEndpoint('https://gw.example.test/v1?tenant=a', 'images/generations') === 'https://gw.example.test/v1/images/generations?tenant=a' &&
      modelArkEndpoint('https://ark.ap-southeast.bytepluses.com/api/v3', 'contents/generations/tasks') === 'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks',
  )
  assert(
    'ModelArk base URL: plain http only for loopback; a lookalike host is not treated as BytePlus',
    normalizeModelArkMediaBaseUrl('http://localhost:8080/v1') === 'http://localhost:8080/v1' &&
      normalizeModelArkMediaBaseUrl('http://127.0.0.1:8080/v1') === 'http://127.0.0.1:8080/v1' &&
      normalizeModelArkMediaBaseUrl('http://[::1]:8080/v1') === 'http://[::1]:8080/v1' &&
      throwsMisconfigured('http://gw.example.test/v1') &&
      throwsMisconfigured('http://10.0.0.5:8080/v1') &&
      normalizeModelArkMediaBaseUrl('https://bytepluses.com.evil.test/api/v3/x') === 'https://bytepluses.com.evil.test/api/v3/x',
  )
  const tmpDir = path.join(os.tmpdir(), `artemis-generate-image-gateway-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  await configureBytePlusImageProfile(tmpDir, 'https://gw.example.test/v1')
  try {
    const calls = await withMockedFetch(
      () => new Response('{"error":{"code":"insufficient_balance","message":"Balance too low: please top up"}}', { status: 402 }),
      async (seen) => {
        await executeGenerateImage({ type: 'generate_image', prompt: 'x' } as any, { cwd: tmpDir } as any)
        return [...seen]
      },
    )
    assert(
      'generate_image: a byteplus profile pointed at the platform gateway calls the gateway',
      calls.length === 1 && calls[0]!.url === 'https://gw.example.test/v1/images/generations',
      JSON.stringify(calls.map((call) => call.url)),
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

{
  // Downloads of provider-returned URLs refuse private, link-local and
  // loopback targets, also after redirects; loopback only for a loopback base URL.
  assert(
    'asset download: private, link-local, loopback and mapped addresses are non-public',
    isNonPublicAddress('10.1.2.3') &&
      isNonPublicAddress('172.20.0.1') &&
      isNonPublicAddress('192.168.1.1') &&
      isNonPublicAddress('169.254.169.254') &&
      isNonPublicAddress('127.0.0.1') &&
      isNonPublicAddress('::1') &&
      isNonPublicAddress('fe80::1') &&
      isNonPublicAddress('fd00::1') &&
      isNonPublicAddress('::ffff:10.0.0.1') &&
      !isNonPublicAddress('93.184.216.34') &&
      !isNonPublicAddress('2606:2800:220:1:248:1893:25c8:1946') &&
      !isNonPublicAddress('127.0.0.1', { allowLoopback: true }) &&
      isNonPublicAddress('10.0.0.1', { allowLoopback: true }),
  )
  const refused = async (url: string, respond: (u: string) => Response, allowLoopback = false) =>
    withMockedFetch(respond, async (calls) => {
      try {
        await downloadProviderAsset(url, { timeoutMs: 5_000, allowLoopback })
        return { refused: false, calls: [...calls], message: '' }
      } catch (error) {
        return { refused: true, calls: [...calls], message: String(error) }
      }
    })
  const metadata = await refused('http://169.254.169.254/latest/meta-data/', () => new Response('secret'))
  assert(
    'asset download: a cloud-metadata URL is refused without being fetched',
    metadata.refused && metadata.calls.length === 0 && /private, link-local or loopback/.test(metadata.message),
    metadata.message,
  )
  const redirected = await refused('https://93.184.216.34/a.png', (u) =>
    u.startsWith('https://93.184.216.34')
      ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9000/admin' } })
      : new Response('internal'),
  )
  assert(
    'asset download: a redirect to loopback is refused before it is followed',
    redirected.refused && redirected.calls.length === 1 && /127\.0\.0\.1/.test(redirected.message),
    redirected.message,
  )
  const loopbackAllowed = await refused('http://127.0.0.1:9000/a.png', () => new Response(PNG_1X1), true)
  assert(
    'asset download: loopback is allowed when the provider base URL is loopback',
    !loopbackAllowed.refused && loopbackAllowed.calls.length === 1,
    loopbackAllowed.message,
  )
}

{
  // DNS rebinding: the address is checked inside the socket's lookup, so a
  // host that resolves public for the early check and private at connect time
  // is still refused. Uses the real node:http transport and a local server.
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(PNG_1X1)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  const lookups: string[] = []
  setAssetDownloadTransportForTests(undefined)
  const attempt = async (url: string, allowLoopback: boolean) => {
    try {
      const body = await downloadProviderAsset(url, { timeoutMs: 5_000, allowLoopback })
      return { ok: true, body, message: '' }
    } catch (error) {
      return { ok: false, body: undefined, message: String(error) }
    }
  }
  try {
    let rebindCalls = 0
    setAssetDownloadResolverForTests(async (hostname) => {
      lookups.push(hostname)
      if (hostname === 'assets.rebind.test') {
        rebindCalls += 1
        return [{ address: rebindCalls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]
      }
      if (hostname === 'assets.loopback.test') return [{ address: '127.0.0.1', family: 4 }]
      return testAssetResolver(hostname)
    })
    const rebound = await attempt(`http://assets.rebind.test:${port}/a.png`, false)
    assert(
      'asset download: a host that rebinds to loopback at connect time is refused and never reached',
      !rebound.ok && rebindCalls === 2 && /127\.0\.0\.1/.test(rebound.message) && hits.length === 0,
      `${rebound.message} lookups=${rebindCalls} hits=${hits.length}`,
    )
    const viaLookup = await attempt(`http://assets.loopback.test:${port}/a.png`, true)
    assert(
      'asset download: the connection uses the guarded lookup (loopback base URL allowed)',
      viaLookup.ok && Buffer.compare(viaLookup.body!, PNG_1X1) === 0 && hits.length === 1 &&
        lookups.filter((name) => name === 'assets.loopback.test').length === 2,
      viaLookup.message,
    )
    const redirect = await attempt(`http://127.0.0.1:${port}/redirect`, true)
    assert(
      'asset download: the real transport checks every redirect hop',
      !redirect.ok && /169\.254\.169\.254/.test(redirect.message) && hits.length === 2 && hits[1] === '/redirect',
      redirect.message,
    )
  } finally {
    setAssetDownloadTransportForTests(fetchAssetTransport)
    setAssetDownloadResolverForTests(testAssetResolver)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

{
  // Saga soundtrack URLs can come from content the agent read: same guard.
  const workDir = path.join(os.tmpdir(), `artemis-soundtrack-guard-${Date.now()}`)
  fs.mkdirSync(workDir, { recursive: true })
  const AUDIO = Buffer.from('ID3fake-mp3-bytes')
  const soundtrack = async (url: string) => {
    const calls: string[] = []
    const result = await withMockedFetch(
      (requested) => {
        calls.push(requested)
        if (requested === 'https://music.test/redirect.mp3') {
          return new Response(null, { status: 302, headers: { location: 'http://10.0.0.8/internal.mp3' } })
        }
        return new Response(AUDIO, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
      },
      async () => {
        try {
          return { path: await resolveSoundtrackPath({ url }, workDir), message: '' }
        } catch (error) {
          return { path: undefined, message: String(error) }
        }
      },
    )
    return { ...result, calls }
  }
  try {
    const ok = await soundtrack('https://music.test/song.mp3')
    assert(
      'saga soundtrack: a public audio URL downloads through the guard',
      ok.path === path.join(workDir, 'soundtrack.mp3') && Buffer.compare(fs.readFileSync(ok.path), AUDIO) === 0,
      ok.message,
    )
    const local = await soundtrack('http://127.0.0.1:8080/admin/export.mp3')
    const metadata = await soundtrack('http://169.254.169.254/latest/meta-data/x.wav')
    assert(
      'saga soundtrack: loopback and metadata URLs are refused without a request',
      !local.path && /private, link-local or loopback/.test(local.message) && local.calls.length === 0 &&
        !metadata.path && /private, link-local or loopback/.test(metadata.message) && metadata.calls.length === 0,
      `${local.message} | ${metadata.message}`,
    )
    const redirected = await soundtrack('https://music.test/redirect.mp3')
    assert(
      'saga soundtrack: a redirect to a private address is refused',
      !redirected.path && /10\.0\.0\.8/.test(redirected.message) && redirected.calls.length === 1,
      redirected.message,
    )
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

{
  // Video results go through the same guard, on the provider path and the
  // legacy ARK_API_KEY path.
  const METADATA_VIDEO = 'http://169.254.169.254/latest/meta-data/out.mp4'
  const videoMock = (calls: string[]) => (url: string) => {
    calls.push(url)
    if (url.endsWith('/contents/generations/tasks')) return new Response('{"id":"task-guard"}', { status: 200 })
    if (url.endsWith('/contents/generations/tasks/task-guard')) {
      return new Response(JSON.stringify({ status: 'succeeded', content: { video_url: METADATA_VIDEO } }), { status: 200 })
    }
    return new Response('should not be fetched', { status: 200 })
  }
  const root = path.join(os.tmpdir(), `artemis-video-guard-${Date.now()}`)
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  const savedEnv = { HOME: process.env.HOME, ARTEMIS_HOME: process.env.ARTEMIS_HOME, ARK_API_KEY: process.env.ARK_API_KEY }
  process.env.HOME = path.join(root, 'home')
  process.env.ARTEMIS_HOME = path.join(root, 'artemis-home')
  delete process.env.ARK_API_KEY
  fs.mkdirSync(process.env.HOME, { recursive: true })
  try {
    await configureBytePlusVideoProfile(workspace, 'seedance-1-5-pro-251215')
    const providerCalls: string[] = []
    const viaProvider = await withMockedFetch(videoMock(providerCalls), async () =>
      executeGenerateVideo(
        { type: 'generate_video', prompt: 'a short wave clip', duration: 5, maxPolls: 1, pollIntervalMs: 1000 } as any,
        { cwd: workspace } as any,
      ),
    )
    assert(
      'generate_video: the BytePlus provider refuses a private video result URL',
      viaProvider.ok === false &&
        /private, link-local or loopback/.test(String(viaProvider.output)) &&
        !providerCalls.includes(METADATA_VIDEO),
      String(viaProvider.output),
    )

    fs.rmSync(process.env.ARTEMIS_HOME!, { recursive: true, force: true })
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.mkdirSync(workspace, { recursive: true })
    process.env.ARK_API_KEY = 'ark-test-key'
    const legacyCalls: string[] = []
    const viaLegacy = await withMockedFetch(videoMock(legacyCalls), async () =>
      executeGenerateVideo(
        { type: 'generate_video', prompt: 'a short wave clip', duration: 5, maxPolls: 1, pollIntervalMs: 1000 } as any,
        { cwd: workspace } as any,
      ),
    )
    assert(
      'generate_video: the legacy ARK_API_KEY path refuses a private video result URL',
      viaLegacy.ok === false &&
        /private, link-local or loopback/.test(String(viaLegacy.output)) &&
        legacyCalls.some((url) => url.startsWith('https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks')) &&
        !legacyCalls.includes(METADATA_VIDEO),
      String(viaLegacy.output),
    )
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}

{
  // M1/M2 on the configured-provider path, and the legacy ARK_API_KEY path.
  const PUBLIC_ASSET = 'https://93.184.216.34/generated/a.png'
  const root = path.join(os.tmpdir(), `artemis-image-review-${Date.now()}`)
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'ref.png'), PNG_1X1)
  const savedEnv = { HOME: process.env.HOME, ARTEMIS_HOME: process.env.ARTEMIS_HOME, ARK_API_KEY: process.env.ARK_API_KEY }
  process.env.HOME = path.join(root, 'home')
  process.env.ARTEMIS_HOME = path.join(root, 'artemis-home')
  delete process.env.ARK_API_KEY
  fs.mkdirSync(process.env.HOME, { recursive: true })
  const context = { cwd: workspace } as any
  const generatedThenDownload = (downloadStatus: number) => (url: string) =>
    url.endsWith('/images/generations')
      ? new Response(JSON.stringify({ data: [{ url: PUBLIC_ASSET }] }), { status: 200 })
      : downloadStatus === 200
        ? new Response(PNG_1X1, { status: 200 })
        : new Response('AccessDenied', { status: downloadStatus })
  try {
    await configureBytePlusImageProfile(workspace, 'https://ark.ap-southeast.bytepluses.com/api/v3')

    const downloadFailed = await withMockedFetch(generatedThenDownload(403), async (calls) => ({
      result: await executeGenerateImage({ type: 'generate_image', prompt: 'a lighthouse at dusk' } as any, context),
      calls: [...calls],
    }))
    assert(
      'generate_image: a 403 on the result download is download_failed, not rejected credentials',
      downloadFailed.result.ok === false &&
        String(downloadFailed.result.output).startsWith('generate_image failed: the image was generated') &&
        !String(downloadFailed.result.output).includes('rejected the credentials') &&
        downloadFailed.calls.length === 2,
      String(downloadFailed.result.output),
    )

    let generation = 0
    const partial = await withMockedFetch(
      (url) => {
        if (url.endsWith('/images/generations')) {
          generation += 1
          return generation === 1
            ? new Response(JSON.stringify({ data: [{ url: PUBLIC_ASSET }] }), { status: 200 })
            : new Response('{"error":{"code":"insufficient_balance","message":"Balance too low: please top up"}}', { status: 402 })
        }
        return new Response(PNG_1X1, { status: 200 })
      },
      async () => executeGenerateImage({ type: 'generate_image', prompt: 'two lighthouses', count: 2, outputPath: 'out/light.png' } as any, context),
    )
    const partialOutput = String(partial.output)
    assert(
      'generate_image: count 2 with the second failing returns the saved image plus the reason',
      partial.ok === true &&
        partialOutput.startsWith('Generated 1 of 2 requested image(s) via configured visual API:') &&
        partialOutput.includes(path.join('out', 'light-1.png')) &&
        partialOutput.includes('The other 1 image(s) failed: insufficient balance') &&
        !partialOutput.includes('No image was created') &&
        fs.existsSync(path.join(workspace, 'out', 'light-1.png')),
      partialOutput,
    )

    // Legacy path: no visual profile, credentials from ARK_API_KEY. With
    // ARTEMIS_HOME set the provider store lives there, so clear it too.
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(process.env.ARTEMIS_HOME!, { recursive: true, force: true })
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'ref.png'), PNG_1X1)
    process.env.ARK_API_KEY = 'ark-test-key'
    const legacy = await withMockedFetch(
      () => new Response('{"error":{"code":"insufficient_balance","message":"Balance too low: please top up"}}', { status: 402 }),
      async (calls) => ({
        result: await executeGenerateImage(
          { type: 'generate_image', prompt: 'same style, but a cat', referenceImages: ['ref.png'] } as any,
          context,
        ),
        calls: [...calls],
      }),
    )
    const legacyBody = JSON.parse(legacy.calls[0]?.body ?? '{}')
    assert(
      'generate_image legacy ARK_API_KEY path: sends image as a data URI and maps 402 to top up',
      legacy.calls.length === 1 &&
        legacy.calls[0]!.url === 'https://ark.ap-southeast.bytepluses.com/api/v3/images/generations' &&
        legacyBody.image === `data:image/png;base64,${PNG_1X1.toString('base64')}` &&
        legacy.result.ok === false &&
        String(legacy.result.output).startsWith('generate_image failed: insufficient balance') &&
        String(legacy.result.output).includes('BytePlus image API failed (HTTP 402)'),
      JSON.stringify({ calls: legacy.calls.map((call) => call.url), output: legacy.result.output }),
    )
    const legacyDownload = await withMockedFetch(generatedThenDownload(403), async () =>
      executeGenerateImage({ type: 'generate_image', prompt: 'x' } as any, context),
    )
    assert(
      'generate_image legacy ARK_API_KEY path: a 403 download is download_failed',
      legacyDownload.ok === false &&
        String(legacyDownload.output).startsWith('generate_image failed: the image was generated'),
      String(legacyDownload.output),
    )
    const legacyTooLarge = await withMockedFetch(
      () => new Response('{"error":{"code":"payload_too_large","message":"Request body too large"}}', { status: 413 }),
      async () => executeGenerateImage({ type: 'generate_image', prompt: 'x', referenceImages: ['ref.png'] } as any, context),
    )
    assert(
      'generate_image legacy ARK_API_KEY path: 413 with references says to shrink them',
      legacyTooLarge.ok === false && String(legacyTooLarge.output).includes('fewer reference images or smaller/compressed copies'),
      String(legacyTooLarge.output),
    )
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}

{
  // Reference images: parsing, containment, data URIs, unsupported providers.
  assert(
    'referenceImages: arrays, JSON strings and single strings normalize, de-duplicated',
    eq(normalizeReferenceImagesArg([' a.png ', 'a.png', '', 'https://x.test/b.jpg']), ['a.png', 'https://x.test/b.jpg']) &&
      eq(normalizeReferenceImagesArg('["a.png","b.png"]'), ['a.png', 'b.png']) &&
      eq(normalizeReferenceImagesArg('a.png'), ['a.png']) &&
      eq(normalizeReferenceImagesArg(undefined), []),
  )
  assert(
    'referenceImages: image types are sniffed from bytes, not extensions',
    sniffImageMimeType(PNG_1X1) === 'image/png' &&
      sniffImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])) === 'image/jpeg' &&
      sniffImageMimeType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'binary')) === 'image/webp' &&
      sniffImageMimeType(Buffer.from('API_KEY=secret\n')) === undefined,
  )
  assert(
    'referenceImages: one shared sniffer; view_image still sees only model formats',
    sniffImageMimeType(BMP_HEADER) === 'image/bmp' &&
      sniffAnyImageType(BMP_HEADER) === 'image/bmp' &&
      sniffImageType(BMP_HEADER) === undefined &&
      sniffImageType(PNG_1X1) === 'image/png',
  )
  assert(
    'referenceImages: BMP needs a plausible header, not just "BM"',
    sniffAnyImageType(Buffer.from('BM is how this text file starts')) === undefined &&
      sniffAnyImageType(Buffer.concat([Buffer.from('BM'), Buffer.alloc(16)])) === undefined &&
      sniffAnyImageType(BMP_HEADER) === 'image/bmp',
  )

  const recovered = parseAssistantEnvelopeForSmoke(`
<tool_calls>
<call name="generate_image">{"prompt":"same style, but a cat","reference_images":["uploads/style.png"]}</call>
</tool_calls>
`)
  const looseAction = (recovered.actions ?? [])[0] as any
  assert(
    'referenceImages: text tool-call recovery parses reference_images',
    looseAction?.type === 'generate_image' && eq(looseAction.referenceImages, ['uploads/style.png']),
    JSON.stringify(recovered.actions),
  )
  const nativeMapped = mapProviderNativeToolCallToAction({
    callId: 'img-ref',
    name: 'generate_image',
    arguments: JSON.stringify({ prompt: 'same style, but a cat', referenceImages: ['uploads/style.png', 'https://x.test/a.png'] }),
  })
  assert(
    'referenceImages: native tool call keeps referenceImages',
    nativeMapped.ok && eq((nativeMapped.action as any).referenceImages, ['uploads/style.png', 'https://x.test/a.png']),
    JSON.stringify(nativeMapped),
  )
  assert(
    'referenceImages: validator rejects more than 14 entries and non-string entries',
    validateToolAction({ type: 'generate_image', prompt: 'x', referenceImages: Array.from({ length: 15 }, (_, i) => `r${i}.png`) }).length > 0 &&
      validateToolAction({ type: 'generate_image', prompt: 'x', referenceImages: [42] }).length > 0 &&
      validateToolAction({ type: 'generate_image', prompt: 'x', referenceImages: ['a.png'] }).length === 0,
  )
  const imageSchema = providerNativeTools.find((tool) => tool.name === 'generate_image')?.parameters as any
  assert(
    'referenceImages: native schema exposes an array capped at 14',
    imageSchema?.properties?.referenceImages?.type === 'array' && imageSchema.properties.referenceImages.maxItems === 14,
  )

  const root = path.join(os.tmpdir(), `artemis-image-refs-${Date.now()}`)
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(path.join(workspace, 'uploads'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'uploads', 'style.png'), PNG_1X1)
  fs.writeFileSync(path.join(workspace, 'uploads', 'notes.png'), 'API_KEY=not-an-image\n')
  fs.writeFileSync(path.join(root, 'outside.png'), PNG_1X1)
  fs.mkdirSync(path.join(workspace, '.ssh'), { recursive: true })
  fs.writeFileSync(path.join(workspace, '.ssh', 'id.png'), PNG_1X1)
  fs.writeFileSync(path.join(workspace, '.env.png'), PNG_1X1)
  const context = { cwd: workspace } as any
  const rejects = async (raw: unknown, pattern: RegExp): Promise<boolean> => {
    try {
      await resolveReferenceImages(raw, context)
      return false
    } catch (error) {
      return pattern.test(error instanceof Error ? error.message : String(error))
    }
  }
  try {
    const resolved = await resolveReferenceImages(['uploads/style.png', 'https://x.test/a.png'], context)
    assert(
      'referenceImages: workspace files become data URIs and URLs pass through',
      resolved.length === 2 &&
        resolved[0] === `data:image/png;base64,${PNG_1X1.toString('base64')}` &&
        resolved[1] === 'https://x.test/a.png',
      JSON.stringify(resolved.map((entry) => entry.slice(0, 40))),
    )
    assert(
      'referenceImages: paths outside the workspace are refused',
      await rejects(['../outside.png'], /escapes|declined/i) &&
        await rejects([path.join(root, 'outside.png')], /escapes|declined/i),
    )
    assert(
      'referenceImages: protected paths inside the workspace (.ssh dir, .env file) are refused by ensureNotSensitivePath',
      await rejects(['.ssh/id.png'], /Access denied: \.ssh\/id\.png is in a protected directory/) &&
        await rejects(['.env.png'], /Access denied: \.env\.png is in a protected directory/),
    )
    const fullAccess = await resolveReferenceImages(['.ssh/id.png'], { ...context, permissionMode: 'full-access' })
    assert(
      'referenceImages: full-access mode skips the protected-path check, like read_file',
      fullAccess.length === 1 && fullAccess[0]!.startsWith('data:image/png;base64,'),
    )
    assert(
      'referenceImages: non-images, missing files and other schemes are refused',
      await rejects(['uploads/notes.png'], /not a supported image/) &&
        await rejects(['uploads/missing.png'], /not found/) &&
        await rejects(['file:///etc/passwd'], /not supported/),
    )
    assert(
      'referenceImages: more than 14, or references plus outputs over 15, are refused',
      await rejects(Array.from({ length: 15 }, (_, i) => `https://x.test/${i}.png`), /at most 14/) &&
        await (async () => {
          try {
            await resolveReferenceImages(Array.from({ length: 13 }, (_, i) => `https://x.test/${i}.png`), context, { outputCount: 3 })
            return false
          } catch (error) {
            return /limit of 15/.test(String(error))
          }
        })(),
    )

    // The request body carries the reference as a ModelArk `image` data URI.
    await configureBytePlusImageProfile(workspace, 'https://ark.ap-southeast.bytepluses.com/api/v3')
    const sent = await withMockedFetch(
      () => new Response('{"error":{"code":"insufficient_balance","message":"Balance too low: please top up"}}', { status: 402 }),
      async (calls) => {
        const result = await executeGenerateImage(
          { type: 'generate_image', prompt: 'same style, but a cat', referenceImages: ['uploads/style.png'] } as any,
          context,
        )
        return { result, calls: [...calls] }
      },
    )
    const sentBody = JSON.parse(sent.calls[0]?.body ?? '{}')
    assert(
      'referenceImages: BytePlus request body has image as a data URI',
      sent.calls.length === 1 &&
        sentBody.image === `data:image/png;base64,${PNG_1X1.toString('base64')}` &&
        sentBody.prompt === 'same style, but a cat' &&
        sent.result.ok === false,
      JSON.stringify({ keys: Object.keys(sentBody), output: sent.result.output }),
    )
    const sentTwo = await withMockedFetch(
      () => new Response('{"error":{"message":"boom"}}', { status: 500 }),
      async (calls) => {
        await executeGenerateImage(
          { type: 'generate_image', prompt: 'blend these', referenceImages: ['uploads/style.png', 'https://x.test/a.png'] } as any,
          context,
        )
        return [...calls]
      },
    )
    const sentTwoBody = JSON.parse(sentTwo[0]?.body ?? '{}')
    assert(
      'referenceImages: several references are sent as an image array',
      Array.isArray(sentTwoBody.image) && sentTwoBody.image.length === 2 && sentTwoBody.image[1] === 'https://x.test/a.png',
    )

    // Providers without reference support fail clearly instead of ignoring them.
    for (const provider of ['openai', 'mock'] as const) {
      const store = new ProviderStore(workspace)
      const data = await store.load()
      data.visualProfile!.image = {
        ...data.visualProfile!.image,
        provider,
        apiKey: 'test-key',
        baseUrl: provider === 'openai' ? 'https://api.openai.com/v1' : 'mock://local',
        model: provider === 'openai' ? 'gpt-image-2' : 'mock-image',
      }
      await store.save(data)
      const unsupported = await withMockedFetch(
        () => new Response('{}', { status: 500 }),
        async (calls) => ({
          result: await executeGenerateImage(
            { type: 'generate_image', prompt: 'same style, but a cat', referenceImages: ['uploads/style.png'] } as any,
            context,
          ),
          calls: [...calls],
        }),
      )
      assert(
        `referenceImages: ${provider} provider fails clearly without calling the API`,
        unsupported.result.ok === false &&
          String(unsupported.result.output).includes('reference images are not supported') &&
          unsupported.calls.length === 0,
        String(unsupported.result.output),
      )
    }

    // A text-to-image-only Seedream model refuses references.
    const t2i = new BytePlusProvider(
      {
        enabled: true,
        image: { provider: 'byteplus', apiKey: 'k', baseUrl: '', model: 'seedream-3-0-t2i-250415', defaultParams: { size: '2K', quality: 'standard', style: 'realistic', watermark: false } },
        video: { enabled: false, provider: 'byteplus', apiKey: '', baseUrl: '', model: '', defaultParams: { duration: '5s', resolution: '720p', quality: 'standard', style: 'realistic', format: 'mp4', framerate: '24fps', watermark: false } },
      } as any,
      'image',
    )
    const t2iResult = await withMockedFetch(
      () => new Response('{}', { status: 500 }),
      async (calls) => ({ result: await t2i.generateImage({ prompt: 'x', referenceImages: ['https://x.test/a.png'] }), calls: [...calls] }),
    )
    assert(
      'referenceImages: Seedream 3.0 text-to-image model refuses references before calling the API',
      !t2iResult.result.success && /text-to-image only/.test(t2iResult.result.error ?? '') && t2iResult.calls.length === 0,
      t2iResult.result.error,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

{
  // No visual API configured: the policy says so and how to configure it, and
  // does not send the model to web-search images.
  assert(
    'visual policy: not-configured policy names /visual and does not suggest web-search assets',
    VISUAL_NOT_CONFIGURED_POLICY.includes('not configured') &&
      VISUAL_NOT_CONFIGURED_POLICY.includes('/visual') &&
      VISUAL_NOT_CONFIGURED_POLICY.includes('artemis setup visual') &&
      VISUAL_NOT_CONFIGURED_POLICY.includes('Do not substitute web-search or downloaded images') &&
      !/use web-search assets/i.test(VISUAL_NOT_CONFIGURED_POLICY),
  )
}

{
  // Prompt guidance lives in the tool description, not in a rewrite of the prompt.
  const imageTool = providerNativeTools.find((tool) => tool.name === 'generate_image')
  const description = imageTool?.description ?? ''
  assert(
    'generate_image description: carries the Seedream prompt guidance',
    description === GENERATE_IMAGE_DESCRIPTION &&
      /natural sentences for subject, action and setting/.test(description) &&
      /style the user asked for/.test(description) &&
      /double quotes/.test(description) &&
      /`size`, not in the prompt/.test(description) &&
      /Keep the user's language/.test(description) &&
      /`referenceImages`/.test(description) &&
      /Look at it first with view_image whenever that tool is available/.test(description) &&
      !/if you can/i.test(description) &&
      /ask one short question only/.test(description) &&
      /never substitute a web image/.test(description),
    description,
  )
  assert(
    'generate_image description: stays short and adds no fixed photo keywords',
    description.length < 1400 && !/Canon|f\/1\.8|photorealistic, /i.test(description),
    `length=${description.length}`,
  )
}

async function configureMockImageProfile(cwd: string): Promise<void> {
  const store = new ProviderStore(cwd)
  const data = await store.load()
  data.visualProfile = {
    enabled: true,
    image: {
      provider: 'mock',
      apiKey: 'test-key',
      baseUrl: 'mock://local',
      model: 'mock-image',
      defaultParams: {
        size: '720p',
        quality: 'standard',
        style: 'realistic',
        watermark: false,
      },
    },
    video: {
      enabled: false,
      provider: 'mock',
      apiKey: '',
      baseUrl: 'mock://local',
      model: 'mock-video',
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
  }
  await store.save(data)
}

{
  const negativePrompts = [
    '我在查视觉系统为什么误触发菜单，不要生成任何图片。',
    '复制素材说明过来，检查里面的配置字段。',
    '这个功能需要视觉系统支持，但现在只是排查代码。',
    '这个页面用到素材管理逻辑，帮我看实现。',
  ]
  for (const prompt of negativePrompts) {
    const need = detectVisualGenerationNeed(prompt)
    assert(`visual intent: no false positive for ${prompt}`, !need.image && !need.video)
  }

  const imageNeed = detectVisualGenerationNeed('请生成一张产品海报图片。')
  assert('visual intent: explicit Chinese image generation is detected', imageNeed.image && !imageNeed.video)

  const videoNeed = detectVisualGenerationNeed('Create a short product video clip for the landing page.')
  assert('visual intent: explicit English video generation is detected', videoNeed.video)

  const googleVision = resolveVisionDescribeRouteForTest({ provider: 'google' })
  assert(
    'visual provider routing: Google vision-describe uses Gemini model, not GPT fallback',
    googleVision.protocol === 'gemini-generate-content' && googleVision.model === 'gemini-2.5-flash',
    JSON.stringify(googleVision),
  )

  const googleExplicitImageModel = resolveVisionDescribeRouteForTest({ provider: 'google', explicitVisionModel: 'gemini-3-pro-image-preview' })
  assert(
    'visual provider routing: Google image-generation model is not reused for vision-describe',
    googleExplicitImageModel.protocol === 'gemini-generate-content' && googleExplicitImageModel.model === 'gemini-2.5-flash',
    JSON.stringify(googleExplicitImageModel),
  )

  const openaiVision = resolveVisionDescribeRouteForTest({ provider: 'openai' })
  assert(
    'visual provider routing: OpenAI vision-describe uses chat completions fallback',
    openaiVision.protocol === 'openai-chat-completions' && openaiVision.model === 'gpt-5.5',
    JSON.stringify(openaiVision),
  )

  const byteplusVision = resolveVisionDescribeRouteForTest({ provider: 'byteplus' })
  assert(
    'visual provider routing: BytePlus image-generation endpoint is not reused for vision-describe',
    byteplusVision.protocol === 'main-profile-fallback',
    JSON.stringify(byteplusVision),
  )

  assert(
    'custom visual base URL: image endpoint paste is normalized to API root',
    normalizeCustomVisualBaseUrlForTest('https://relay.example/v1/images/generations', 'image') === 'https://relay.example/v1',
  )
  assert(
    'custom visual base URL: video endpoint paste is normalized to API root',
    normalizeCustomVisualBaseUrlForTest('https://relay.example/v1/videos/generations', 'video') === 'https://relay.example/v1',
  )

  const blockingCamera = `
    {"story":"[CAMERA: locked-off tripod, no camera movement whatsoever]"}
  `
  assert(
    'saga camera routing: locked camera story is treated as lock-off',
    blockingCamera.includes('locked-off tripod'),
  )
}

{
  // The agent looks at an image mid-run: view_image attaches it to the next request.
  const tmpDir = path.join(os.tmpdir(), `artemis-view-image-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'screenshot.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'view image smoke' })
  await store.save(session)
  const seen: (number | undefined)[] = []
  let calls = 0
  const provider: ChatProvider = {
    supportsImages: true,
    async complete(_messages, options): Promise<ProviderResponse> {
      calls += 1
      seen.push(options?.imageAttachments?.length)
      if (calls === 1) {
        return { text: JSON.stringify({ reply: 'Let me look.', done: false, actions: [{ type: 'view_image', path: 'screenshot.png' }] }), raw: null }
      }
      return { text: JSON.stringify({ reply: 'It is a login page.', done: true }), raw: null }
    },
  }
  await runAgent(session, 'What does the screenshot show?', {
    cwd: tmpDir,
    provider,
    sessionStore: store,
    permissionManager: new PermissionManager('accept-all', false),
    maxTurns: 3,
    profile: 'main',
  })
  assert('view_image: the image reaches the request after the tool call, and only that one', seen[0] === undefined && seen[1] === 1 && seen.slice(2).every((n) => n === undefined), JSON.stringify(seen))
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  // A run that ends right after view_image (here: out of turns) must not hand
  // the image to the next run on the same session, as a long-lived bridge would.
  const tmpDir = path.join(os.tmpdir(), `artemis-view-image-leak-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'screenshot.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'view image leak smoke' })
  await store.save(session)
  const seen: (number | undefined)[] = []
  const provider: ChatProvider = {
    supportsImages: true,
    async complete(_messages, options): Promise<ProviderResponse> {
      seen.push(options?.imageAttachments?.length)
      return { text: JSON.stringify({ reply: 'Let me look.', done: false, actions: [{ type: 'view_image', path: 'screenshot.png' }] }), raw: null }
    },
  }
  const runOnce = (prompt: string) => runAgent(session, prompt, {
    cwd: tmpDir,
    provider,
    sessionStore: store,
    permissionManager: new PermissionManager('accept-all', false),
    maxTurns: 1,
    profile: 'main',
  })
  await runOnce('Look at the screenshot.')
  await runOnce('Something unrelated.')
  assert(
    'view_image: an image queued in the last turn of a run does not reach the next run on the same session',
    seen.length === 2 && seen[0] === undefined && seen[1] === undefined,
    JSON.stringify(seen),
  )
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  // view_image resolves paths like read_file: outside the workspace needs the
  // workspace trust prompt (declined here, since the run offers none).
  const tmpDir = path.join(os.tmpdir(), `artemis-view-image-ws-${Date.now()}`)
  const outsideDir = path.join(os.tmpdir(), `artemis-view-image-outside-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(outsideDir, { recursive: true })
  const outsideImage = path.join(outsideDir, 'private.png')
  fs.writeFileSync(outsideImage, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'view image workspace smoke' })
  await store.save(session)
  const seen: (number | undefined)[] = []
  let calls = 0
  const provider: ChatProvider = {
    supportsImages: true,
    async complete(_messages, options): Promise<ProviderResponse> {
      calls += 1
      seen.push(options?.imageAttachments?.length)
      if (calls === 1) {
        return { text: JSON.stringify({ reply: 'Let me look.', done: false, actions: [{ type: 'view_image', path: outsideImage }] }), raw: null }
      }
      return { text: JSON.stringify({ reply: 'Could not open it.', done: true }), raw: null }
    },
  }
  await runAgent(session, 'Look at that picture.', {
    cwd: tmpDir,
    provider,
    sessionStore: store,
    permissionManager: new PermissionManager('accept-all', false),
    maxTurns: 3,
    profile: 'main',
  })
  const toolText = session.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n')
  assert(
    'view_image: an image outside the workspace is refused without the workspace trust prompt and never attached',
    seen.every((n) => n === undefined) && /declined|escapes/i.test(toolText),
    `${JSON.stringify(seen)} ${toolText.slice(0, 300)}`,
  )
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(outsideDir, { recursive: true, force: true })
}

{
  // A model that cannot see images: view_image is not offered as a native
  // tool, and calling it anyway fails instead of claiming success.
  const runWith = async (supportsImages: boolean) => {
    const tmpDir = path.join(os.tmpdir(), `artemis-view-image-novision-${Date.now()}-${supportsImages}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'screenshot.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
    const store = new SessionStore(tmpDir)
    const session = store.createSession({ title: 'view image no-vision smoke' })
    await store.save(session)
    const seen: (number | undefined)[] = []
    const nativeToolNames: string[][] = []
    let calls = 0
    const provider: ChatProvider = {
      supportsImages,
      supportsNativeToolCalls: true,
      async complete(_messages, options): Promise<ProviderResponse> {
        calls += 1
        seen.push(options?.imageAttachments?.length)
        nativeToolNames.push((options?.nativeFunctionTools ?? []).map((t) => t.name))
        if (calls === 1) {
          return { text: JSON.stringify({ reply: 'Let me look.', done: false, actions: [{ type: 'view_image', path: 'screenshot.png' }] }), raw: null }
        }
        return { text: JSON.stringify({ reply: 'Done.', done: true }), raw: null }
      },
    }
    await runAgent(session, 'What does the screenshot show?', {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 3,
      profile: 'main',
    })
    const toolText = session.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n')
    fs.rmSync(tmpDir, { recursive: true, force: true })
    return { seen, nativeToolNames, toolText }
  }
  const vision = await runWith(true)
  const textOnly = await runWith(false)
  assert(
    'view_image: offered as a native tool to a vision model and attached on the next request',
    vision.nativeToolNames[0]?.includes('view_image') === true && vision.seen[1] === 1,
    JSON.stringify({ tools: vision.nativeToolNames[0]?.includes('view_image'), seen: vision.seen }),
  )
  assert(
    'view_image: hidden from a model that cannot see images, and fails (no image sent) when called anyway',
    textOnly.nativeToolNames.every((names) => !names.includes('view_image')) &&
      textOnly.seen.every((n) => n === undefined) &&
      /Images cannot be viewed here/.test(textOnly.toolText) &&
      /Do not mention plans, tiers or models/.test(textOnly.toolText) &&
      !/is attached to your next step/.test(textOnly.toolText),
    JSON.stringify({ seen: textOnly.seen, tool: textOnly.toolText.slice(0, 300) }),
  )
}

{
  // Responses API: native tool calls run inside the native loop, whose
  // continuation request (previous_response_id) must carry the viewed image.
  const tmpDir = path.join(os.tmpdir(), `artemis-view-image-responses-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'screenshot.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'view image responses smoke' })
  await store.save(session)
  const requests: Array<{ previousResponseId?: string; images?: number; toolOutputs?: number }> = []
  const provider: ChatProvider = {
    supportsImages: true,
    supportsNativeToolCalls: true,
    async complete(_messages, options): Promise<ProviderResponse> {
      requests.push({
        previousResponseId: options?.previousResponseId,
        images: options?.imageAttachments?.length,
        toolOutputs: options?.toolOutputs?.length,
      })
      if (requests.length === 1) {
        return {
          text: '',
          raw: null,
          responseId: 'resp_1',
          nativeToolCalls: [{ name: 'view_image', arguments: JSON.stringify({ path: 'screenshot.png' }), callId: 'call_1' }],
        }
      }
      return { text: JSON.stringify({ reply: 'It is a login page.', done: true }), raw: null }
    },
  }
  await runAgent(session, 'What does the screenshot show?', {
    cwd: tmpDir,
    provider,
    sessionStore: store,
    permissionManager: new PermissionManager('accept-all', false),
    maxTurns: 3,
    profile: 'main',
  })
  assert(
    'view_image (Responses native loop): the continuation request carries the viewed image with the tool output',
    requests.length === 2 &&
      requests[0]?.images === undefined &&
      requests[1]?.previousResponseId === 'resp_1' &&
      requests[1]?.toolOutputs === 1 &&
      requests[1]?.images === 1,
    JSON.stringify(requests),
  )
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  // Provider wire formats for images: OpenAI-compatible endpoints always get
  // image_url blocks (also for Claude and Gemini models behind a gateway),
  // text-only models get a note and never base64 text, and the Responses
  // continuation adds the images after the tool outputs.
  const bodies: Array<Record<string, unknown>> = []
  let reply: unknown = {}
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      bodies.push(raw ? JSON.parse(raw) as Record<string, unknown> : {})
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Mock image wire-format server failed to bind.')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const image = { data: 'iVBORw0KGgo=', mediaType: 'image/png' as const, label: 'Image: shot.png' }
  const userMessage = { id: 'u1', role: 'user' as const, content: 'What is this?', createdAt: new Date().toISOString() }
  try {
    reply = { choices: [{ message: { content: 'ok' } }], usage: {} }
    const chatImageBlocks = async (model: string) => {
      bodies.length = 0
      const provider = new OpenAICompatibleProvider({ protocol: 'openai', baseUrl, apiKey: 'k', model })
      await provider.complete([userMessage], { imageAttachments: [image] })
      const messages = bodies[0]?.messages as Array<{ role?: string; content?: unknown }> | undefined
      return { provider, content: messages?.find((m) => m.role === 'user')?.content, raw: JSON.stringify(bodies[0] ?? {}) }
    }
    const isImageUrlContent = (content: unknown) => Array.isArray(content) &&
      content.some((b) => (b as { type?: string }).type === 'image_url') &&
      content.some((b) => (b as { type?: string; text?: string }).type === 'text' && (b as { text?: string }).text === 'What is this?')
    const claude = await chatImageBlocks('anthropic/claude-sonnet-4.5')
    const gemini = await chatImageBlocks('gemini-2.5-flash')
    assert(
      'image wire format: Claude and Gemini models behind an OpenAI-compatible endpoint get standard image_url blocks',
      claude.provider.supportsImages && gemini.provider.supportsImages && isImageUrlContent(claude.content) && isImageUrlContent(gemini.content),
      `${JSON.stringify(claude.content).slice(0, 200)} ${JSON.stringify(gemini.content).slice(0, 200)}`,
    )
    const deepseek = await chatImageBlocks('deepseek-chat')
    assert(
      'image wire format: a text-only model (DeepSeek) gets a note instead of the image, never base64 text',
      deepseek.provider.supportsImages === false &&
        typeof deepseek.content === 'string' &&
        /not shown: they cannot be read in this request/.test(deepseek.content) &&
        !deepseek.raw.includes(image.data),
      deepseek.raw.slice(0, 300),
    )

    reply = { id: 'resp_2', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: {} }
    bodies.length = 0
    const responses = new ResponsesCompatibleProvider({ protocol: 'responses', baseUrl, apiKey: 'k', model: 'gpt-5.4' })
    await responses.complete([userMessage], {
      previousResponseId: 'resp_1',
      toolOutputs: [{ callId: 'call_1', output: '{"ok":true}' }],
      imageAttachments: [image],
    })
    const input = bodies[0]?.input as Array<Record<string, unknown>> | undefined
    const userItem = input?.[1] as { role?: string; content?: Array<{ type?: string; image_url?: string }> } | undefined
    assert(
      'image wire format: a Responses continuation sends the tool output, then a user item with the image',
      bodies[0]?.previous_response_id === 'resp_1' &&
        input?.[0]?.type === 'function_call_output' &&
        userItem?.role === 'user' &&
        userItem.content?.some((b) => b.type === 'input_image' && b.image_url === `data:image/png;base64,${image.data}`) === true,
      JSON.stringify(bodies[0]).slice(0, 400),
    )

    reply = { content: [{ type: 'text', text: 'ok' }], usage: {} }
    bodies.length = 0
    const messagesProvider = new MessagesCompatibleProvider({ protocol: 'messages', baseUrl, apiKey: 'k', model: 'claude-sonnet-4-5' })
    await messagesProvider.complete([
      userMessage,
      { id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 'tu_1', name: 'view_image', arguments: '{"path":"shot.png"}' }], createdAt: new Date().toISOString() },
      { id: 't1', role: 'tool', content: 'attached', toolUseId: 'tu_1', createdAt: new Date().toISOString() },
    ], { imageAttachments: [image] })
    const anthropicMessages = bodies[0]?.messages as Array<{ role?: string; content?: Array<Record<string, unknown>> }> | undefined
    const lastUser = anthropicMessages?.[anthropicMessages.length - 1]?.content
    assert(
      'image wire format: on the Messages API the image follows the tool_result block instead of replacing it',
      Array.isArray(lastUser) &&
        lastUser[0]?.type === 'tool_result' &&
        lastUser.some((b) => b.type === 'image' && !('_label' in b)) &&
        !lastUser.some((b) => b.type === 'text' && b.text === ''),
      JSON.stringify(lastUser).slice(0, 400),
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

{
  // A project without its own providers.json uses the global semantic-memory
  // setting, like the main model does.
  const tmpDir = path.join(os.tmpdir(), `artemis-memory-profile-${Date.now()}`)
  const home = path.join(tmpDir, 'home')
  const project = path.join(tmpDir, 'project')
  fs.mkdirSync(path.join(home, '.artemis'), { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(home, '.artemis', 'providers.json'), JSON.stringify({
    profiles: [],
    memoryProfile: { enabled: true, provider: 'openai', config: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test', model: 'embed-test' } },
  }))
  const previous = { HOME: process.env.HOME, ARTEMIS_HOME: process.env.ARTEMIS_HOME }
  process.env.HOME = home
  delete process.env.ARTEMIS_HOME
  try {
    const { getMemoryProfile } = await import('../src/core/memoryEnhancement.js')
    const profile = await getMemoryProfile(project)
    assert('semantic memory: a project without its own setting uses the global one', profile.enabled === true && profile.config?.model === 'embed-test', JSON.stringify(profile))
  } finally {
    if (previous.HOME === undefined) delete process.env.HOME
    else process.env.HOME = previous.HOME
    if (previous.ARTEMIS_HOME !== undefined) process.env.ARTEMIS_HOME = previous.ARTEMIS_HOME
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

{
  // With ARTEMIS_HOME set, the global store is $ARTEMIS_HOME/providers.json
  // (not a workspaces/<hash> path) for the main model, the provider router,
  // semantic memory and brain.ts alike. A setup written earlier at the
  // workspace path of the home directory keeps working until that file exists.
  const tmpDir = path.join(os.tmpdir(), `artemis-global-store-${Date.now()}`)
  const artemisHome = path.join(tmpDir, 'artemis-home')
  const project = path.join(tmpDir, 'project')
  fs.mkdirSync(artemisHome, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  const mainProfile = (id: string) => ({ id, protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: `sk-${id}`, model: `${id}-model` })
  const previousArtemisHome = process.env.ARTEMIS_HOME
  process.env.ARTEMIS_HOME = artemisHome
  let legacyPath = ''
  try {
    const { createGlobalProviderStore } = await import('../src/providers/store.js')
    const { resolveMainProviderConfig } = await import('../src/providers/onboarding.js')
    const { getMemoryProfile } = await import('../src/core/memoryEnhancement.js')
    const homePath = path.join(artemisHome, 'providers.json')
    legacyPath = new ProviderStore(os.homedir()).getFilePath()
    assert(
      'global provider store: an ARTEMIS_HOME path resolves to $ARTEMIS_HOME/providers.json',
      new ProviderStore(artemisHome).getFilePath() === homePath && legacyPath !== homePath,
      `${new ProviderStore(artemisHome).getFilePath()} vs ${legacyPath}`,
    )

    fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
    fs.writeFileSync(legacyPath, JSON.stringify({ profiles: [mainProfile('legacy-main')], defaultMainProfileId: 'legacy-main' }))
    const legacyMain = await resolveMainProviderConfig({ cwd: project, config: {} })
    assert(
      'global provider store: a setup at the old workspace path is still found while $ARTEMIS_HOME/providers.json is missing',
      createGlobalProviderStore().getFilePath() === legacyPath && legacyMain.model === 'legacy-main-model',
      `${createGlobalProviderStore().getFilePath()} ${legacyMain.model}`,
    )

    fs.writeFileSync(homePath, JSON.stringify({
      profiles: [mainProfile('home-main')],
      defaultMainProfileId: 'home-main',
      memoryProfile: { enabled: true, provider: 'openai', config: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test', model: 'embed-home' } },
    }))
    const homeMain = await resolveMainProviderConfig({ cwd: project, config: {} })
    const memoryProfile = await getMemoryProfile(project)
    assert(
      'global provider store: main model and semantic memory read $ARTEMIS_HOME/providers.json',
      createGlobalProviderStore().getFilePath() === homePath &&
        homeMain.model === 'home-main-model' &&
        memoryProfile.config?.model === 'embed-home',
      `${createGlobalProviderStore().getFilePath()} ${homeMain.model} ${JSON.stringify(memoryProfile)}`,
    )
  } finally {
    if (previousArtemisHome === undefined) delete process.env.ARTEMIS_HOME
    else process.env.ARTEMIS_HOME = previousArtemisHome
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

{
  // A real headless run (runHeadlessAgent, as `artemis execute` and the web
  // product use) against a chat-completions server that answers in the text
  // tool-call dialect: the loose `remember` form saves a memory, and with no
  // scope named it stays in the project; an explicit global save goes global.
  const tmpDir = path.join(os.tmpdir(), `artemis-headless-remember-${Date.now()}`)
  const artemisHome = path.join(tmpDir, 'artemis-home')
  const project = path.join(tmpDir, 'project')
  fs.mkdirSync(artemisHome, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  let requestCount = 0
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      requestCount += 1
      const content = requestCount === 1
        ? [
          'Noted both.',
          '<toolcall name="remember">{"name":"deploy-target","description":"Deploys go to the staging VPS first","content":"Deploy to the staging VPS before production."}</toolcall>',
          '<toolcall name="memory">{"action":"save","scope":"global","name":"reply-language","description":"Owner wants replies in Simplified Chinese","content":"Always reply in Simplified Chinese."}</toolcall>',
        ].join('\n')
        : 'Saved both.'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: 'mock-openai-compatible',
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }))
    })
  })
  const previousArtemisHome = process.env.ARTEMIS_HOME
  process.env.ARTEMIS_HOME = artemisHome
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Mock provider server failed to bind to a TCP port.')
    fs.writeFileSync(path.join(artemisHome, 'providers.json'), JSON.stringify({
      defaultMainProfileId: 'mock-openai',
      profiles: [{ id: 'mock-openai', protocol: 'openai', apiKey: 'test-key', model: 'mock-openai-compatible', baseUrl: `http://127.0.0.1:${address.port}` }],
    }))
    const { memoryDirForScope } = await import('../src/storage/memoryFiles.js')
    const result = await runHeadlessAgent(project, 'Remember: deploys go to staging first, and reply in Simplified Chinese.', { maxTurns: 3 })
    const list = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    const projectSaved = list(memoryDirForScope(project, 'project'))
    const globalSaved = list(memoryDirForScope(project, 'global'))
    const detail = `reply=${result.reply} requests=${requestCount} project=${projectSaved.join(',')} global=${globalSaved.join(',')}`
    assert(
      'headless memory: a <toolcall name="remember"> without a scope is saved to the project, not globally',
      projectSaved.some((f) => f.startsWith('deploy-target')) && !globalSaved.some((f) => f.startsWith('deploy-target')),
      detail,
    )
    assert(
      'headless memory: an explicit global memory save still goes global',
      globalSaved.some((f) => f.startsWith('reply-language')),
      detail,
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (previousArtemisHome === undefined) delete process.env.ARTEMIS_HOME
    else process.env.ARTEMIS_HOME = previousArtemisHome
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

{
  // Headless runs (artemis execute, the web product) know the owner: soul.md
  // reaches the system prompt, and main may save a long-term memory.
  const tmpDir = path.join(os.tmpdir(), `artemis-headless-memory-${Date.now()}`)
  const home = path.join(tmpDir, 'artemis-home')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'soul.md'), 'Speak like a calm ship captain.')
  const previousHome = process.env.ARTEMIS_HOME
  process.env.ARTEMIS_HOME = home
  try {
    const store = new SessionStore(tmpDir)
    const session = store.createSession({ title: 'headless memory smoke' })
    await store.save(session)
    let calls = 0
    let systemText = ''
    const provider: ChatProvider = {
      async complete(messages): Promise<ProviderResponse> {
        calls += 1
        if (calls === 1) {
          systemText = messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')
          return {
            text: JSON.stringify({
              reply: 'Noted.',
              done: false,
              actions: [{ type: 'memory', action: 'save', name: 'reply-language', description: 'Owner wants replies in Simplified Chinese', content: 'Always reply in Simplified Chinese.' }],
            }),
            raw: null,
          }
        }
        return { text: JSON.stringify({ reply: 'Saved.', done: true }), raw: null }
      },
    }
    await runAgent(session, 'Remember: always reply in Simplified Chinese.', {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 3,
      profile: 'main',
    })
    assert('headless memory: soul.md reaches the main system prompt', systemText.includes('Speak like a calm ship captain.'), systemText.slice(0, 400))
    const saved = fs.existsSync(path.join(home, 'memory')) ? fs.readdirSync(path.join(home, 'memory')) : []
    assert('headless memory: main may save a long-term memory', saved.some((f) => f.startsWith('reply-language')), saved.join(', '))
  } finally {
    if (previousHome === undefined) delete process.env.ARTEMIS_HOME
    else process.env.ARTEMIS_HOME = previousHome
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ── Web product tools: headless main runs (artemis execute, the web app) ──────
// The tools main gained for the web product, as runtime data shared by the
// blocks below.
const WEB_MAIN_ADDED_TOOLS = [
  'search_web',
  'generate_image',
  'generate_video',
  'generate_long_video',
  'synthesize_speech',
  'transcribe_audio',
  'task_output',
  'kill_task',
  'weather_current',
  'weather_forecast',
  'world_clock',
  'time_diff',
  'currency_convert',
  'currency_rates',
  'flight_lookup',
  'browser_navigate',
  'browser_screenshot',
  'browser_extract_text',
  'browser_click',
  'browser_type',
  'browser_form_input',
  'browser_evaluate',
  'browser_console',
  'browser_requests',
  'browser_tabs',
  'browser_wait_for',
  'browser_close',
] as const
const WEB_MAIN_EXCLUDED_TOOLS = [
  'computer_click',
  'computer_screenshot',
  'calendar_list_today',
  'reminders_add',
  'spotify_play_liked',
  'mcp_enable',
  'mcp_disable',
  'bridge_send_image',
  'request_user_confirmation',
  'spawn_background_workflow',
] as const

// Minimal valid arguments for each added tool, so validateToolAction and the
// permission manager see a realistic action.
function sampleWebToolAction(type: string): AgentAction {
  const args: Record<string, Record<string, unknown>> = {
    search_web: { query: 'artemis' },
    generate_image: { prompt: 'a red fox' },
    generate_video: { prompt: 'a red fox running' },
    generate_long_video: { prompt: 'a red fox journey' },
    synthesize_speech: { text: 'hello' },
    transcribe_audio: { inputPath: 'a.wav' },
    task_output: { taskId: 't1' },
    kill_task: { taskId: 't1' },
    weather_current: { location: 'Paris' },
    weather_forecast: { location: 'Paris' },
    world_clock: { cities: ['Paris'] },
    time_diff: { fromCity: 'Paris', toCity: 'Tokyo' },
    currency_convert: { amount: 1, from: 'EUR', to: 'USD' },
    currency_rates: { base: 'EUR' },
    flight_lookup: { callsign: 'AFR123' },
    browser_navigate: { url: 'https://example.com' },
    browser_type: { selector: '#q', text: 'x' },
    browser_form_input: { selector: '#q', value: 'x' },
    browser_evaluate: { script: '1 + 1' },
    browser_tabs: { action: 'list' },
    browser_wait_for: { text: 'x' },
    browser_click: { text: 'x' },
  }
  return { type, ...(args[type] ?? {}) } as unknown as AgentAction
}

{
  // (a) + (e): every added tool is allowed for main, offered as a native tool
  // and listed in the manifest on a headless Linux host, and PRODUCER mode
  // authorizes it. Desktop-only tools stay hidden there.
  const linuxHeadless = { platform: 'linux', hasDisplay: false } as const
  const snapshot = () => ({
    nativeNames: buildProviderNativeFunctionTools(getAllowedActionTypesForProfile('main')).map((tool) => tool.name),
    manifestNames: [...renderDetailedToolManifest().matchAll(/^## (\S+)$/gm)].map((match) => match[1]!),
    mainPromptManifest: [...buildSystemPrompt(process.cwd(), 'PRODUCER', 'standard', 'main', true).matchAll(/^## (\S+)$/gm)].map((match) => match[1]!),
  })
  const linux = withToolHostEnvironment(linuxHeadless, snapshot)
  const mac = withToolHostEnvironment({ platform: 'darwin', hasDisplay: true }, snapshot)

  const notAllowed = WEB_MAIN_ADDED_TOOLS.filter((type) => !validateProfileAction('main', sampleWebToolAction(type)).allowed)
  assert('web tools: every added tool passes validateProfileAction for main', notAllowed.length === 0, notAllowed.join(', '))
  const invalid = WEB_MAIN_ADDED_TOOLS.filter((type) => validateToolAction(sampleWebToolAction(type)).length > 0)
  assert('web tools: sample actions for the added tools are valid', invalid.length === 0, invalid.join(', '))

  const missingNative = WEB_MAIN_ADDED_TOOLS.filter((type) => !linux.nativeNames.includes(type))
  assert('web tools: every added tool is a main native tool on headless linux', missingNative.length === 0, missingNative.join(', '))
  const missingManifest = WEB_MAIN_ADDED_TOOLS.filter((type) => !linux.manifestNames.includes(type) || !linux.mainPromptManifest.includes(type))
  assert('web tools: every added tool is in the tool manifest and the main prompt manifest on headless linux', missingManifest.length === 0, missingManifest.join(', '))

  const producer = new PermissionManager('PRODUCER', false)
  const denied: string[] = []
  for (const type of WEB_MAIN_ADDED_TOOLS) {
    const decision = await producer.authorize(sampleWebToolAction(type))
    if (!decision.allowed) denied.push(`${type}: ${decision.reason}`)
  }
  assert('web tools: PRODUCER mode authorizes every added tool', denied.length === 0, denied.join(' | '))
  const unknownCategory = WEB_MAIN_ADDED_TOOLS.filter((type) => getPermissionCategoryForActionType(type) === 'none')
  assert('web tools: every added tool has a real permission category', unknownCategory.length === 0, unknownCategory.join(', '))

  const recovered = parseAssistantEnvelopeForSmoke([
    'Looking it up.',
    '<toolcall name="search_web">{"query":"artemis release notes","limit":3}</toolcall>',
    '<toolcall name="browser_navigate">{"url":"https://example.com","extractText":true}</toolcall>',
    '<toolcall name="weather_current">{"location":"Paris"}</toolcall>',
  ].join('\n'))
  const recoveredTypes = (recovered.actions ?? []).map((action) => action.type)
  assert(
    'web tools: native calls replayed as <toolcall> text keep search_web, browser and weather calls',
    eq(recoveredTypes, ['search_web', 'browser_navigate', 'weather_current']) &&
      (recovered.actions?.[0] as { query?: string } | undefined)?.query === 'artemis release notes',
    JSON.stringify(recovered.actions),
  )

  const desktopOnly = ['computer_screenshot', 'computer_click', 'computer_doctor', 'calendar_list_today', 'calendar_add_event', 'reminders_list', 'reminders_add']
  const leaked = desktopOnly.filter((type) =>
    linux.nativeNames.includes(type) || linux.manifestNames.includes(type) || linux.mainPromptManifest.includes(type))
  assert('web tools: desktop-only tools stay hidden from main on headless linux (native, manifest, prompt)', leaked.length === 0, leaked.join(', '))
  const excludedAllowed = WEB_MAIN_EXCLUDED_TOOLS.filter((type) => validateProfileAction('main', { type } as unknown as AgentAction).allowed)
  assert('web tools: dangerous, desktop-only and headless-useless tools stay blocked for main', excludedAllowed.length === 0, excludedAllowed.join(', '))
  assert(
    'web tools: main does not offer excluded tools natively or in its prompt, even on macOS',
    WEB_MAIN_EXCLUDED_TOOLS.every((type) => !mac.nativeNames.includes(type) && !mac.mainPromptManifest.includes(type)),
    WEB_MAIN_EXCLUDED_TOOLS.filter((type) => mac.nativeNames.includes(type) || mac.mainPromptManifest.includes(type)).join(', '),
  )
}

// A mock host for headless runs: an OpenAI-compatible chat endpoint scripted
// per request, and an images endpoint for the custom visual provider.
type MockHostRequest = { path: string; body: string }
async function withMockHeadlessHost(
  options: {
    /** The agent's own requests (they carry tools), numbered from 1. */
    chat: (index: number, body: string) => string
    /** Tool-less side requests: vision helper, memory curator, summaries. */
    aux?: (body: string) => string
    image?: (body: string, hostBaseUrl: string) => { status: number; json: unknown }
    configureVisual?: boolean
    /** BytePlus image profile on the mock host (supports referenceImages). */
    configureBytePlusVisual?: boolean
    /** Replaces the default providers.json written to ARTEMIS_HOME. */
    providers?: (baseUrl: string) => unknown
    /** The platform gateway's POST /v1/search. */
    search?: (body: string, authorization: string | undefined) => { status: number; json: unknown }
  },
  run: (ctx: { project: string; requests: MockHostRequest[]; port: number }) => Promise<void>,
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-web-tools-'))
  const artemisHome = path.join(tmpDir, 'artemis-home')
  const project = path.join(tmpDir, 'project')
  fs.mkdirSync(artemisHome, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  const requests: MockHostRequest[] = []
  let chatCount = 0
  let hostBaseUrl = ''
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const url = req.url ?? ''
      requests.push({ path: url, body })
      if (url.includes('/chat/completions')) {
        // Side requests (the post-run memory curator, the vision helper) can
        // interleave with the agent's; only tool-bearing requests are scripted.
        const isAgentRequest = body.includes('"tools"')
        if (isAgentRequest) chatCount += 1
        else requests[requests.length - 1]!.path = `${url}#aux`
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          model: 'mock-openai-compatible',
          choices: [{ message: { content: isAgentRequest ? options.chat(chatCount, body) : (options.aux?.(body) ?? '[]') } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }))
        return
      }
      if (url === '/v1/search' && options.search) {
        const reply = options.search(body, req.headers.authorization)
        res.writeHead(reply.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply.json))
        return
      }
      if (url === '/visual/asset.png') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'))
        return
      }
      if (url.startsWith('/visual/') && url.includes('/images/generations') && options.image) {
        const reply = options.image(body, hostBaseUrl)
        res.writeHead(reply.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply.json))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `no route for ${url}` } }))
    })
  })
  const saved = {
    home: process.env.ARTEMIS_HOME,
    media: process.env.ARTEMIS_MEDIA_OUTPUT_ROOT,
    bing: process.env.BING_API_KEY,
    google: process.env.GOOGLE_API_KEY,
    cx: process.env.GOOGLE_CX,
  }
  const realFetch = globalThis.fetch
  process.env.ARTEMIS_HOME = artemisHome
  process.env.ARTEMIS_MEDIA_OUTPUT_ROOT = path.join(tmpDir, 'media')
  delete process.env.BING_API_KEY
  delete process.env.GOOGLE_API_KEY
  delete process.env.GOOGLE_CX
  // Only the mock host is reachable: public search backends fail like they do
  // on a VPS whose datacenter IP they block.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init)
    throw new Error(`network unreachable from this host: ${new URL(url).host}`)
  }) as typeof fetch
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Mock headless host failed to bind to a TCP port.')
    hostBaseUrl = `http://127.0.0.1:${address.port}`
    fs.writeFileSync(path.join(artemisHome, 'providers.json'), JSON.stringify(
      options.providers?.(`http://127.0.0.1:${address.port}`) ?? {
        defaultMainProfileId: 'mock-openai',
        profiles: [{ id: 'mock-openai', protocol: 'openai', apiKey: 'test-key', model: 'mock-openai-compatible', baseUrl: `http://127.0.0.1:${address.port}` }],
      },
    ))
    if (options.configureBytePlusVisual) {
      await configureBytePlusImageProfile(project, `http://127.0.0.1:${address.port}/visual/api/v3`)
    }
    if (options.configureVisual) {
      const store = new ProviderStore(project)
      const data = await store.load()
      data.visualProfile = {
        enabled: true,
        image: {
          provider: 'custom',
          apiKey: 'visual-test-key',
          baseUrl: `http://127.0.0.1:${address.port}/visual/v1`,
          model: 'mock-image-model',
          defaultParams: { size: '1024x1024', quality: 'standard', style: 'realistic', watermark: false },
        },
        video: {
          enabled: false,
          provider: 'custom',
          apiKey: '',
          baseUrl: `http://127.0.0.1:${address.port}/visual/v1`,
          model: 'mock-video-model',
          defaultParams: { duration: '10s', resolution: '720p', quality: 'standard', style: 'realistic', format: 'mp4', framerate: '30fps', watermark: false },
        },
      } as typeof data.visualProfile
      await store.save(data)
    }
    await run({ project, requests, port: address.port })
  } finally {
    globalThis.fetch = realFetch
    await new Promise<void>((resolve) => server.close(() => resolve()))
    for (const [key, value] of [
      ['ARTEMIS_HOME', saved.home],
      ['ARTEMIS_MEDIA_OUTPUT_ROOT', saved.media],
      ['BING_API_KEY', saved.bing],
      ['GOOGLE_API_KEY', saved.google],
      ['GOOGLE_CX', saved.cx],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

{
  // (b) A headless image request runs generate_image end to end against a mock
  // image endpoint. runInBackground is ignored headless: the file exists when
  // the run returns, and the model saw the tool result before answering.
  await withMockHeadlessHost({
    configureVisual: true,
    chat: (index) => index === 1
      ? [
        'Generating the fox image.',
        '<toolcall name="generate_image">{"prompt":"a red fox in fresh snow, golden hour","outputPath":"fox.png","runInBackground":true}</toolcall>',
      ].join('\n')
      : 'Done: the fox image is saved as fox.png.',
    image: () => ({ status: 200, json: { data: [{ b64_json: ONE_PIXEL_PNG_BASE64 }] } }),
  }, async ({ project, requests }) => {
    const result = await runHeadlessAgent(project, 'Generate an image of a red fox in the snow.', { maxTurns: 6 })
    const imageCalls = requests.filter((request) => request.path.includes('/images/generations'))
    const chatCalls = requests.filter((request) => request.path.includes('/chat/completions') && !request.path.endsWith('#aux'))
    const saved = path.join(project, 'fox.png')
    const savedBytes = fs.existsSync(saved) ? fs.readFileSync(saved) : Buffer.alloc(0)
    const detail = `reply=${result.reply} turns=${result.turns} image=${imageCalls.length} chat=${chatCalls.length}`
    assert(
      'web tools: headless generate_image reaches the configured image endpoint once',
      imageCalls.length === 1 && imageCalls[0]!.body.includes('a red fox in fresh snow'),
      detail,
    )
    assert(
      'web tools: headless generate_image saves the image before the run returns (no background task)',
      savedBytes.subarray(0, 4).toString('hex') === '89504e47',
      detail,
    )
    assert(
      'web tools: headless image run ends in a couple of turns with the model answer',
      result.turns <= 3 && chatCalls.length <= 3 && result.reply.includes('fox.png') && !result.reply.includes('Execution blocked'),
      detail,
    )
    assert(
      'web tools: the model saw the successful generate_image result',
      chatCalls.length >= 2 && chatCalls[1]!.body.includes('Generated 1 image(s)'),
      chatCalls[1]?.body.slice(0, 400),
    )
  })
}

{
  // (b, merged main) Text-only platform model + vision helper + BytePlus
  // references, headless: the attached photo is described by the helper,
  // view_image returns the description, and generate_image sends the photo
  // as a reference and saves the result before the run returns.
  let mainCalls = 0
  let visionCalls = 0
  await withMockHeadlessHost({
    configureBytePlusVisual: true,
    providers: (baseUrl) => ({
      defaultMainProfileId: 'platform-main',
      visionProfileId: 'platform-vision',
      profiles: [
        { id: 'platform-main', protocol: 'openai', baseUrl, apiKey: 'k', model: 'gpt-6-sol', supportsImages: false, contextLength: 200_000, maxOutputTokens: 8192, capabilitiesSource: 'platform' },
        { id: 'platform-vision', protocol: 'openai', baseUrl, apiKey: 'k', model: 'vision-alias', supportsImages: true, capabilitiesSource: 'platform' },
      ],
    }),
    aux: (body) => {
      if (!body.includes('"model":"vision-alias"')) return '[]'
      visionCalls += 1
      return 'A watercolor painting of a lighthouse in soft blue tones.'
    },
    chat: (index) => {
      mainCalls = index
      return index === 1
        ? [
          'Looking at the reference, then painting the cat in the same style.',
          '<toolcall name="view_image">{"path":"style.png"}</toolcall>',
          '<toolcall name="generate_image">{"prompt":"a cat, watercolor, soft blue tones","referenceImages":["style.png"],"outputPath":"cat.png","runInBackground":true}</toolcall>',
        ].join('\n')
        : 'Done: cat.png uses the watercolor style of your photo.'
    },
    image: (_body, hostBase) => ({ status: 200, json: { data: [{ url: `${hostBase}/visual/asset.png` }] } }),
  }, async ({ project, requests }) => {
    fs.writeFileSync(path.join(project, 'style.png'), Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'))
    const result = await runHeadlessAgent(project, 'Paint a cat in the style of this photo.', {
      maxTurns: 6,
      imagePaths: ['style.png'],
    })
    const imageCalls = requests.filter((request) => request.path.includes('/images/generations'))
    const mainBodies = requests.filter((request) => request.path.includes('/chat/completions') && request.body.includes('"model":"gpt-6-sol"')).map((request) => request.body)
    const imageBody = (() => { try { return JSON.parse(imageCalls[0]?.body ?? '{}') as { image?: unknown } } catch { return {} } })()
    const saved = path.join(project, 'cat.png')
    const detail = JSON.stringify({ reply: result.reply, turns: result.turns, vision: visionCalls, main: mainCalls, image: imageCalls.length })
    assert(
      'web tools + vision helper: a text-only headless model gets the attached photo described, and view_image returns the description',
      visionCalls >= 1 &&
        mainBodies.every((body) => !body.includes('image_url')) &&
        mainBodies.some((body) => body.includes('Image 1 description by vision helper')) &&
        mainBodies.some((body) => body.includes('description by vision helper') && body.includes('watercolor painting of a lighthouse')),
      detail,
    )
    assert(
      'web tools + referenceImages: headless generate_image sends the workspace photo as a reference and saves the result before returning',
      imageCalls.length === 1 &&
        typeof imageBody.image === 'string' && (imageBody.image as string).startsWith('data:image/png;base64,') &&
        fs.existsSync(saved) && fs.readFileSync(saved).subarray(0, 4).toString('hex') === '89504e47' &&
        result.reply.includes('cat.png') && !result.reply.includes('Execution blocked'),
      detail,
    )
  })
}

{
  // (c) No visual provider configured: the image request ends quickly with an
  // honest "not configured" answer, never a 60-turn checklist loop.
  await withMockHeadlessHost({
    chat: (index) => index === 1
      ? '<toolcall name="generate_image">{"prompt":"a red fox in the snow"}</toolcall>'
      : 'I could not create the image: image generation is not configured on this server. Ask the owner to set up a visual provider (artemis setup visual).',
  }, async ({ project, requests }) => {
    const result = await runHeadlessAgent(project, 'Generate an image of a red fox in the snow.', { maxTurns: 60 })
    const chatCalls = requests.filter((request) => request.path.includes('/chat/completions') && !request.path.endsWith('#aux'))
    const detail = `reply=${result.reply} turns=${result.turns} chat=${chatCalls.length}`
    assert(
      'web tools: unconfigured image generation ends within a few turns, no checklist spin',
      result.turns <= 3 && chatCalls.length <= 3 && !result.reply.includes('Execution blocked'),
      detail,
    )
    assert(
      'web tools: unconfigured image generation answers honestly from the real tool error',
      result.reply.includes('not configured') &&
        chatCalls.length >= 2 && chatCalls[1]!.body.includes('No usable visual API'),
      detail,
    )
  })
}

{
  // (c, guard) The visual checklist accepts a genuine provider blocker and
  // stops demanding a tool after a bounded number of reminders.
  async function runScripted(options: {
    configure: 'custom-402' | 'custom-unreachable'
    permissionMode?: 'PRODUCER' | 'read-only'
    script: (call: number) => unknown
  }): Promise<{ reply: string; turns: number; calls: number }> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-visual-guard-'))
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(402, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Insufficient balance: top up your account to keep generating.' } }))
      })
    })
    const previousHome = process.env.ARTEMIS_HOME
    process.env.ARTEMIS_HOME = path.join(tmpDir, 'home')
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Mock image endpoint failed to bind.')
      const baseUrl = options.configure === 'custom-402' ? `http://127.0.0.1:${address.port}/v1` : 'http://127.0.0.1:9/v1'
      const store = new ProviderStore(tmpDir)
      const data = await store.load()
      data.visualProfile = {
        enabled: true,
        image: { provider: 'custom', apiKey: 'k', baseUrl, model: 'img', defaultParams: { size: '1024x1024', quality: 'standard', style: 'realistic', watermark: false } },
        video: { enabled: false, provider: 'custom', apiKey: '', baseUrl, model: 'v', defaultParams: { duration: '10s', resolution: '720p', quality: 'standard', style: 'realistic', format: 'mp4', framerate: '30fps', watermark: false } },
      } as typeof data.visualProfile
      await store.save(data)
      const sessions = new SessionStore(tmpDir)
      const session = sessions.createSession({ title: 'visual guard smoke' })
      await sessions.save(session)
      let calls = 0
      const provider: ChatProvider = {
        async complete(): Promise<ProviderResponse> {
          calls += 1
          return { text: JSON.stringify(options.script(calls)), raw: null }
        },
      }
      const result = await runAgent(session, 'Generate an image of a red fox in the snow.', {
        cwd: tmpDir,
        provider,
        sessionStore: sessions,
        permissionManager: new PermissionManager(options.permissionMode ?? 'PRODUCER', false),
        maxTurns: 60,
        profile: 'main',
        allowBackgroundTools: false,
      })
      return { reply: result.reply, turns: result.turns, calls }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (previousHome === undefined) delete process.env.ARTEMIS_HOME
      else process.env.ARTEMIS_HOME = previousHome
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  const balance = await runScripted({
    configure: 'custom-402',
    script: (call) => call === 1
      ? { reply: 'Generating.', done: false, actions: [{ type: 'generate_image', prompt: 'a red fox in the snow' }] }
      : { reply: 'The image provider reports an insufficient balance, so no image was created. Please top up the visual provider account.', done: true },
  })
  assert(
    'visual guard: an insufficient-balance blocker is accepted and the run ends honestly',
    balance.turns <= 2 && balance.reply.includes('insufficient balance') && !balance.reply.includes('Execution blocked'),
    JSON.stringify(balance),
  )

  const neverCalls = await runScripted({
    configure: 'custom-unreachable',
    script: () => ({ reply: 'Here is a vivid description of a red fox in the snow.', done: true }),
  })
  assert(
    'visual guard: a model that never calls generate_image is reminded a bounded number of times, then the run ends honestly',
    neverCalls.turns <= 3 && neverCalls.calls <= 3 &&
      neverCalls.reply.includes('was not generated') && !neverCalls.reply.includes('Execution blocked'),
    JSON.stringify(neverCalls),
  )

  const readOnly = await runScripted({
    configure: 'custom-unreachable',
    permissionMode: 'read-only',
    script: () => ({ reply: 'Here is a vivid description of a red fox in the snow.', done: true }),
  })
  {
    // Plain writing requests ("write a haiku") are chat answers, not file
    // tasks: no mutation reminder, no runtime note. A request that names a
    // file still gets bounded reminders, then reports the missing file.
    const haiku = 'Red fox in the snow, quiet paws on silver light, gone before the dawn.'
    async function runChat(prompt: string): Promise<{ reply: string; calls: number }> {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-chat-mutation-'))
      try {
        const sessions = new SessionStore(tmpDir)
        const session = sessions.createSession({ title: 'chat mutation smoke' })
        await sessions.save(session)
        let calls = 0
        const provider: ChatProvider = {
          async complete(): Promise<ProviderResponse> {
            calls += 1
            return { text: JSON.stringify({ reply: haiku, done: true }), raw: null }
          },
        }
        const result = await runAgent(session, prompt, {
          cwd: tmpDir,
          provider,
          sessionStore: sessions,
          permissionManager: new PermissionManager('PRODUCER', false),
          maxTurns: 60,
          profile: 'main',
        })
        return { reply: result.reply, calls }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    }
    const chatRuns = await Promise.all([
      'Write a short haiku about foxes.',
      'Create a packing list for a weekend in Paris.',
      'Draft an email to my landlord about the heating.',
    ].map(runChat))
    assert(
      'mutation guard: plain writing requests (poem, list, email) are answered in one turn with exactly the model answer',
      chatRuns.every((run) => run.calls === 1 && run.reply === haiku),
      JSON.stringify(chatRuns),
    )
    const fileRun = await runChat('Create notes.md with a haiku about foxes.')
    assert(
      'mutation guard: a request naming a file that is never written gets bounded reminders, then says which file is missing',
      fileRun.calls === 3 && fileRun.reply.includes('Missing target files: notes.md'),
      JSON.stringify(fileRun),
    )
  }

  assert(
    'visual guard: never demands generate_image when this run cannot call it (read-only)',
    readOnly.turns === 1 && readOnly.calls === 1 && readOnly.reply.includes('vivid description'),
    JSON.stringify(readOnly),
  )
}

{
  // (d) No usable search backend: search_web reports what is missing and the
  // run ends with an honest answer instead of looping.
  await withMockHeadlessHost({
    chat: (index) => index === 1
      ? '<toolcall name="search_web">{"query":"latest Node.js LTS version"}</toolcall>'
      : 'Sorry, web search is not available on this server right now (no search backend is configured), so I could not look that up.',
  }, async ({ project, requests }) => {
    const result = await runHeadlessAgent(project, 'Search the web for the latest Node.js LTS version.', { maxTurns: 60 })
    const chatCalls = requests.filter((request) => request.path.includes('/chat/completions') && !request.path.endsWith('#aux'))
    const detail = `reply=${result.reply} turns=${result.turns} chat=${chatCalls.length}`
    const offered = (() => {
      try {
        const tools = (JSON.parse(chatCalls[0]?.body ?? '{}') as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []
        return tools.map((tool) => tool.function?.name ?? '')
      } catch {
        return []
      }
    })()
    assert(
      'web tools: the headless model request offers search, image, video and browser tools natively, and no desktop or excluded tools',
      ['search_web', 'generate_image', 'generate_video', 'generate_long_video', 'browser_navigate', 'browser_extract_text'].every((name) => offered.includes(name)) &&
        offered.every((name) => !/^(computer_|calendar_|reminders_|spotify_|bridge_send_|mcp_enable|mcp_disable)/.test(name)),
      offered.join(', '),
    )
    assert(
      'web tools: headless search_web without a backend ends within a few turns, no checklist spin',
      result.turns <= 3 && chatCalls.length <= 3 && !result.reply.includes('Execution blocked'),
      detail,
    )
    assert(
      'web tools: search_web failure tells the model which backends failed and what to configure',
      chatCalls.length >= 2 &&
        chatCalls[1]!.body.includes('search_web failed') &&
        chatCalls[1]!.body.includes('GOOGLE_API_KEY') &&
        result.reply.includes('not available'),
      chatCalls[1]?.body.slice(-800),
    )
  })
}

{
  // Platform web search: a hosted VPS (providers.json written by the agent
  // server) searches through the gateway's /v1/search with its platform key.
  const { platformSearchFromStore, searchWithPlatform, PlatformSearchError } = await import('../src/core/platformSearch.js')
  const { hasUserSearchKey } = await import('../src/core/searchTools.js')
  const { startToolHeartbeat } = await import('../src/core/agent.js')
  const main = { id: 'executor', protocol: 'openai', baseUrl: 'https://gw.example/v1', apiKey: 'ak-main', model: 'm' }
  assert(
    'platform search: an explicit webSearch entry wins; enabled:false or another provider turns it off',
    eq(platformSearchFromStore({ webSearch: { provider: 'platform', enabled: true, baseUrl: 'https://gw.example/v1', apiKey: 'ak-1', managedBy: 'platform' }, profiles: [] }), { baseUrl: 'https://gw.example/v1', apiKey: 'ak-1', source: 'webSearch' }) &&
      platformSearchFromStore({ webSearch: { provider: 'platform', enabled: false, managedBy: 'platform' }, profiles: [{ ...main, capabilitiesSource: 'platform' } as never], defaultMainProfileId: 'executor' }) === undefined &&
      platformSearchFromStore({ webSearch: { provider: 'bing' }, profiles: [] }) === undefined &&
      platformSearchFromStore({ webSearch: { provider: 'platform', baseUrl: 'not a url', apiKey: 'k' }, profiles: [] }) === undefined,
  )
  assert(
    'platform search: without a webSearch entry, only a platform-managed main profile is taken as the gateway',
    eq(platformSearchFromStore({ profiles: [{ ...main, capabilitiesSource: 'platform' } as never], defaultMainProfileId: 'executor' }), { baseUrl: 'https://gw.example/v1', apiKey: 'ak-main', source: 'mainProfile' }) &&
      platformSearchFromStore({ profiles: [main as never], defaultMainProfileId: 'executor' }) === undefined,
  )
  assert(
    'platform search: a user search key (Bing, or Google with its CX) keeps priority over the platform',
    hasUserSearchKey({ BING_API_KEY: 'b' }) && hasUserSearchKey({ GOOGLE_API_KEY: 'g', GOOGLE_CX: 'c' }) && !hasUserSearchKey({ GOOGLE_API_KEY: 'g' }) && !hasUserSearchKey({}),
  )

  // Error wording: each failure says what happened, nothing is made up.
  const answer = (status: number, json: unknown, headers: Record<string, string> = {}) =>
    (async () => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } })) as unknown as typeof fetch
  const failure = async (impl: typeof fetch) => {
    try {
      await searchWithPlatform('q', 5, { baseUrl: 'https://gw.example/v1', apiKey: 'ak', source: 'webSearch' }, { fetchImpl: impl })
      return 'resolved'
    } catch (error) {
      return error instanceof PlatformSearchError ? `${error.code}|${error.message}` : String(error)
    }
  }
  const balance = await failure(answer(402, { error: { code: 'insufficient_balance' } }))
  const limited = await failure(answer(429, { error: { code: 'rate_limited' } }, { 'retry-after': '7' }))
  const unpriced = await failure(answer(503, { error: { code: 'search_unpriced' } }))
  const upstream = await failure(answer(502, { error: { code: 'search_failed', message: 'every provider failed' } }))
  const offline = await failure((async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch)
  assert(
    'platform search: balance, rate limit, unavailable, upstream failure and an unreachable gateway each get an honest message',
    balance.startsWith('insufficient_balance|') && balance.includes('balance is too low') &&
      limited.startsWith('rate_limited|') && limited.includes('retry in 7 s') &&
      unpriced.startsWith('unavailable|') && unpriced.includes('search_unpriced') &&
      upstream.startsWith('failed|') && upstream.includes('every provider failed') &&
      offline.startsWith('unreachable|'),
    [balance, limited, unpriced, upstream, offline].join(' / '),
  )

  const platformProviders = (baseUrl: string) => ({
    defaultMainProfileId: 'executor',
    profiles: [{ id: 'executor', protocol: 'openai', apiKey: 'ak-platform-key', model: 'mock-openai-compatible', baseUrl, capabilitiesSource: 'platform', contextLength: 128000 }],
    webSearch: { provider: 'platform', enabled: true, baseUrl: `${baseUrl}/v1`, apiKey: 'ak-platform-key', managedBy: 'platform' },
  })

  // (e) A hosted run searches through the gateway: results reach the model, no fake ones.
  let searchAuth: string | undefined
  let searchBody = ''
  await withMockHeadlessHost({
    providers: platformProviders,
    search: (body, authorization) => {
      searchAuth = authorization
      searchBody = body
      return { status: 200, json: { provider: 'brave', results: [{ title: 'Monad 测试网上线', url: 'https://news.example/monad', snippet: '测试网今日开放', publishedAt: '2026-10-07T00:00:00.000Z' }] } }
    },
    chat: (index) => index === 1
      ? '<toolcall name="search_web">{"query":"Monad 测试网 最新消息","limit":3,"freshness":"week"}</toolcall>'
      : '根据搜索结果，Monad 测试网已上线。',
  }, async ({ requests }) => {
    const result = await runHeadlessAgent(fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-platform-search-')), '帮我搜一下 Monad 测试网的最新消息', { maxTurns: 6 })
    const chatCalls = requests.filter((request) => request.path.includes('/chat/completions') && !request.path.endsWith('#aux'))
    const sent = (() => { try { return JSON.parse(searchBody) as { query?: string; count?: number; freshness?: string } } catch { return {} } })()
    assert(
      'platform search: a hosted run calls the gateway /v1/search with the platform key and the query, count and freshness',
      requests.some((r) => r.path === '/v1/search') && searchAuth === 'Bearer ak-platform-key' &&
        sent.query === 'Monad 测试网 最新消息' && sent.count === 3 && sent.freshness === 'week',
      `auth=${searchAuth} body=${searchBody}`,
    )
    assert(
      'platform search: the gateway results (title, URL, date, snippet) are what the model gets',
      chatCalls.length >= 2 && chatCalls[1]!.body.includes('Monad 测试网上线') && chatCalls[1]!.body.includes('https://news.example/monad') &&
        chatCalls[1]!.body.includes('Published: 2026-10-07') && result.reply.includes('Monad'),
      chatCalls[1]?.body.slice(-600),
    )
  })

  // (f) The gateway refuses (balance): the tool says so and nothing is invented.
  await withMockHeadlessHost({
    providers: platformProviders,
    search: () => ({ status: 402, json: { error: { code: 'insufficient_balance', message: 'Balance too low: please top up' } } }),
    chat: (index) => index === 1
      ? '<toolcall name="search_web">{"query":"BTC price today"}</toolcall>'
      : '搜索暂时用不了：账户余额不足，请先充值。',
  }, async ({ requests }) => {
    await runHeadlessAgent(fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-platform-search-')), 'Search the BTC price today.', { maxTurns: 6 })
    const chatCalls = requests.filter((request) => request.path.includes('/chat/completions') && !request.path.endsWith('#aux'))
    const toolTurn = chatCalls[1]?.body ?? ''
    assert(
      'platform search: a refused search reports the reason (balance) and the fallback outcomes, never fake results or a setup hint',
      toolTurn.includes('search_web failed') && toolTurn.includes('balance is too low') && toolTurn.includes('do not invent search results') &&
        toolTurn.includes('duckduckgo') && !toolTurn.includes('GOOGLE_API_KEY with GOOGLE_CX'),
      toolTurn.slice(-900),
    )
  })

  // Tool heartbeat: a long foreground tool reports progress so the host's
  // no-progress watchdog can tell it from a hung engine.
  const lines: string[] = []
  const stop = startToolHeartbeat('generate_long_video', (m) => lines.push(m), 20)
  await sleep(75)
  stop()
  const count = lines.length
  await sleep(50)
  assert(
    'tool heartbeat: "[tool:<name>] progress" lines while a tool runs, none after it ends',
    count >= 2 && lines.length === count && /^\[tool:generate_long_video\] progress \{"elapsedSeconds":\d+\}$/.test(lines[0] ?? ''),
    lines.join(' | '),
  )
  const savedBeat = process.env.ARTEMIS_TOOL_HEARTBEAT_MS
  process.env.ARTEMIS_TOOL_HEARTBEAT_MS = '1000'
  try {
    await withMockHeadlessHost({
      chat: (index) => index === 1
        ? '<toolcall name="run_command">{"command":"sleep 2.5"}</toolcall>'
        : 'Done waiting.',
    }, async () => {
      const info: string[] = []
      await runHeadlessAgent(fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-heartbeat-')), 'Wait a moment with sleep 2.5, then say done.', { maxTurns: 6, onInfo: (m) => info.push(m) })
      const beats = info.filter((m) => /^\[tool:run_command\] progress /.test(m))
      assert(
        'tool heartbeat: a headless run reports progress while a slow command runs (ARTEMIS_TOOL_HEARTBEAT_MS)',
        beats.length >= 1,
        info.filter((m) => m.startsWith('[tool:')).join(' | '),
      )
    })
  } finally {
    if (savedBeat === undefined) delete process.env.ARTEMIS_TOOL_HEARTBEAT_MS
    else process.env.ARTEMIS_TOOL_HEARTBEAT_MS = savedBeat
  }
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-visual-required-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  await configureMockImageProfile(tmpDir)
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'visual required smoke' })
  await store.save(session)
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      return {
        text: JSON.stringify({
          reply: 'The product photos are ready.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Create a product photo image for a catalog using local visual generation.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 1,
      profile: 'main',
      completionContract: 'requires_execution_evidence',
    },
  )

  assert(
    'visual checklist: configured local image tasks cannot finish without generate_image',
    result.reply.includes('Missing tool call(s): generate_image'),
    result.reply,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-visual-placeholder-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  await configureMockImageProfile(tmpDir)
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'visual placeholder smoke' })
  await store.save(session)
  let calls = 0
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      calls += 1
      if (calls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Creating placeholder visuals.',
            done: false,
            actions: [
              {
                type: 'write_file',
                path: 'assets/product.svg',
                content: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%"/></svg>',
              },
            ],
          }),
          raw: null,
        }
      }
      return {
        text: JSON.stringify({
          reply: 'Product imagery is ready.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Create a product photo image for a catalog using local visual generation.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 2,
      profile: 'main',
      completionContract: 'requires_execution_evidence',
    },
  )

  assert(
    'visual checklist: SVG placeholder assets are blocked when local generation is required',
    result.reply.includes('SVG/procedural placeholder visuals') &&
      result.reply.includes('assets/product.svg'),
    result.reply,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

function createBytePlusCodingPromptIO(state: { sawProtocolMenu: boolean }): PromptIO {
  return {
    available: true,
    write: () => {},
    ask: async (prompt) => prompt.toLowerCase().includes('api key') ? 'bp-key' : '',
    choose: async <T>(options: {
      title: string;
      choices: Array<{ label: string; value: T }>;
    }): Promise<T> => {
      if (options.title.includes('BytePlus profile type')) {
        return options.choices.find((choice) => choice.label === 'Coding')!.value;
      }
      if (options.title.includes('Choose provider protocol')) {
        state.sawProtocolMenu = true
        throw new Error('BytePlus coding should not prompt for provider protocol');
      }
      if (options.title.includes('Choose provider')) {
        return options.choices.find((choice) => choice.label.includes('BytePlus'))!.value;
      }
      if (options.title.includes('Choose API URL')) {
        return options.choices[0]!.value;
      }
      if (options.title.includes('Choose model')) {
        // glm-5.1 is a genuine coding-family model; selecting it from the Coding
        // profile should route to /api/coding/v3.  (seed-2-0-pro-260328 is a
        // chat-family model that the new alignBytePlus logic correctly re-routes
        // to /api/v3 even inside the Coding profile type.)
        return options.choices.find((choice) => choice.label === 'glm-5.1')!.value;
      }
      throw new Error(`Unexpected prompt menu: ${options.title}`);
    },
  };
}

// ── parseArgs ─────────────────────────────────────────────────────────────────

{
  const a = parseArgs([])
  assert('parseArgs: default command is chat', a.command === 'chat')
  assert('parseArgs: default permissionMode is PRODUCER', a.permissionMode === 'PRODUCER')
  assert('parseArgs: default maxTurns matches DEFAULT_AGENT_MAX_TURNS', a.maxTurns === DEFAULT_AGENT_MAX_TURNS)
  assert('parseArgs: setup defaults false', a.setup === false)
}

{
  const a = parseArgs(['help'])
  assert('parseArgs: help command', a.command === 'help')
}

{
  const a = parseArgs(['version'])
  assert('parseArgs: version command', a.command === 'version')
}

{
  const a = parseArgs(['doctor', '--test-providers'])
  assert('parseArgs: doctor + testProviders', a.command === 'doctor' && a.testProviders === true)
}

{
  const a = parseArgs(['--model', 'gpt-4o', '--max-turns', '20', 'hello world'])
  assert('parseArgs: model flag', a.model === 'gpt-4o')
  assert('parseArgs: maxTurns flag', a.maxTurns === 20)
  assert('parseArgs: maxTurns flag is bounded', (() => { try { parseArgs(['--max-turns', String(MAX_AGENT_MAX_TURNS + 1)]) } catch { return true } return false })())
  assert('parseArgs: prompt captured', a.prompt === 'hello world')
}

{
  const a = parseArgs(['--whosyourdaddy'])
  assert('parseArgs: whosyourdaddy sets PRODUCER', a.permissionMode === 'PRODUCER')
  assert('parseArgs: whosyourdaddy sets autoDrive', a.autoDrive === true)
  assert('parseArgs: whosyourdaddy bumps maxTurns to 16', a.maxTurns >= 16)
}

{
  const a = parseArgs(['resume', '--last'])
  assert('parseArgs: resume --last sets resumeLast', a.command === 'resume' && a.resumeLast === true)
}

{
  const a = parseArgs(['config', '--setup'])
  assert('parseArgs: config --setup sets setup flag', a.command === 'config' && a.setup === true)
}

// ── Workflow metadata ────────────────────────────────────────────────────────

assert('workflowMode: internal brainstorm label renders as niko', getWorkflowDisplayName('brainstorm') === 'niko')
assert('workflowMode: niko no longer defaults detached runs to read-only', isReadOnlyWorkflow('brainstorm') === false)
assert('workflowMode: design no longer defaults detached runs to read-only', isReadOnlyWorkflow('design') === false)
assert('workflowMode: contest no longer defaults detached runs to read-only', isReadOnlyWorkflow('contest') === false)

{
  const tmpDir = path.join(os.tmpdir(), `artemis-context-budget-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'large design context smoke' })
  const marker = 'DESIGN_CONTEXT_MARKER_65535'
  store.appendMessage(
    session,
    'user',
    `${'design-detail '.repeat(4_550)}${marker}${' trailing-detail'.repeat(300)}`,
  )
  const managed = await manageContext({
    messages: session.messages,
    fixedTokens: 8_000,
    budget: resolveContextBudget({ contextWindow: 128_000 }),
    state: createContextState(),
  })
  const latestUser = managed.messages.find((message) => message.role === 'user')?.content ?? ''

  assert(
    'context window: latest design/workflow handoff preserves content near 65535 chars',
    latestUser.includes(marker) && latestUser.length > 60_000 && latestUser === session.messages[0]?.content,
    `length=${latestUser.length} marker=${latestUser.includes(marker)}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-tool-intake-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'tool intake truncation smoke' })
  const rawOutput = `${'line\n'.repeat(5_000)}IMPORTANT_TAIL`
  const rawToolResult = JSON.stringify({
    ok: true,
    action: { type: 'run_command', command: 'npm test' },
    output: rawOutput,
  })
  store.appendMessage(session, 'tool', rawToolResult, 'run_command')
  const stored = session.messages[0]?.content ?? ''
  const storedEnvelope = JSON.parse(stored) as { output: string; outputSavedTo?: string }

  assert(
    'session store: large tool messages are spilled to a file (preview + path) before entering history',
    stored.length < rawToolResult.length &&
      storedEnvelope.output.includes('IMPORTANT_TAIL') &&
      storedEnvelope.output.includes('line\nline') &&
      typeof storedEnvelope.outputSavedTo === 'string' &&
      storedEnvelope.outputSavedTo.startsWith(store.getContextDir(session.id)) &&
      fs.readFileSync(storedEnvelope.outputSavedTo, 'utf8') === rawOutput,
    `stored=${stored.length} raw=${rawToolResult.length}`,
  )

  const mediumToolResult = JSON.stringify({ ok: true, action: { type: 'run_command', command: 'npm test' }, output: 'line\n'.repeat(1_400) })
  store.appendMessage(session, 'tool', mediumToolResult, 'run_command')
  assert(
    'session store: medium tool messages are kept whole (no lossy head/tail cut)',
    session.messages[1]?.content === mediumToolResult,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-context-compact-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'compact context smoke' })
  for (let i = 0; i < 12; i += 1) {
    store.appendMessage(session, 'assistant', `turn ${i} ${'analysis '.repeat(500)}`)
    store.appendMessage(session, 'tool', JSON.stringify({
      ok: true,
      action: { type: 'run_command', command: `echo ${i}` },
      output: 'tool-output '.repeat(2_000),
    }), 'run_command')
  }
  store.appendMessage(session, 'user', 'latest task')
  const budget = resolveContextBudget({ contextWindow: 32_000 })
  const managed = await manageContext({
    messages: session.messages,
    fixedTokens: 4_000,
    budget,
    state: createContextState(),
    storage: store.getContextStorage(session),
  })

  assert(
    'context window: compacted main context stays below the send budget',
    managed.tokensAfter <= budget.threshold && managed.messages.at(-1)?.content === 'latest task',
    `tokens=${managed.tokensAfter} threshold=${budget.threshold} action=${managed.action}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  assert(
    'model context: GPT-5.6 variants use the reduced 272K window',
    inferKnownModelContextLength('gpt-5.6-sol') === GPT_5_6_CONTEXT_LENGTH &&
      inferKnownModelContextLength('openai/gpt-5.6-luna-20260709') === GPT_5_6_CONTEXT_LENGTH &&
      inferKnownModelContextLength('gpt-5.6-terra') === GPT_5_6_CONTEXT_LENGTH,
  )
  assert(
    'model context: stale GPT-5.6 metadata and cached values are capped at 272K',
    resolveEffectiveModelContextLength('gpt-5.6-sol', 372_000) === GPT_5_6_CONTEXT_LENGTH &&
      estimateContextLimit('gpt-5.6-sol', 1_000_000) === GPT_5_6_CONTEXT_LENGTH,
  )
  assert(
    'model context: GPT-6 family is hard-capped at the GPT-5.6 272K window',
    inferKnownModelContextLength('gpt-6-sol') === GPT_5_6_CONTEXT_LENGTH &&
      inferKnownModelContextLength('openai/gpt-6-luna') === GPT_5_6_CONTEXT_LENGTH &&
      estimateContextLimit('gpt-6-sol') === GPT_5_6_CONTEXT_LENGTH &&
      estimateContextLimit('gpt-6-sol', 400_000) === GPT_5_6_CONTEXT_LENGTH &&
      resolveEffectiveModelContextLength('openai/gpt-6.1', 1_000_000) === GPT_5_6_CONTEXT_LENGTH &&
      estimateContextLimit('gpt-6-sol', 200_000) === 200_000 &&
      estimateContextLimit('gpt-60', 400_000) === 400_000,
  )
  assert(
    'model context: GLM-5.2/5.3 use 200K while GLM-5.1 keeps its entry',
    estimateContextLimit('glm-5.2') === 200_000 &&
      estimateContextLimit('glm-5.3') === 200_000 &&
      estimateContextLimit('z-ai/glm-5.3') === 200_000 &&
      estimateContextLimit('glm-5.1') === 1_000_000,
  )
  assert(
    'model context: Seed 2.0 aliases use the same 128K as the dated presets',
    estimateContextLimit('seed-2-0-pro') === 128_000 &&
      estimateContextLimit('seed-2-0-mini') === 128_000 &&
      estimateContextLimit('seed-2-0-lite') === 128_000 &&
      estimateContextLimit('seed-2-0-pro-260328') === 128_000,
  )
  assert(
    'model context: Kimi K3 (unverified) and Qwen3.7 use 128K',
    estimateContextLimit('kimi-k3') === 128_000 &&
      estimateContextLimit('moonshotai/kimi-k3-preview') === 128_000 &&
      estimateContextLimit('kimi-k2') === 128_000 &&
      estimateContextLimit('qwen3.7') === 128_000 &&
      estimateContextLimit('qwen3.7-max') === 128_000,
  )
  assert(
    'model context: Claude 5.5 family uses the 1M window',
    estimateContextLimit('claude-opus-5-5') === 1_000_000 &&
      estimateContextLimit('claude-sonnet-5-5') === 1_000_000 &&
      estimateContextLimit('claude-haiku-5-5') === 1_000_000 &&
      estimateContextLimit('anthropic.claude-opus-5-5-v1:0') === 1_000_000 &&
      estimateContextLimit('claude-haiku-4-5') === 200_000,
  )
  const gpt56 = resolveContextBudget({ contextWindow: estimateContextLimit('gpt-5.6-sol', 1_000_000) })
  assert(
    'context compression: GPT-5.6 auto-compaction follows the reduced window',
    gpt56.window === GPT_5_6_CONTEXT_LENGTH && gpt56.threshold < GPT_5_6_CONTEXT_LENGTH * 0.8 && gpt56.threshold > GPT_5_6_CONTEXT_LENGTH * 0.6,
    `threshold=${gpt56.threshold}`,
  )
}

{
  const large = resolveContextBudget({ contextWindow: 1_000_000 })
  assert(
    'context compression: 1M-token models keep large-window full compaction headroom',
    large.threshold >= 650_000 && large.threshold < 1_000_000 - large.reservedOutput,
    `threshold=${large.threshold}`,
  )
  // Clearing old tool output is the first step at the threshold; the
  // summarizer only runs when clearing is not enough.
  const now = new Date().toISOString()
  const messages: SessionMessage[] = [{ id: 'u0', role: 'user', content: 'start', createdAt: now }]
  for (let i = 0; i < 40; i += 1) {
    messages.push({ id: `a${i}`, role: 'assistant', content: `step ${i}`, createdAt: now })
    messages.push({ id: `t${i}`, role: 'tool', name: 'run_command', content: `build log ${i}\n`.repeat(6_000), createdAt: now })
  }
  messages.push({ id: 'u-tail', role: 'user', content: 'latest task', createdAt: now })
  let summarizerCalled = false
  const result = await manageContext({
    messages,
    fixedTokens: 20_000,
    budget: large,
    state: createContextState(),
    summarize: async () => { summarizerCalled = true; return 'x'.repeat(100) },
  })
  assert(
    'context compression: 1M-token models clear old tool output before summarizing',
    result.action === 'clear_tool_results' && !summarizerCalled && result.tokensAfter < large.target,
    `action=${result.action} before=${result.tokensBefore} after=${result.tokensAfter}`,
  )
}

{
  const sessionId = `runtime-smoke-recovery-artifact-${Date.now()}`
  const filePath = path.join(os.tmpdir(), `artemis-recovery-artifact-${Date.now()}.ts`)
  const marker = 'RECOVERY_ARTIFACT_MARKER_BEYOND_HEAD_800_CHARS'
  const content = `${'header filler\n'.repeat(90)}export function recoveredFromArtifact() { return '${marker}' }\n`
  fs.writeFileSync(filePath, content)
  const ledger = await createLedger(sessionId)
  const snapshot = createFileStateSnapshot(filePath, content, Date.now(), Date.now())
  snapshot.artifactPath = await saveFileArtifact(sessionId, filePath, content)
  ledger.fileStates = [snapshot]
  await saveLedger(ledger)

  const recovery = await buildPostCompactRecoveryMessages(ledger, {
    pendingAction: { text: 'continue editing recovered artifact file', capturedAt: new Date().toISOString() },
  })
  assert(
    'context recovery: file artifact restores actionable content beyond ledger head',
    recovery.length === 1 &&
      recovery[0]?.content.includes('recoveredFromArtifact') &&
      recovery[0]?.content.includes(marker),
    recovery[0]?.content.slice(0, 1200),
  )

  fs.rmSync(filePath, { force: true })
  await cleanupLedger(sessionId)
}

{
  const now = new Date().toISOString()
  const mustKeep = 'USER_CONSTRAINT_DO_NOT_DELETE_TOKEN_8H_LONG_TASK'
  const messages: SessionMessage[] = []
  for (let i = 0; i < 80; i += 1) {
    messages.push({
      id: `lt-u${i}`,
      role: 'user',
      content: i === 7
        ? `关键用户约束：${mustKeep}。不要改发布流程，不要丢验证结果。`
        : `long task user checkpoint ${i} ${'constraint '.repeat(400)}`,
      createdAt: now,
    })
    messages.push({
      id: `lt-a${i}`,
      role: 'assistant',
      content: `assistant progress ${i} ${'analysis '.repeat(2_000)}`,
      createdAt: now,
    })
    messages.push({
      id: `lt-t${i}`,
      role: 'tool',
      name: i % 5 === 0 ? 'read_file' : 'run_command',
      content: JSON.stringify({
        ok: true,
        path: `src/long-${i}.ts`,
        output: i % 5 === 0
          ? `import x from 'y'\nexport function longTask${i}() { return true }\ntest('keeps assertion ${i}', () => expect(true).toBe(true))\n`.repeat(1_000)
          : `log ${i}\n`.repeat(5_000),
      }),
      createdAt: now,
    })
  }
  messages.push({ id: 'lt-tail', role: 'user', content: 'latest long task tail marker', createdAt: now })

  let promptSeen = ''
  const result = await manageContext({
    messages,
    fixedTokens: 10_000,
    budget: resolveContextBudget({ contextWindow: 140_000 }),
    state: createContextState(),
    summarize: sectionSummarizer((prompt) => { promptSeen += prompt }),
    reason: 'manual',
  })

  assert(
    'context compression: full compact summary input preserves old user constraints during long tasks',
    result.action === 'summary' &&
      promptSeen.includes(mustKeep) &&
      result.summary?.includes(mustKeep) === true &&
      result.messages[0]!.content.includes(mustKeep) &&
      result.messages.some(m => m.content.includes('latest long task tail marker')),
    `action=${result.action} promptHas=${promptSeen.includes(mustKeep)} summary=${result.summary?.slice(0, 300)}`,
  )
}

{
  const now = new Date().toISOString()
  const messages: SessionMessage[] = []
  for (let i = 0; i < 12; i += 1) {
    messages.push({ id: `fc-u${i}`, role: 'user', content: `user turn ${i} ${'intent '.repeat(20_000)}`, createdAt: now })
    messages.push({ id: `fc-a${i}`, role: 'assistant', content: `assistant turn ${i} ${'analysis '.repeat(20_000)}`, createdAt: now })
    messages.push({
      id: `fc-t${i}`,
      role: 'tool',
      name: 'read_file',
      content: JSON.stringify({
        ok: true,
        path: `src/full-${i}.ts`,
        output: `export function f${i}() { return 1 }\n`.repeat(20_000),
      }),
      createdAt: now,
    })
  }
  messages.push({ id: 'fc-tail', role: 'user', content: 'latest full compact task marker', createdAt: now })

  let summarizerCalled = 0
  const budget = resolveContextBudget({ contextWindow: 120_000 })
  const result = await manageContext({
    messages,
    fixedTokens: 8_000,
    budget,
    state: createContextState(),
    summarize: sectionSummarizer(() => { summarizerCalled += 1 }),
  })

  assert(
    'context compression: full compact emits summary mode and preserves recent tail',
    result.changed === true &&
      result.action === 'summary' &&
      summarizerCalled >= 1 &&
      Boolean(result.summary) &&
      result.tokensAfter < result.tokensBefore &&
      result.tokensAfter <= budget.threshold &&
      isCompactionBoundary(result.messages[0]) &&
      result.messages[0]!.content.includes('## 1. Goals and latest instructions') &&
      result.messages.some(m => m.content.includes('latest full compact task marker')),
    `action=${result.action} called=${summarizerCalled} before=${result.tokensBefore} after=${result.tokensAfter}`,
  )
}

{
  const now = new Date().toISOString()
  const messages: SessionMessage[] = []
  messages.push({ id: 'a-read', role: 'assistant', content: 'read old file', createdAt: now })
  messages.push({
    id: 't-read',
    role: 'tool',
    name: 'read_file',
    // The real path A envelope: the action that ran, then its output.
    content: JSON.stringify({
      ok: true,
      action: { type: 'read_file', path: 'src/old-context.ts' },
      output: [
        "import fs from 'node:fs'",
        'export function keepImportantShape() {',
        `  return '${'x'.repeat(1_100_000)}'`,
        '}',
      ].join('\n'),
    }),
    createdAt: now,
  })
  messages.push({ id: 'u-tail', role: 'user', content: 'latest task should stay raw', createdAt: now })

  let summarizerCalled = false
  const contextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-clear-read-'))
  const { createContextStorage } = await import('../src/core/compaction/index.js')
  const result = await manageContext({
    messages,
    fixedTokens: 8_000,
    budget: resolveContextBudget({ contextWindow: GPT_5_6_CONTEXT_LENGTH }),
    state: createContextState(),
    storage: createContextStorage(contextDir),
    summarize: async () => { summarizerCalled = true; return 'x'.repeat(100) },
  })

  const readFileMsg = result.messages.find(m => m.id === 't-read')
  assert(
    'context compression: an oversized old read_file result is cleared deterministically (no summarizer)',
    result.action === 'clear_tool_results' &&
      summarizerCalled === false &&
      result.tokensAfter < result.tokensBefore,
    `action=${result.action} called=${summarizerCalled} before=${result.tokensBefore} after=${result.tokensAfter}`,
  )
  assert(
    'context compression: cleared read_file names the file and keeps the original on disk',
    typeof readFileMsg?.content === 'string' &&
      readFileMsg.content.includes('src/old-context.ts') &&
      typeof readFileMsg.contextCleared?.savedTo === 'string' &&
      fs.readFileSync(readFileMsg.contextCleared.savedTo, 'utf8').includes('keepImportantShape'),
    readFileMsg?.content.slice(0, 500),
  )
  fs.rmSync(contextDir, { recursive: true, force: true })
}

{
  const now = new Date().toISOString()
  const messages: SessionMessage[] = []
  for (let i = 0; i < 30; i += 1) {
    messages.push({ id: `a${i}`, role: 'assistant', content: `step ${i}`, createdAt: now })
    messages.push({
      id: `t${i}`,
      role: 'tool',
      name: 'run_command',
      content: JSON.stringify({
        ok: true,
        action: { type: 'run_command', command: `npm test ${i}` },
        output: 'log-line '.repeat(4_000),
      }),
      createdAt: now,
    })
  }
  messages.push({ id: 'u-tail', role: 'user', content: 'latest task should stay raw', createdAt: now })

  let summarizerCalled = false
  const result = await manageContext({
    messages,
    fixedTokens: 8_000,
    budget: resolveContextBudget({ contextWindow: GPT_5_6_CONTEXT_LENGTH }),
    state: createContextState(),
    summarize: async () => { summarizerCalled = true; return 'x'.repeat(100) },
  })

  assert(
    'context compression: microcompact prunes old tool output without summarizing large-window conversations',
    result.changed === true &&
      summarizerCalled === false &&
      result.tokensAfter < result.tokensBefore &&
      result.messages.at(-1)?.content === 'latest task should stay raw',
    `called=${summarizerCalled} before=${result.tokensBefore} after=${result.tokensAfter}`,
  )
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-large-model-context-cap-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'large model context cap smoke' })
  for (let i = 0; i < 40; i += 1) {
    store.appendMessage(session, 'assistant', `analysis ${i} ${'detail '.repeat(2_500)}`)
    store.appendMessage(session, 'tool', JSON.stringify({
      ok: true,
      action: { type: 'read_file', path: `src/file-${i}.ts` },
      output: 'file-output '.repeat(4_000),
    }), 'read_file')
  }
  store.appendMessage(session, 'user', 'latest task')
  // The cost cap is now explicit (setup.agent.compression.maxContextTokens).
  const budget = resolveContextBudget({ contextWindow: 1_000_000, maxContextTokens: 80_000 })
  const managed = await manageContext({
    messages: session.messages,
    fixedTokens: 8_000,
    budget,
    state: createContextState(),
    storage: store.getContextStorage(session),
  })

  assert(
    'context window: large model metadata does not expand active context past cost cap',
    budget.window === 80_000 && managed.tokensAfter <= budget.threshold,
    `tokens=${managed.tokensAfter} threshold=${budget.threshold}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const prompt = buildSystemPrompt('/Users/goat', 'accept-all', 'standard', 'main', true)
  assert(
    'system prompt: file tools are grounded in real local paths, not /mnt virtual aliases',
    prompt.includes('File tools operate on the real local filesystem') &&
      prompt.includes('Do not use /mnt/user-data/workspace') &&
      prompt.includes('Desktop directory:') &&
      !prompt.includes('treat those aliases as the canonical thread-local filesystem view'),
    prompt,
  )
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-heimdall-virtual-path-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const mapped = fromHeimdallVirtualPath(
    tmpDir,
    '/mnt/user-data/workspace/Artemis/index.html',
    'session-1',
  )
  assert(
    'Heimdall virtual workspace paths map to the real cwd, not hidden .artemis storage',
    mapped === path.join(tmpDir, 'Artemis', 'index.html') &&
      !mapped.includes(`${path.sep}.artemis${path.sep}`),
    mapped,
  )
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis workspace intent ${Date.now()}`)
  const desktopDir = path.join(tmpDir, 'Desktop')
  fs.mkdirSync(desktopDir, { recursive: true })

  const quoted = await resolveWorkspaceIntent(
    `进入 "${desktopDir}" 并设为工作区`,
    tmpDir,
    tmpDir,
  )
  assert(
    'workspace intent: quoted absolute paths resolve to the requested trusted workspace',
    quoted?.workspacePath === desktopDir &&
      quoted.requestedPath === desktopDir &&
      quoted.usedNearestExistingParent === false,
    JSON.stringify(quoted),
  )

  const alias = await resolveWorkspaceIntent(
    '在桌面建立 Artemis 文件夹并写入 index.html',
    tmpDir,
    tmpDir,
  )
  assert(
    'workspace intent: Desktop/桌面 aliases resolve to the real Desktop directory',
    alias?.workspacePath === desktopDir && alias.source === 'desktop-alias',
    JSON.stringify(alias),
  )

  const missingChild = path.join(desktopDir, 'Artemis')
  const nearest = await resolveWorkspaceIntent(
    `进入 ${missingChild} 并建立网站`,
    tmpDir,
    tmpDir,
  )
  assert(
    'workspace intent: missing requested children trust the nearest existing parent',
    nearest?.workspacePath === desktopDir &&
      nearest.requestedPath === missingChild &&
      nearest.usedNearestExistingParent === true,
    JSON.stringify(nearest),
  )

  const bodyPath = await resolveWorkspaceIntent(
    `请修改 ${desktopDir}/index.html 的标题`,
    tmpDir,
    tmpDir,
  )
  assert(
    'workspace intent: absolute paths in normal request bodies do not switch workspace before tool access checks',
    bodyPath === null,
    JSON.stringify(bodyPath),
  )

  const leadingPath = await resolveWorkspaceIntent(
    `${desktopDir} 继续修改 index.html`,
    tmpDir,
    tmpDir,
  )
  assert(
    'workspace intent: leading absolute paths still switch workspace',
    leadingPath?.workspacePath === desktopDir && leadingPath.source === 'explicit-path',
    JSON.stringify(leadingPath),
  )

  for (const text of ['BKK / 420 / OPEN CULTURE', '这是 slash / 420 正文，不是命令']) {
    const noisySlash = await resolveWorkspaceIntent(text, tmpDir, tmpDir)
    assert(
      'workspace intent: noisy slash text does not switch workspace',
      noisySlash === null,
      JSON.stringify({ text, noisySlash }),
    )
  }

  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const windowsSlashCommand = await resolveWorkspaceIntent('/not-a-command', tmpDir, tmpDir)
    assert(
      'workspace intent: native Windows must not treat unknown slash commands as C-drive absolute paths',
      windowsSlashCommand === null,
      JSON.stringify(windowsSlashCommand),
    )
  } finally {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  }

  const windowsDriveCandidate = resolveWorkspaceCandidatePath('E:\\420COMPANY', 'E:\\')
  assert(
    'workspace paths: Windows drive paths stay absolute instead of becoming E:\\E:\\...',
    windowsDriveCandidate === 'E:\\420COMPANY',
    windowsDriveCandidate,
  )
  assert(
    'workspace paths: Windows drive containment uses win32 semantics cross-platform',
    isPathInsideWorkspace('E:\\420COMPANY', 'E:\\420COMPANY\\index.html') === true &&
      isPathInsideWorkspace('E:\\420COMPANY', 'E:\\Other\\index.html') === false,
    JSON.stringify({
      inside: isPathInsideWorkspace('E:\\420COMPANY', 'E:\\420COMPANY\\index.html'),
      sibling: isPathInsideWorkspace('E:\\420COMPANY', 'E:\\Other\\index.html'),
    }),
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis workspace trust ${Date.now()}`)
  const fakeHome = path.join(tmpDir, 'home')
  const projectDir = path.join(fakeHome, 'project')
  const nestedDir = path.join(projectDir, 'src')
  const siblingDir = path.join(tmpDir, 'other')
  const filePath = path.join(nestedDir, 'index.ts')
  fs.mkdirSync(nestedDir, { recursive: true })
  fs.mkdirSync(siblingDir, { recursive: true })
  fs.writeFileSync(filePath, 'export const ok = true\n')

  assert(
    'workspace trust roots: home directory itself is rejected as an overbroad trusted root',
    isOverbroadTrustedWorkspaceRoot(fakeHome, fakeHome),
    fakeHome,
  )

  assert(
    'workspace trust roots: ancestors of home are rejected as overbroad trusted roots',
    isOverbroadTrustedWorkspaceRoot(tmpDir, fakeHome),
    tmpDir,
  )

  const normalizedRoots = normalizeTrustedWorkspaceRoots([tmpDir, fakeHome, projectDir], fakeHome)
  assert(
    'workspace trust roots: normalization strips home-level roots and keeps concrete project roots',
    normalizedRoots.length === 1 && normalizedRoots[0] === projectDir,
    JSON.stringify(normalizedRoots),
  )

  const mergedHome = mergeTrustedWorkspaceRoots([], fakeHome, fakeHome)
  assert(
    'workspace trust roots: merging a home root stores nothing',
    mergedHome.length === 0,
    JSON.stringify(mergedHome),
  )

  const mergedParent = mergeTrustedWorkspaceRoots([nestedDir], projectDir, fakeHome)
  assert(
    'workspace trust roots: broader trusted parent replaces narrower child',
    mergedParent.length === 1 && mergedParent[0] === projectDir,
    JSON.stringify(mergedParent),
  )

  const mergedChild = mergeTrustedWorkspaceRoots([projectDir], nestedDir, fakeHome)
  assert(
    'workspace trust roots: existing trusted parent absorbs child additions',
    mergedChild.length === 1 && mergedChild[0] === projectDir,
    JSON.stringify(mergedChild),
  )

  const resolution = await resolveWorkspaceForTargetPath(filePath, tmpDir)
  assert(
    'workspace target resolution: existing file resolves to its parent directory',
    resolution?.workspacePath === nestedDir &&
      resolution.requestedPath === filePath &&
      resolution.usedNearestExistingParent === true,
    JSON.stringify(resolution),
  )

  const settingsStore = new CliSettingsStore(tmpDir)
  await settingsStore.rememberTrustedWorkspace(projectDir)
  assert(
    'workspace trust store: nested paths are trusted under a remembered root',
    await settingsStore.isWorkspaceTrusted(nestedDir),
    'nested dir should be trusted',
  )
  assert(
    'workspace trust store: sibling paths are not trusted by another root',
    !(await settingsStore.isWorkspaceTrusted(siblingDir)),
    'sibling dir should not be trusted',
  )

  await settingsStore.update({ visualAssetPreference: 'local' })
  assert(
    'visual policy settings: saved preference persists',
    (await settingsStore.load()).visualAssetPreference === 'local',
  )
  await settingsStore.clearVisualAssetPreference()
  assert(
    'visual policy settings: reset clears saved preference',
    (await settingsStore.load()).visualAssetPreference === undefined,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-deep-research-settings-${Date.now()}`)
  const settingsDir = path.join(tmpDir, '.artemis')
  fs.mkdirSync(settingsDir, { recursive: true })
  fs.writeFileSync(path.join(settingsDir, 'cli-settings.json'), JSON.stringify({
    researchEngine: 'gemini-deep-research',
    researchEngineConfigured: true,
    geminiApiKey: 'test-key',
    geminiDeepResearchAgent: 'models/gemini-example-model',
  }, null, 2), 'utf8')

  const settings = await new CliSettingsStore(tmpDir).load()
  const resolved = resolveGeminiDeepResearchConfig(settings)
  assert(
    'deep research settings: legacy Gemini model default normalizes to the current Deep Research agent',
    resolved.agent === DEFAULT_GEMINI_DEEP_RESEARCH_AGENT &&
      resolved.agent === 'deep-research-preview-04-2026',
    resolved.agent,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-deep-research-sdk-${Date.now()}`)
  fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })
  const settingsStore = new CliSettingsStore(tmpDir)
  await settingsStore.update({
    researchEngine: 'gemini-deep-research',
    researchEngineConfigured: true,
    geminiApiKey: 'test-key',
  })
  const settings = await settingsStore.load()
  let polls = 0
  const result = await runGeminiDeepResearch({
    prompt: 'Research SDK wiring.',
    settings,
    pollIntervalMs: 1,
    client: {
      async createInteraction() {
        return {
          id: 'interaction_test',
          agent: DEFAULT_GEMINI_DEEP_RESEARCH_AGENT,
          status: 'in_progress',
          outputs: [],
        }
      },
      async getInteraction() {
        polls += 1
        return {
          id: 'interaction_test',
          agent: DEFAULT_GEMINI_DEEP_RESEARCH_AGENT,
          status: 'completed',
          outputs: [{ type: 'text', text: 'SDK-backed research complete.' }],
          usage: { total_tokens: 42 },
        }
      },
    },
  })
  assert(
    'deep research SDK client: run path creates, polls, and formats completed interactions',
    polls === 1 &&
      result.status === 'completed' &&
      result.text === 'SDK-backed research complete.' &&
      result.usage?.total_tokens === 42,
    JSON.stringify({ polls, result }),
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const source = (relativePath: string): string =>
    fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
  const designSource = source('src/design/index.ts')
  const nidhoggSource = source('src/core/nidhogg.ts')
  const workflowSource = source('src/core/workflowMode.ts')
  const teamSource = source('src/core/team.ts')
  const interactiveSource = source('src/cli/interactive.ts')
  const bragiSource = source('src/bragi/runtime.ts')
  const browserToolsSource = source('src/tools/browser/browserTools.ts')

  assert(
    'workflow routing: /design uses the executable workflow path with design guidance',
    designSource.includes('static buildDesignWorkflowPrompt') &&
      workflowSource.includes('buildWorkflowHint(mode') &&
      workflowSource.includes("profile: 'main'") &&
      workflowSource.includes("completionContract: 'requires_execution_evidence'"),
  )
  assert(
    'workflow routing: hint-based workflows execute through the main runAgent path',
    workflowSource.includes("mode === 'nidhogg'") &&
      workflowSource.includes('buildWorkflowHint(mode') &&
      workflowSource.includes(': await runAgent('),
  )
  assert(
    'workflow permissions: /nidhogg implementation generator is builder and final synthesis is main',
    /runSpecialistAgent\(\s*session,\s*'builder'[\s\S]*buildGeneratorTask/.test(nidhoggSource) &&
      /const finalResult[\s\S]*profile:\s*'main'/.test(nidhoggSource) &&
      nidhoggSource.includes("const DEFAULT_CRITICS: CriticKind[] = ['spec', 'test_adversary', 'security', 'architecture']"),
  )
  assert(
    'workflow routing: /team only routes to executable workflow modes',
    teamSource.includes("const VALID_CHOICES") &&
      teamSource.includes("'niko',") &&
      workflowSource.includes("mode === 'nidhogg'") &&
      workflowSource.includes('buildWorkflowHint(mode') &&
      workflowSource.includes(': await runAgent(') &&
      workflowSource.includes("completionContract: 'requires_execution_evidence'"),
  )
  assert(
    'interactive routing: path intent is trusted before team/workflow/direct execution',
    interactiveSource.includes('maybeSwitchWorkspaceForRequest(teamPrompt)') &&
      interactiveSource.includes('maybeSwitchWorkspaceForRequest(workflowPrompt)') &&
      interactiveSource.includes('maybeSwitchWorkspaceForRequest(trimmed)') &&
      interactiveSource.includes('runWorkspaceTrustDialog({') &&
      interactiveSource.includes('refreshProjectInstructionsForWorkspace(workspaceRoot)'),
  )
  assert(
    'interactive routing: /nidhogg uses the detached harness runner instead of hint-only mode',
    interactiveSource.includes("launchDetachedWorkflow('nidhogg', effectiveTeamPrompt)") &&
      interactiveSource.includes("launchDetachedWorkflow('nidhogg', effectiveWorkflowPrompt)") &&
      interactiveSource.includes("Nidhogg Harness 已启动"),
  )
  assert(
    'interactive routing: handleTurn preserves the supplied workspace cwd',
    interactiveSource.includes('cwd: thinkOpts.cwd') &&
      !interactiveSource.includes('(global as any).workspaceRoot') &&
      !interactiveSource.includes('(runInteractive as any).workspaceRoot'),
  )
  assert(
    'interactive prompt: completed runners resume the prompt instead of exiting on EOF path',
    interactiveSource.includes('Promise<string | null | undefined>') &&
      interactiveSource.includes('if (nextLine === undefined) break') &&
      interactiveSource.includes('return undefined') &&
      interactiveSource.includes('nextLineOverride: string | null | undefined'),
  )
  assert(
    'workspace trust routing: direct tools and agent tools share the workspace switch hook',
    interactiveSource.includes('handleWorkspaceSwitchRequest') &&
      interactiveSource.includes('onWorkspaceSwitchRequest,') &&
      source('src/brain.ts').includes('requestWorkspaceSwitch: onWorkspaceSwitchRequest') &&
      source('src/core/agent.ts').includes('requestWorkspaceSwitch: options.onWorkspaceSwitchRequest'),
  )
  assert(
    'bridge workflow routing: slash workflows use executable runWorkflowMode instead of prompt suffix simulation',
    bragiSource.includes('runWorkflowMode(') &&
      bragiSource.includes('createProviderRouter({') &&
      bragiSource.includes('new PermissionManager(binding.permissionMode, false)') &&
      !bragiSource.includes('setSystemPromptSuffix') &&
      bragiSource.includes('withBridgeThinkLock'),
  )
  assert(
    'browser tools: context-closed retry restores current URL and covers click/type/wait',
    browserToolsSource.includes('restoreUrlOnRetry') &&
      browserToolsSource.includes('await page.goto(restoreUrl') &&
      /executeBrowserClick[\s\S]*withPageRetry[\s\S]*restoreUrlOnRetry/.test(browserToolsSource) &&
      /executeBrowserType[\s\S]*withPageRetry[\s\S]*restoreUrlOnRetry/.test(browserToolsSource) &&
      /executeBrowserWait[\s\S]*withPageRetry[\s\S]*restoreUrlOnRetry/.test(browserToolsSource),
  )
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-design-workflow-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'design workflow smoke' })
  await store.save(session)

  let executionToolNames: string[] = []
  let implementationCalls = 0
  const designWorkflowInfo: string[] = []
  let designHintReceived = false

  const provider: ChatProvider = {
    supportsNativeToolCalls: true,
    async complete(messages, options): Promise<ProviderResponse> {
      const latestUser =
        [...messages].reverse().find((message) => message.role === 'user')?.content ?? ''
      const toolNames = options?.nativeFunctionTools?.map((tool) => tool.name) ?? []

      implementationCalls += 1
      designHintReceived =
        designHintReceived ||
        latestUser.includes('[当前任务模式：/design 视觉/前端工程]')
      if (implementationCalls === 1) {
        executionToolNames = toolNames
        return {
          text: JSON.stringify({
            reply: 'Writing the design artifact now.',
            done: false,
            actions: [
              {
                type: 'write_file',
                path: 'index.html',
                content: '<main>Artemis design artifact</main>\n',
              },
            ],
          }),
          raw: null,
        }
      }

      if (implementationCalls === 2) {
        return {
          text: JSON.stringify({
            reply: 'Verifying index.html exists.',
            done: false,
            actions: [
              {
                type: 'run_command',
                command: 'test -f index.html',
                timeoutMs: 1000,
              },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Created index.html.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runWorkflowMode(
    'design',
    session,
    'Create an Artemis landing page in index.html.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 4,
      profile: 'main',
      onInfo: (message) => designWorkflowInfo.push(message),
    },
  )

  assert(
    '/design workflow: executable mode injects design guidance and writes through main agent',
    designHintReceived &&
      executionToolNames.includes('write_file') &&
      designWorkflowInfo.some((message) => message.includes('[design] workflow strength contract active')) &&
      fs.readFileSync(path.join(tmpDir, 'index.html'), 'utf8') ===
        '<main>Artemis design artifact</main>\n' &&
      result.reply.includes('Created index.html'),
    `execution=${executionToolNames.join(',')} hint=${designHintReceived} info=${designWorkflowInfo.join('|')} reply=${result.reply}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-virtual-workspace-write-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'virtual workspace write smoke' })
  await store.save(session)

  let calls = 0
  const infoMessages: string[] = []
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      calls += 1
      if (calls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Writing via a mistaken Heimdall virtual workspace path.',
            done: false,
            actions: [
              {
                type: 'write_file',
                path: '/mnt/user-data/workspace/Artemis/index.html',
                content: '<main>Artemis</main>\n',
              },
            ],
          }),
          raw: null,
        }
      }
      return {
        text: JSON.stringify({
          reply: 'Created Artemis/index.html.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Create Artemis/index.html in this workspace.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 3,
      profile: 'main',
      onInfo: (message) => infoMessages.push(message),
    },
  )

  assert(
    'write_file: mistaken /mnt/user-data/workspace path writes to the real cwd instead of failing in .artemis',
    fs.readFileSync(path.join(tmpDir, 'Artemis', 'index.html'), 'utf8') ===
      '<main>Artemis</main>\n' &&
      !fs.existsSync(path.join(tmpDir, '.artemis', 'threads', session.id, 'workspace', 'Artemis', 'index.html')) &&
      (session.changedFiles ?? []).includes('Artemis/index.html') &&
      result.reply.includes('Created Artemis/index.html') &&
      !infoMessages.some((message) => message.includes('[tool:write_file] failed')),
    `reply=${result.reply} changed=${JSON.stringify(session.changedFiles)} info=${infoMessages.join(' | ')}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      return {
        text: JSON.stringify({ choice: 'athena', reason: '误判为大规模任务。' }),
        raw: null,
      }
    },
  }
  const route = await routeTeamRequest(
    '在桌面建立一个文件夹“69420”，然后进入该文件夹，并设为工作区，编写一个卖丝袜的电商网站，UI要高级毛玻璃质感。',
    provider,
  )

  assert(
    '/team routing: website/UI build requests override an Athena misroute to design',
    route.choice === 'design',
    JSON.stringify(route),
  )
}

{
  const state = createWorkflowProgressState('design', 'Design', 'zh-CN')
  applyWorkflowProgressInfo(state, '[design:boot] 目标目录已锁定为 /Users/goat/Desktop/sexyshop')
  applyWorkflowProgressInfo(state, '[design:boot] designer agent -> 研究与设计审查，整理视觉系统与实现合同')
  applyWorkflowProgressInfo(state, '[design] phase 1: research + design review')
  applyWorkflowProgressInfo(state, '[design] phase 1 complete: design brief ready')
  applyWorkflowProgressInfo(state, '[design:synthesis] 设计实现合同已生成，正在移交实现阶段')
  applyWorkflowProgressInfo(state, '[design] phase 2: implementation')
  const fullReply = [
    '第一行：这里是完整设计说明，不应该被 240 字符截断。',
    `${'长内容'.repeat(180)}END_MARKER`,
  ].join('\n')
  applyWorkflowProgressInfo(
    state,
    `[reply] profile=main turn=1 text_json=${JSON.stringify(fullReply)}`,
  )
  applyWorkflowProgressInfo(
    state,
    `[tool:write_file] failed ${JSON.stringify({
      path: '/mnt/user-data/workspace/Artemis/index.html',
      reason:
        'Access denied: /mnt/user-data/workspace/Artemis/index.html is in a protected directory.',
    })}`,
  )
  const stripAnsi = (await import('strip-ansi')).default
  const renderedRaw = renderWorkflowProgress(state)
  const rendered = stripAnsi(renderedRaw).replace(/[\r\n\s↪]+/g, '')
  assert(
    'workflow UI: reply snippets and tool failures are rendered without ellipsis-folding critical text',
    rendered.includes('END_MARKER') &&
      rendered.includes('protecteddirectory') &&
      !rendered.includes('isinap…') &&
      rendered.includes('目标目录已锁定为/Users/goat/Desktop/sexyshop') &&
      rendered.includes('designeragent->研究与设计审查'),
    renderedRaw,
  )
}

// ── Session ───────────────────────────────────────────────────────────────────

{
  const sess = new Session('You are helpful.')
  sess.addUser('Hello')
  sess.addAssistant('Hi there!')
  const msgs = sess.getMessages()
  assert('Session: messages stored correctly', msgs.length === 2)
  assert('Session: user message correct', msgs[0].role === 'user' && msgs[0].content === 'Hello')
  assert('Session: assistant message correct', msgs[1].role === 'assistant')

  sess.clear()
  assert('Session: clear empties messages', sess.getMessages().length === 0)
}

{
  const sess = new Session('sys')
  sess.addUser('a')
  sess.addAssistant('b')
  const msgs = sess.getMessages()
  sess.clear()
  sess.restore(msgs)
  const restored = sess.getMessages()
  assert('Session.restore: length preserved', restored.length === 2)
  assert('Session.restore: content preserved', restored[0].content === 'a')
}

// ── ProviderStore ─────────────────────────────────────────────────────────────

{
  const store = new ProviderStore(process.cwd())
  const data = await store.load()
  assert('LegacyProviderStore: returns a config object', data !== undefined)
  assert('LegacyProviderStore: kind is a known value', Array.isArray(data.profiles))
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-provider-migration-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new ProviderStore(tmpDir)
  await store.save({
    profiles: [],
    setup: {
      agent: {
        maxIterations: 90,
        toolProgress: 'all',
        compression: { enabled: true, threshold: 0.5 },
        sessionReset: { mode: 'both', idleMinutes: 1440, dailyHour: 4 },
      },
      terminal: { backend: 'local' },
      voice: {
        stt: { enabled: true, provider: 'local', engine: 'auto', localModel: 'base', language: '' },
        tts: { provider: 'edge', voice: 'en-US-AriaNeural' },
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
        enabled: { image_gen: false },
        providers: {},
      },
      providerRotation: {},
    },
  })
  const migrated = await store.load()
  assert(
    'ProviderStore migration: legacy image_gen false is upgraded to expose visual generation tools',
    migrated.setup?.tools.enabled.image_gen === true &&
      migrated.setup?.migrations?.imageGenDefaultEnabled === true,
    JSON.stringify(migrated.setup?.tools.enabled),
  )
  const manualOff = await store.updateSetupConfig((setup) => ({
    ...setup,
    tools: {
      ...setup.tools,
      enabled: {
        ...setup.tools.enabled,
        image_gen: false,
      },
    },
  }))
  const reloaded = await store.load()
  assert(
    'ProviderStore migration: manual image_gen disables are preserved after migration flag is present',
    manualOff.setup?.tools.enabled.image_gen === false && reloaded.setup?.tools.enabled.image_gen === false,
    JSON.stringify(reloaded.setup?.tools.enabled),
  )
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-provider-repair-${Date.now()}`)
  const storeDir = path.join(tmpDir, '.artemis')
  const providersPath = path.join(storeDir, 'providers.json')
  fs.mkdirSync(storeDir, { recursive: true })
  fs.writeFileSync(providersPath, `${JSON.stringify({ profiles: [{ id: 'p1', protocol: 'openai' }] }, null, 2)}\n}`, 'utf8')

  const store = new ProviderStore(tmpDir)
  const repaired = await store.load()
  const rawAfterRepair = fs.readFileSync(providersPath, 'utf8')
  assert(
    'ProviderStore repair: trailing junk after valid JSON is removed without losing profiles',
    repaired.profiles.length === 1 &&
      repaired.profiles[0]?.id === 'p1' &&
      JSON.parse(rawAfterRepair).profiles[0].id === 'p1',
    rawAfterRepair,
  )
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

// ── BytePlus preset / media routing ─────────────────────────────────────────

{
  const state = { sawProtocolMenu: false }
  const profile = await promptForProviderProfile(
    createBytePlusCodingPromptIO(state),
    { profiles: [] },
    {
      heading: 'BytePlus coding test',
      defaultAlias: 'BytePlus Coding',
      defaultIdPrefix: 'byteplus-coding',
      cancellationLabel: 'cancel',
    },
    'en',
  )
  assert(
    'BytePlus coding preset: uses the coding OpenAI endpoint, keeps latest official model ids, and skips protocol prompts',
      profile?.profile.protocol === 'openai' &&
      profile.profile.baseUrl === 'https://ark.ap-southeast.bytepluses.com/api/coding/v3' &&
      profile.profile.model === 'glm-5.1' &&
      state.sawProtocolMenu === false,
    `protocol=${profile?.profile.protocol} baseUrl=${profile?.profile.baseUrl} model=${profile?.profile.model} sawProtocol=${state.sawProtocolMenu}`,
  )
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-byteplus-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new ProviderStore(tmpDir)
  await store.save({
    profiles: [
      {
        id: 'byteplus-coding',
        label: 'BytePlus Coding',
        protocol: 'openai',
        baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/coding/v3',
        apiKey: 'bp-key',
        model: 'ark-code-latest',
      },
    ],
    defaultMainProfileId: 'byteplus-coding',
  })
  let errorMessage = ''
  try {
    await resolveModelArkMediaCredentials(tmpDir, 'image')
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error)
  }
  assert(
    'ModelArk media credentials: coding profile does not authorize visual media calls',
    errorMessage.includes('ARTEMIS_VISUAL_SETUP_REQUIRED'),
    errorMessage,
  )
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const originalFetch = globalThis.fetch
  const requestedUrls: string[] = []
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requestedUrls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    return new Response('{"error":{"message":"test stop"}}', { status: 500 })
  }) as typeof fetch

  try {
    const provider = new BytePlusProvider(
      {
        enabled: true,
        image: {
          provider: 'byteplus',
          apiKey: 'bp-key',
          baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3/images/generations',
          model: 'seedream-5-0-260128',
          defaultParams: {
            size: '2K',
            quality: 'standard',
            style: 'realistic',
            watermark: false,
          },
        },
        video: {
          enabled: true,
          provider: 'byteplus',
          apiKey: 'bp-key',
          baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks',
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
      'image',
    )

    await provider.generateImage({ prompt: 'test image' })
    assert(
      'ModelArk visual provider: normalizes full image endpoint base URL before appending the API path',
      requestedUrls[0] === 'https://ark.ap-southeast.bytepluses.com/api/v3/images/generations',
      `url=${requestedUrls[0]}`,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
}

{
  const originalFetch = globalThis.fetch
  let createBody: any
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    createBody = JSON.parse(String(init?.body ?? '{}'))
    return new Response('{"error":{"message":"test stop"}}', { status: 500 })
  }) as typeof fetch

  try {
    const provider = new BytePlusProvider(
      {
        enabled: true,
        image: {
          provider: 'byteplus',
          apiKey: 'bp-key',
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
          enabled: true,
          provider: 'byteplus',
          apiKey: 'bp-key',
          baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks',
          model: 'dreamina-seedance-2-0-260128',
          defaultParams: {
            duration: '10s',
            // What older onboarding wrote for every BytePlus user.
            resolution: '1080p',
            quality: 'standard',
            style: 'realistic',
            format: 'mp4',
            framerate: '24fps',
            watermark: false,
          },
        },
      },
      'video',
    )

    await provider.generateVideo({
      prompt: 'cinematic product film',
      model: 'dreamina-seedance-2-0-260128',
      referenceImageUrls: ['https://example.com/ref.jpg'],
      referenceVideoUrls: ['https://example.com/ref.mp4'],
      referenceAudioUrls: ['https://example.com/ref.mp3'],
      duration: 11,
      ratio: '16:9',
      generateAudio: true,
    })
    const roles = (createBody?.content ?? []).map((item: any) => item.role).filter(Boolean)
    assert(
      'ModelArk visual provider: Seedance 2.0 request includes image, video, and audio reference blocks',
      createBody?.model === 'dreamina-seedance-2-0-260128' &&
        roles.includes('reference_image') &&
        roles.includes('reference_video') &&
        roles.includes('reference_audio') &&
        createBody.generate_audio === true &&
        createBody.duration === 11,
      JSON.stringify(createBody),
    )
    assert(
      'ModelArk visual provider: does not bill the configured 1080p default when no resolution is asked for',
      createBody !== undefined && !('resolution' in createBody),
      JSON.stringify(createBody),
    )
    await provider.generateVideo({ prompt: 'hd product film', model: 'dreamina-seedance-2-0-260128', resolution: '1080P' })
    assert(
      'ModelArk visual provider: sends the requested resolution, normalized',
      createBody?.resolution === '1080p',
      JSON.stringify(createBody),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
}

{
  assert(
    'video resolution: canonical values from loose spellings; unknown and 4k (no provider renders it) rejected',
    normalizeVideoResolution('1080P') === '1080p' &&
      normalizeVideoResolution(' 720 ') === '720p' &&
      normalizeVideoResolution('480') === '480p' &&
      normalizeVideoResolution('4K') === undefined &&
      normalizeVideoResolution('8k') === undefined &&
      normalizeVideoResolution('') === undefined &&
      normalizeVideoResolution(undefined) === undefined,
  )
  assert(
    'video resolution: generate_video validation rejects 4k before any provider is called',
    validateToolAction({ type: 'generate_video', prompt: 'x', resolution: '4k' } as any).some((e) => e.includes('resolution')) &&
      validateToolAction({ type: 'generate_video', prompt: 'x', resolution: '1080p' } as any).length === 0,
  )
}

{
  // OpenAI (Sora) receives the requested resolution as a size; one it cannot
  // render fails before the create request instead of silently changing.
  const originalFetch = globalThis.fetch
  const sizes: string[] = []
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (init?.body instanceof FormData) sizes.push(String(init.body.get('size')))
    return new Response('{"error":{"message":"stop here"}}', { status: 400 })
  }) as typeof fetch
  const soraProvider = (model: string) => new OpenAIProvider({
    enabled: true,
    image: {
      provider: 'openai',
      apiKey: 'test-key',
      baseUrl: 'http://relay.local/v1',
      model: 'gpt-image-2',
      defaultParams: { size: '1024x1024', quality: 'medium', style: 'realistic', watermark: false, outputFormat: 'png', background: 'auto' },
    },
    video: {
      enabled: true,
      provider: 'openai',
      apiKey: 'test-key',
      baseUrl: 'http://relay.local/v1',
      model,
      defaultParams: { duration: '8s', resolution: '720p', quality: 'standard', style: 'realistic', format: 'mp4', framerate: '30fps', watermark: false },
    },
  })
  try {
    await soraProvider('sora-2-pro').generateVideo({ prompt: 'hd', model: 'sora-2-pro', ratio: '16:9', resolution: '1080p' })
    const rejected480 = await soraProvider('sora-2').generateVideo({ prompt: 'small', model: 'sora-2', resolution: '480p' })
    const rejected1080 = await soraProvider('sora-2').generateVideo({ prompt: 'hd', model: 'sora-2', resolution: '1080p' })
    assert(
      'OpenAI visual provider: passes a requested 1080p to pro models and rejects what Sora cannot render',
      sizes.length === 1 &&
        sizes[0] === '1920x1080' &&
        rejected480.success === false && /cannot render 480p/.test(String(rejected480.error)) &&
        rejected1080.success === false && /cannot render 1080p/.test(String(rejected1080.error)),
      `sizes=${JSON.stringify(sizes)} 480=${rejected480.error} 1080=${rejected1080.error}`,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
}

{
  const availableProviderNames = getAvailableProviders().map((provider) => provider.name)
  assert(
    'visual provider registry: public provider list excludes placeholders',
    !availableProviderNames.includes('stable-diffusion') &&
      !availableProviderNames.includes('gemini') &&
      !availableProviderNames.includes('grok') &&
      availableProviderNames.includes('byteplus') &&
      availableProviderNames.includes('openai') &&
      availableProviderNames.includes('google') &&
      availableProviderNames.includes('custom'),
    availableProviderNames.join(', '),
  )
}

{
  const seedance2Caps = resolveVideoModelCapabilities('byteplus', 'dreamina-seedance-2-0-260128')
  const seedance15Caps = resolveVideoModelCapabilities('byteplus', 'seedance-1-5-pro-251215')
  const textOnlyCaps = resolveVideoModelCapabilities('openai', 'sora-2')
  assert(
    'video capabilities: Seedance 2.0 accepts image, video, and audio references',
    getUnsupportedVideoReferences(
      {
        referenceImageUrls: ['https://example.com/a.png'],
        referenceVideoUrls: ['https://example.com/a.mp4'],
        referenceAudioUrls: ['https://example.com/a.mp3'],
      },
      seedance2Caps,
    ).length === 0,
  )
  assert(
    'video capabilities: Seedance 1.5 accepts image references only',
    getUnsupportedVideoReferences(
      {
        referenceImageUrls: ['https://example.com/a.png'],
        referenceVideoUrls: ['https://example.com/a.mp4'],
      },
      seedance15Caps,
    ).join(',') === 'video',
  )
  assert(
    'video capabilities: text-only providers reject reference assets before request creation',
    getUnsupportedVideoReferences(
      { referenceImageUrls: ['https://example.com/a.png'] },
      textOnlyCaps,
    ).join(',') === 'image',
  )
  assert(
    'super visual mode: OpenAI gpt-image-2 plus multimodal video references is eligible',
    isSuperVisualModeEligible({
      hasUserImageReference: false,
      imageProvider: 'openai',
      imageModel: 'gpt-image-2',
      videoReferenceInputs: seedance2Caps.referenceInputs,
    }),
  )
  assert(
    'super visual mode: user image references digest into an illustrated turnaround (not bypass)',
    isSuperVisualModeEligible({
      hasUserImageReference: true,
      imageProvider: 'openai',
      imageModel: 'gpt-image-2',
      videoReferenceInputs: seedance2Caps.referenceInputs,
    }),
  )
  assert(
    'super visual mode: image-only video reference models are not eligible',
    !isSuperVisualModeEligible({
      hasUserImageReference: false,
      imageProvider: 'openai',
      imageModel: 'gpt-image-2',
      videoReferenceInputs: seedance15Caps.referenceInputs,
    }),
  )
  const turnaroundPrompt = buildSuperVisualCharacterTurnaroundPrompt({
    title: 'Reference Locked Hero',
    story: 'An anime protagonist explores a glass observatory.',
    ratio: '16:9',
    referenceNotes: ['silver hair', 'blue cloak'],
  })
  assert(
    'super visual mode: turnaround prompt asks for front, side, and back full-body views without labels',
    turnaroundPrompt.includes('front view') &&
      turnaroundPrompt.includes('side profile view') &&
      turnaroundPrompt.includes('back view') &&
      turnaroundPrompt.includes('full-body') &&
      turnaroundPrompt.includes('No text, no labels'),
  )
  // Regression guard: when /images/edits fails and we fall back to
  // text-to-image with a vision-derived character description, the
  // text-only prompt MUST embed the vision description as VISUAL TRUTH —
  // otherwise the fallback generates a character unrelated to the user's
  // input image.
  const fallbackPromptWithVision = buildSuperVisualCharacterTurnaroundPrompt({
    title: 'Reference Locked Hero',
    story: 'An anime protagonist explores a glass observatory.',
    ratio: '16:9',
    referenceNotes: [],
    withUserImageInput: false,
    visionDescription: 'A young woman with silver hair and a blue cloak, wearing a black lace eye-mask',
  })
  assert(
    'super visual mode: text-only fallback prompt includes the vision-derived character description',
    fallbackPromptWithVision.includes('VISUAL TRUTH') &&
      fallbackPromptWithVision.includes('silver hair') &&
      fallbackPromptWithVision.includes('black lace eye-mask'),
  )
  // And without a vision description, the prompt should not have a stray
  // VISUAL TRUTH header pointing at nothing.
  const fallbackPromptNoVision = buildSuperVisualCharacterTurnaroundPrompt({
    title: 'Reference Locked Hero',
    story: 'An anime protagonist explores a glass observatory.',
    ratio: '16:9',
    referenceNotes: [],
    withUserImageInput: false,
  })
  assert(
    'super visual mode: text-only prompt without vision description has no orphan VISUAL TRUTH header',
    !fallbackPromptNoVision.includes('VISUAL TRUTH'),
  )
  assert(
    'super visual mode: provided character-turnaround file is recognized as an already-built identity sheet',
    isLikelyProvidedTurnaroundReferenceForTest('/Users/goat/Pictures/character-turnaround.png'),
  )
  assert(
    'super visual mode: vision-described three-view sheet is recognized even when the upload filename is generic',
    isLikelyProvidedTurnaroundReferenceForTest(
      '/tmp/telegram-upload-01.png',
      'An illustrated character reference sheet showing the same woman in front view, side profile, and back view.',
    ),
  )
  const dynamicDerivativeStory = buildProvidedTurnaroundSafetyDerivativeStory({
    story: 'Turn this exact reference into a safe video anchor.',
    visionDescription: 'A copper humanoid robot with a triangular glass visor, asymmetrical shoulder armor, a teal cape, and a glowing hexagonal chest emblem.',
    referenceNotes: ['keep the teal cape and hexagonal emblem unchanged'],
  })
  assert(
    'super visual mode: safe derivative prompt uses dynamic vision inventory instead of job-specific hardcoded details',
    dynamicDerivativeStory.includes('DYNAMIC FEATURE INVENTORY') &&
      dynamicDerivativeStory.includes('copper humanoid robot') &&
      dynamicDerivativeStory.includes('triangular glass visor') &&
      dynamicDerivativeStory.includes('teal cape') &&
      dynamicDerivativeStory.includes('hexagonal chest emblem') &&
      !/lingerie|stockings|playing-card|playing card|robe transparency/i.test(dynamicDerivativeStory),
  )
  assert(
    'super visual upload: small 1.7MB turnaround PNG is not recompressed',
    !shouldCompressImageForUploadForTest(Math.round(1.7 * 1024 * 1024), Math.round(1.7 * 1024 * 1024), 1),
  )
  assert(
    'super visual upload: large single image is compressed',
    shouldCompressImageForUploadForTest(7 * 1024 * 1024, 7 * 1024 * 1024, 1),
  )
  assert(
    'super visual upload: medium images are compressed only when the multipart batch is large',
    shouldCompressImageForUploadForTest(3 * 1024 * 1024, 12 * 1024 * 1024, 4),
  )
  // Spatial-reality regression guard: when the world model gives a water
  // line + physics rules + forbidden errors, the per-segment keyframe prompt
  // MUST surface them so the keyframe pose stays geometrically possible.
  const spatialKeyframe = buildSegmentKeyframePrompt({
    shotIndex: 1,
    shotCount: 5,
    shot: { title: 'Beach walk', storyBeat: 'protagonist walks along the surf' },
    ratio: '16:9',
    withPreviousLastFrame: false,
    groundSurface: 'wet sand at shoreline',
    waterLine: 'ankle-deep when wading; otherwise water is meters away',
    physicsRules: [
      'Hand-touches-water requires deliberate dip-down to the water line',
    ],
    forbiddenSpatialErrors: [
      'Hand at chest level cannot make water splash if water is at the feet',
    ],
  })
  assert(
    'spatial reality: keyframe prompt surfaces ground / water-line / physics / forbidden errors',
    spatialKeyframe.includes('GROUND SURFACE') &&
      spatialKeyframe.includes('WATER CONTACT LINE') &&
      spatialKeyframe.includes('PHYSICS RULES') &&
      spatialKeyframe.includes('FORBIDDEN SPATIAL ERRORS') &&
      spatialKeyframe.includes('SPATIAL REALITY CHECK FOR THIS POSE'),
  )
  // And the saga constitution must render the spatial-reality block plus
  // emit the SPATIAL REALITY CHECK rule body when the analyst supplies it.
  const constitutionWithSpatial = buildSagaConstitution({
    protagonist: { name: 'Test Hero', type: 'character', confidence: 0.95, evidence: 'test' },
    supportingCharacters: [],
    props: [],
    environments: ['beach'],
    relationships: [],
    actions: ['walks'],
    protagonistAccessories: [],
    worldModel: {
      spatialReality: {
        groundSurface: 'wet sand at shoreline',
        waterLine: 'ankle-deep when wading',
        physicsRules: ['Hand-touches-water requires dip-down'],
        forbiddenSpatialErrors: ['Hand at chest cannot splash water at feet'],
      },
    },
    mode: 'character',
    modeRationale: 'test',
    source: 'llm',
  })
  assert(
    'spatial reality: saga constitution renders the spatial-reality block and the rule-8 check',
    constitutionWithSpatial.includes('Spatial reality (3D physics') &&
      constitutionWithSpatial.includes('SPATIAL REALITY CHECK') &&
      constitutionWithSpatial.includes('wet sand at shoreline'),
  )
  // Composition diversity (Rule 4): two shots whose primary action+target
  // collapse onto the same iconic pose must be flagged before generation.
  const diversityViolations = runNarrativeCritic({
    shots: [
      {
        index: 1,
        title: '门缝紫光',
        storyBeat: '0–2s: 主角缓缓将手中红色扑克牌举到唇边轻吻；紫光打在蕾丝眼罩上。',
      },
      {
        index: 2,
        title: '呢绒桌沿',
        storyBeat: '0–2s: 主角再次将手中红色扑克牌缓缓举到唇边亲吻；蕾丝眼罩在紫光下反射。',
      },
      {
        index: 3,
        title: '俯身收尾',
        storyBeat: '0–2s: 主角倾身越过桌面将牌缓缓贴到呢绒桌面上；红甲指尖压住牌角。',
      },
    ],
    entities: {
      protagonist: { name: '主角', type: 'character', confidence: 0.95, evidence: 'test' },
      supportingCharacters: [],
      props: ['红色扑克牌', '蕾丝眼罩', '呢绒桌面'],
      environments: ['暗色扑克房'],
      relationships: [],
      actions: ['举牌', '亲吻', '倾身', '放牌'],
      protagonistAccessories: [],
      mode: 'character',
      modeRationale: 'test',
      source: 'llm',
    },
  })
  assert(
    'composition diversity: critic flags shot 2 when its primary composition collapses onto shot 1',
    diversityViolations.some(
      (v) => v.shotIndex === 2 && v.reasons.some((r) => r.includes('Rule 4 violated')),
    ),
  )
  assert(
    'composition diversity: critic does NOT flag shot 3 (its action+target are distinct)',
    !diversityViolations.some(
      (v) => v.shotIndex === 3 && v.reasons.some((r) => r.includes('Rule 4 violated')),
    ),
  )
  assert(
    'video capabilities: Seedance 1.5 accepts explicit generated-audio requests',
    !isGeneratedAudioUnsupported({ generateAudio: true }, seedance15Caps),
  )
  assert(
    'video capabilities: BytePlus multimodal references promote default model to Seedance 2.0 Pro',
    shouldPromoteBytePlusVideoModel(
      { referenceVideoUrls: ['https://example.com/a.mp4'] },
      {
        enabled: true,
        image: {
          provider: 'byteplus',
          apiKey: 'bp-key',
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
          enabled: true,
          provider: 'byteplus',
          apiKey: 'bp-key',
          baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
          model: 'seedance-1-5-pro-251215',
          defaultParams: {
            duration: '10s',
            resolution: '1080p',
            quality: 'standard',
            style: 'realistic',
            format: 'mp4',
            framerate: '24fps',
            watermark: false,
          },
        },
      },
    ) && BYTEPLUS_SEEDANCE_2_PRO_MODEL === 'dreamina-seedance-2-0-260128',
  )
  assert(
    'video capabilities: explicit generated audio promotes default BytePlus video model to Seedance 2.0 Pro',
    shouldPromoteBytePlusVideoModel(
      { generateAudio: true },
      {
        enabled: true,
        image: {
          provider: 'byteplus',
          apiKey: 'bp-key',
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
          enabled: true,
          provider: 'byteplus',
          apiKey: 'bp-key',
          baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
          model: 'seedance-1-5-pro-251215',
          defaultParams: {
            duration: '10s',
            resolution: '1080p',
            quality: 'standard',
            style: 'realistic',
            format: 'mp4',
            framerate: '24fps',
            watermark: false,
          },
        },
      },
    ),
  )
}

{
  const directed = buildDirectedVideoPrompt({
    prompt: '数字萨满, 哥特式教堂, 觉醒',
    provider: 'byteplus',
    model: 'dreamina-seedance-2-0-fast-260128',
    duration: 5,
    ratio: '16:9',
  })
  assert(
    'video director: Seedance prompt expansion adds timeline and one focal point',
    directed.directedPrompt.includes('0-2 seconds') &&
      directed.directedPrompt.includes('single clear focal point') &&
      directed.directedPrompt.includes('Seedance') &&
      directed.directedPrompt.includes('physically') &&
      directed.directedPrompt.includes('no random morphing'),
    directed.directedPrompt,
  )
}

{
  const directed = buildDirectedVideoPrompt({
    prompt: '把一张奶茶产品图做成15秒电商广告视频，镜头展示杯身凝结水珠和旋转开盖',
    provider: 'byteplus',
    model: BYTEPLUS_SEEDANCE_2_PRO_MODEL,
    duration: 15,
    ratio: '9:16',
    referenceImageCount: 1,
    referenceVideoCount: 1,
    referenceAudioCount: 1,
  })
  assert(
    'video director: Seedance 2.0 Pro prompt includes technical spec, reference usage, sound design, and negative constraints',
    directed.providerProfile.includes('Seedance 2.0 Pro') &&
      directed.directedPrompt.includes('Technical spec') &&
      directed.directedPrompt.includes('9:16') &&
      directed.directedPrompt.includes('15秒') &&
      directed.directedPrompt.includes('Timestamp storyboard') &&
      directed.directedPrompt.includes('Reference usage') &&
      directed.directedPrompt.includes('reference images') &&
      directed.directedPrompt.includes('reference videos') &&
      directed.directedPrompt.includes('reference audio') &&
      directed.directedPrompt.includes('Sound design') &&
      directed.directedPrompt.includes('no subtitles') &&
      directed.directedPrompt.includes('no watermark'),
    directed.directedPrompt,
  )
}

{
  assert(
    'video params: Seedance 2.0 duration is clamped to the official range',
    normalizeVideoDurationForProvider(2, 'byteplus', 'dreamina-seedance-2-0-fast-260128') === 4 &&
      normalizeVideoDurationForProvider(20, 'byteplus', 'dreamina-seedance-2-0-260128') === 15,
  )
  assert(
    'video params: Seedance 1.5 Pro duration is clamped to the official range',
    normalizeVideoDurationForProvider(2, 'byteplus', 'seedance-1-5-pro-251215') === 4 &&
      normalizeVideoDurationForProvider(20, 'byteplus', 'seedance-1-5-pro-251215') === 12,
  )
  assert(
    'video params: other video providers keep short durations when allowed by their adapter',
    normalizeVideoDurationForProvider(2, 'google', 'veo-3.0-generate-preview') === 2,
  )
}

{
  const generateVideoSource = fs.readFileSync(path.join(process.cwd(), 'src/tools/generateVideo.ts'), 'utf8')
  assert(
    'generate_video: visual provider path sends Director prompt to video adapters',
    /buildDirectedVideoPrompt\([\s\S]*provider:\s*videoConfig\.provider[\s\S]*prompt:\s*directed\.directedPrompt/.test(generateVideoSource),
  )
  assert(
    'generate_video: legacy BytePlus fallback sends Director prompt',
    /provider:\s*'byteplus'[\s\S]*\{ type:\s*'text', text:\s*directed\.directedPrompt \}/.test(generateVideoSource),
  )
}

{
  const originalFetch = globalThis.fetch
  const requestedUrls: string[] = []
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    requestedUrls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    return new Response('{"error":{"message":"Upstream request failed","type":"upstream_error"}}', { status: 502 })
  }) as typeof fetch

  try {
    const provider = new OpenAIProvider({
      enabled: true,
      image: {
        provider: 'openai',
        apiKey: 'test-key',
        baseUrl: 'http://relay.local/v1/images/generations',
        model: 'gpt-image-2',
        defaultParams: {
          size: '1024x1024',
          quality: 'medium',
          style: 'realistic',
          watermark: false,
          outputFormat: 'png',
          background: 'auto',
        },
      },
      video: {
        enabled: false,
        provider: 'openai',
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        model: 'sora-2',
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
    })

    const result = await provider.generateImage({ prompt: 'luxury game preview concept art', model: 'gpt-image-2' })

    assert(
      'OpenAI visual provider: diagnoses relay upstream 502',
      result.success === false &&
        requestedUrls[0] === 'http://relay.local/v1/images/generations' &&
        String(result.error).includes('OpenAI-compatible relay') &&
        String(result.error).includes('organization verified'),
      `url=${requestedUrls[0]} error=${result.error}`,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-vidar-asset-hosting-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  await configureBytePlusVideoProfile(tmpDir, BYTEPLUS_SEEDANCE_2_PRO_MODEL)
  const store = new ProviderStore(tmpDir)
  const data = await store.load()
  if (!data.visualProfile) throw new Error('missing visual profile')
  data.visualProfile.assetHosting = {
    enabled: true,
    provider: 'r2',
    endpoint: 'https://r2.example.test',
    bucket: 'artemis-assets',
    region: 'auto',
    accessKeyId: 'asset-key',
    secretAccessKey: 'asset-secret',
    publicBaseUrl: 'https://assets.example.test',
    prefix: 'tmp/vidar',
  }
  await store.save(data)

  const referencePath = path.join(tmpDir, 'local reference.mp4')
  fs.writeFileSync(referencePath, Buffer.from('fake-video-bytes'))
  const originalFetch = globalThis.fetch
  const uploadUrls: string[] = []
  const createBodies: Array<Record<string, unknown>> = []
  const tinyMp4 = Buffer.from('AAAAIGZ0eXBtcDQyAAAAAG1wNDFtcDQyaXNvbTY=', 'base64')

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input)
    if (init?.method === 'PUT' && url.startsWith('https://r2.example.test/')) {
      uploadUrls.push(url)
      const auth = String((init.headers as Record<string, string>)?.Authorization ?? '')
      return new Response('', { status: auth.includes('AWS4-HMAC-SHA256') ? 200 : 403 })
    }
    if (url.endsWith('/contents/generations/tasks')) {
      createBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response('{"id":"task-local-ref"}', { status: 200 })
    }
    if (url.endsWith('/contents/generations/tasks/task-local-ref')) {
      return new Response('{"status":"succeeded","content":{"video_url":"https://cdn.example.test/out.mp4"}}', { status: 200 })
    }
    if (url === 'https://cdn.example.test/out.mp4') {
      return new Response(tinyMp4, { status: 200 })
    }
    return new Response(`unexpected url ${url}`, { status: 500 })
  }) as typeof fetch

  try {
    const result = await executeGenerateVideo(
      {
        type: 'generate_video',
        prompt: '生成一个参考本地视频的短片',
        model: BYTEPLUS_SEEDANCE_2_PRO_MODEL,
        referenceVideoPaths: [referencePath],
        outputPath: path.join(tmpDir, 'out.mp4'),
        pollIntervalMs: 1000,
        maxPolls: 1,
      } as any,
      { cwd: tmpDir, permissionMode: 'full-access' } as any,
    )
    const content = createBodies[0]?.content as Array<Record<string, any>> | undefined
    const videoRef = content?.find((item) => item.type === 'video_url')
    assert(
      'generate_video: local video reference uploads via Vidar asset hosting before ModelArk request',
      result.ok === true &&
        uploadUrls.length === 1 &&
        uploadUrls[0].includes('/artemis-assets/tmp/vidar/video/') &&
        String(videoRef?.video_url?.url ?? '').startsWith('https://assets.example.test/tmp/vidar/video/'),
      `result=${result.output} uploads=${JSON.stringify(uploadUrls)} body=${JSON.stringify(createBodies[0])}`,
    )
  } finally {
    globalThis.fetch = originalFetch
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

{
  const originalFetch = globalThis.fetch
  const requestedBodies: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    requestedBodies.push(body)
    if (Object.keys(body).some((key) => key !== 'model' && key !== 'prompt')) {
      return new Response('{"error":{"message":"Upstream request failed","type":"upstream_error"}}', { status: 502 })
    }
    return new Response(
      '{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="}]}',
      { status: 200 },
    )
  }) as typeof fetch

  try {
    const provider = new OpenAIProvider({
      enabled: true,
      image: {
        provider: 'openai',
        apiKey: 'test-key',
        baseUrl: 'http://relay.local/v1',
        model: 'gpt-image-2',
        defaultParams: {
          size: '1024x1024',
          quality: 'medium',
          style: 'realistic',
          watermark: false,
          outputFormat: 'png',
          background: 'auto',
        },
      },
      video: {
        enabled: false,
        provider: 'openai',
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        model: 'sora-2',
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
    })

    const result = await provider.generateImage({ prompt: 'visual health check', model: 'gpt-image-2' })
    if (result.assetPath) fs.rmSync(result.assetPath, { force: true })

    assert(
      'OpenAI visual provider: retries relay upstream 502 with minimal image request',
      result.success === true &&
        requestedBodies.length === 2 &&
        requestedBodies[0].size === '1024x1024' &&
        Object.keys(requestedBodies[1]).sort().join(',') === 'model,prompt',
      `success=${result.success} requests=${JSON.stringify(requestedBodies)} error=${result.error}`,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ── SessionStore ──────────────────────────────────────────────────────────────

{
  const tmpDir = path.join(os.tmpdir(), `artemis-smoke-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)

  const now = new Date().toISOString()
  const messages = [
    { id: 'm1', role: 'user' as const, content: 'hello from smoke test', createdAt: now },
    { id: 'm2', role: 'assistant' as const, content: 'hi!', createdAt: now },
  ]

  const session = Object.assign(store.createSession({ title: 'hello smoke' }), { messages })
  assert('SessionStore.create: id is UUID', /^[0-9a-f-]{36}$/.test(session.id))
  assert('SessionStore.create: title derived', session.title.includes('hello'))
  assert('SessionStore.create: totalTokens stored', true) // no totalTokens in new schema

  await store.save(session)
  const loaded = await store.load(session.id)
  assert('SessionStore: save+load round-trip', loaded !== undefined && loaded.id === session.id)
  assert('SessionStore: messages persisted', loaded?.messages.length === 2)

  const all = await store.list()
  assert('SessionStore.list: returns saved session', all.some(s => s.id === session.id))

  const last = await store.loadLatest()
  assert('SessionStore.loadLast: returns our session', last?.id === session.id)

  const moreMessages = [...messages, { id: 'm3', role: 'user' as const, content: 'follow up', createdAt: now }]
  const updated = { ...session, messages: moreMessages, updatedAt: new Date().toISOString() }
  await store.save(updated)
  const reloaded = await store.load(session.id)
  assert('SessionStore.update: message count grows', reloaded?.messages.length === 3)
  assert('SessionStore.update: token count updated', true) // no totalTokens in new schema

  // cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-session-search-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)

  const alpha = store.createSession({ title: 'alpha feature work' })
  alpha.messages = [
    { id: 'a1', role: 'user', content: 'Investigate alpha cache invalidation bug', createdAt: new Date().toISOString() },
    { id: 'a2', role: 'assistant', content: 'I found the alpha cache issue in the runtime.', createdAt: new Date().toISOString() },
  ]
  await store.save(alpha)

  const beta = store.createSession({ title: 'beta release notes' })
  beta.messages = [
    { id: 'b1', role: 'user', content: 'Draft beta release checklist', createdAt: new Date().toISOString() },
    { id: 'b2', role: 'assistant', content: 'Prepared the beta launch plan.', createdAt: new Date().toISOString() },
  ]
  await store.save(beta)

  const firstSearch = await searchSessions(tmpDir, 'alpha cache')
  assert(
    'session search: SQLite-backed recall finds the matching session',
    firstSearch[0]?.sessionId === alpha.id,
    JSON.stringify(firstSearch),
  )
  assert(
    'session search: SQLite FTS database is created in .artemis',
    fs.existsSync(path.join(tmpDir, '.artemis', 'session-search.sqlite')),
  )

  alpha.messages.push({
    id: 'a3',
    role: 'user',
    content: 'Need follow-up on sqlite recall sync',
    createdAt: new Date().toISOString(),
  })
  await store.save(alpha)

  const secondSearch = await searchSessions(tmpDir, 'sqlite recall')
  assert(
    'session search: save() incrementally refreshes the SQLite index',
    secondSearch.some((result) => result.sessionId === alpha.id),
    JSON.stringify(secondSearch),
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-instruction-file-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'ARTEMIS.md'), '# Project Instructions\n\nPrefer root uppercase instructions.\n', 'utf8')
  resetProjectInstructionFileCacheForTests()

  const loaded = await loadProjectInstructionFile(tmpDir)
  assert(
    'project instructions: ARTEMIS.md is accepted as the root instruction file',
    loaded?.fileName === 'ARTEMIS.md' &&
      loaded.content.includes('Prefer root uppercase instructions.'),
    JSON.stringify(loaded),
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-prompt-cache-hit-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(
    path.join(tmpDir, 'Artemis.MD'),
    `# Project Instructions\n\n${'Keep the runtime stable.\n'.repeat(500)}`,
    'utf8',
  )
  resetPromptRuntimeCacheForTests()
  resetProjectInstructionFileCacheForTests()
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'prompt cache hit smoke' })
  await store.save(session)
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      return {
        text: JSON.stringify({
          reply: 'cache turn complete',
          done: true,
        }),
        raw: null,
      }
    },
  }

  await runAgent(
    session,
    'First stable prompt cache turn.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 1,
      profile: 'main',
    },
  )
  await runAgent(
    session,
    'Second stable prompt cache turn.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 1,
      profile: 'main',
    },
  )

  const promptCacheStats = getPromptRuntimeCacheStats()
  const instructionStats = getProjectInstructionFileCacheStats()
  assert(
    'prompt cache: same cwd/profile reuses the stable system prefix without rereading Artemis.MD',
    promptCacheStats.misses === 1 &&
      promptCacheStats.hits >= 1 &&
      instructionStats.readCalls === 1,
    `prompt=${JSON.stringify(promptCacheStats)} instruction=${JSON.stringify(instructionStats)}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-prompt-cache-invalidate-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const instructionPath = path.join(tmpDir, 'Artemis.MD')
  fs.writeFileSync(instructionPath, '# Project Instructions\n\nFirst version.\n', 'utf8')
  resetPromptRuntimeCacheForTests()
  resetProjectInstructionFileCacheForTests()
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'prompt cache invalidation smoke' })
  await store.save(session)
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      return {
        text: JSON.stringify({
          reply: 'cache invalidation turn complete',
          done: true,
        }),
        raw: null,
      }
    },
  }

  await runAgent(
    session,
    'Read the first project instructions.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 1,
      profile: 'main',
    },
  )
  fs.writeFileSync(
    instructionPath,
    '# Project Instructions\n\nSecond version with different length.\n',
    'utf8',
  )
  await runAgent(
    session,
    'Read the updated project instructions.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 1,
      profile: 'main',
    },
  )

  const promptCacheStats = getPromptRuntimeCacheStats()
  const instructionStats = getProjectInstructionFileCacheStats()
  assert(
    'prompt cache: Artemis.MD changes invalidate the stable prefix',
    promptCacheStats.misses === 2 &&
      promptCacheStats.hits === 0 &&
      instructionStats.readCalls === 2,
    `prompt=${JSON.stringify(promptCacheStats)} instruction=${JSON.stringify(instructionStats)}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-prompt-cache-profile-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(
    path.join(tmpDir, 'Artemis.MD'),
    '# Project Instructions\n\nProfile-specific prompt cache test.\n',
    'utf8',
  )
  resetPromptRuntimeCacheForTests()
  resetProjectInstructionFileCacheForTests()
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'prompt cache profile smoke' })
  await store.save(session)
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      return {
        text: JSON.stringify({
          reply: 'profile cache turn complete',
          done: true,
        }),
        raw: null,
      }
    },
  }

  await runAgent(
    session,
    'Build the main profile prompt.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 1,
      profile: 'main',
    },
  )
  await runAgent(
    session,
    'Build the researcher profile prompt.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 1,
      profile: 'researcher',
    },
  )

  const promptCacheStats = getPromptRuntimeCacheStats()
  assert(
    'prompt cache: profile is part of the stable prefix cache key',
    promptCacheStats.misses === 2 &&
      promptCacheStats.hits === 0 &&
      promptCacheStats.size === 2,
    JSON.stringify(promptCacheStats),
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-builder-approval-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'builder approval smoke' })
  await store.save(session)

  let mainCalls = 0
  let builderProposalToolNames: string[] = []
  let builderExecutionToolNames: string[] = []
  let builderExecutionCalls = 0
  let builderSessionId = ''

  const mainProvider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      mainCalls += 1

      if (mainCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Ask builder for a proposal.',
            done: false,
            actions: [
              { type: 'delegate_task', role: 'builder', task: 'Create approved.txt with approved content.' },
            ],
          }),
          raw: null,
        }
      }

      if (mainCalls === 2) {
        return {
          text: JSON.stringify({
            reply: 'Builder proposal returned.',
            done: true,
          }),
          raw: null,
        }
      }

      if (mainCalls === 3) {
        return {
          text: JSON.stringify({
            reply: 'Approve builder execution.',
            done: false,
            actions: [
              {
                type: 'approve_builder_execution',
                sessionId: builderSessionId,
                summary: 'Approved to create approved.txt.',
              },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Builder execution approved and completed.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const builderProvider: ChatProvider = {
    supportsNativeToolCalls: true,
    async complete(messages, options): Promise<ProviderResponse> {
      const latestUser = [...messages].reverse().find((message) => message.role === 'user')?.content ?? ''
      const toolNames = options?.nativeFunctionTools?.map((tool) => tool.name) ?? []

      if (latestUser.includes('Current phase: proposal only')) {
        builderProposalToolNames = toolNames
        return {
          text: JSON.stringify({
            reply: 'Proposal: create approved.txt after parent approval.',
            done: true,
          }),
          raw: null,
        }
      }

      builderExecutionToolNames = toolNames
      builderExecutionCalls += 1
      if (builderExecutionCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Writing approved.txt now.',
            done: false,
            actions: [
              { type: 'write_file', path: 'approved.txt', content: 'approved\n' },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Created approved.txt.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  await runAgent(
    session,
    'Ask a builder for a proposal only.',
    {
      cwd: tmpDir,
      provider: mainProvider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 3,
      profile: 'main',
      resolveProvider: (target) => target === 'builder' ? builderProvider : mainProvider,
    },
  )

  let persistedSession = await store.load(session.id)
  const builderProposalToolPayload = (persistedSession?.messages ?? [])
    .filter((message) => message.role === 'tool' && message.name === 'delegate_task')
    .map((message) => JSON.parse(message.content))
    .find((payload) => payload?.action?.type === 'delegate_task')
  const builderProposalOutput = builderProposalToolPayload?.output
    ? JSON.parse(builderProposalToolPayload.output)
    : null
  builderSessionId = builderProposalOutput?.sessionId ?? ''

  assert(
    'runAgent delegate: builder proposal native schema stays read-only before approval',
    builderSessionId.length > 0 &&
      builderProposalOutput?.status === 'approval_required' &&
      builderProposalToolNames.includes('read_file') &&
      !builderProposalToolNames.includes('write_file') &&
      !builderProposalToolNames.includes('run_command') &&
      !fs.existsSync(path.join(tmpDir, 'approved.txt')),
    `session=${builderSessionId} tools=${builderProposalToolNames.join(', ')}`,
  )

  await runAgent(
    session,
    'Approve the builder proposal.',
    {
      cwd: tmpDir,
      provider: mainProvider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 4,
      profile: 'main',
      resolveProvider: (target) => target === 'builder' ? builderProvider : mainProvider,
    },
  )

  persistedSession = await store.load(session.id)
  const approvePayload = (persistedSession?.messages ?? [])
    .filter((message) => message.role === 'tool' && message.name === 'approve_builder_execution')
    .map((message) => JSON.parse(message.content))
    .find((payload) => payload?.action?.type === 'approve_builder_execution')
  const approveOutput = approvePayload?.output ? JSON.parse(approvePayload.output) : null

  assert(
    'runAgent delegate: approved builder execution can write and returns structured child result',
    approvePayload?.ok === true &&
      approveOutput?.status === 'executed' &&
      Array.isArray(approveOutput?.changedFiles) &&
      approveOutput.changedFiles.includes('approved.txt') &&
      builderExecutionToolNames.includes('write_file') &&
      fs.readFileSync(path.join(tmpDir, 'approved.txt'), 'utf8') === 'approved\n',
    `output=${JSON.stringify(approveOutput)} tools=${builderExecutionToolNames.join(', ')}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-delegate-parallel-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'delegate parallel smoke' })
  await store.save(session)

  let mainCalls = 0
  let activeResearchers = 0
  let maxActiveResearchers = 0
  const infoMessages: string[] = []

  const mainProvider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      mainCalls += 1

      if (mainCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Delegate three research tasks.',
            done: false,
            actions: [
              { type: 'delegate_task', role: 'researcher', task: 'Research alpha.' },
              { type: 'delegate_task', role: 'researcher', task: 'Research beta.' },
              { type: 'delegate_task', role: 'researcher', task: 'Research gamma.' },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Delegated research complete.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const researcherProvider: ChatProvider = {
    async complete(messages): Promise<ProviderResponse> {
      const latestUser = [...messages].reverse().find((message) => message.role === 'user')?.content ?? ''
      activeResearchers += 1
      maxActiveResearchers = Math.max(maxActiveResearchers, activeResearchers)
      try {
        await sleep(latestUser.includes('alpha') ? 80 : latestUser.includes('beta') ? 20 : 50)
        const label = latestUser.includes('alpha')
          ? 'alpha'
          : latestUser.includes('beta')
            ? 'beta'
            : 'gamma'
        return {
          text: JSON.stringify({
            reply: `Research ${label} complete.`,
            done: true,
          }),
          raw: null,
        }
      } finally {
        activeResearchers -= 1
      }
    },
  }

  await runAgent(
    session,
    'Run three research delegates.',
    {
      cwd: tmpDir,
      provider: mainProvider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 3,
      profile: 'main',
      resolveProvider: (target) => target === 'researcher' ? researcherProvider : mainProvider,
      onInfo: (message) => infoMessages.push(message),
    },
  )

  const persistedSession = await store.load(session.id)
  const delegateOutputs = (persistedSession?.messages ?? [])
    .filter((message) => message.role === 'tool' && message.name === 'delegate_task')
    .map((message) => JSON.parse(message.content))
    .map((payload) => JSON.parse(payload.output))
    .filter((payload) => payload?.role === 'researcher')

  assert(
    'runAgent delegate: researcher tasks run in parallel and preserve output order',
    maxActiveResearchers > 1 &&
      delegateOutputs.length === 3 &&
      delegateOutputs[0]?.summary === 'Research alpha complete.' &&
      delegateOutputs[1]?.summary === 'Research beta complete.' &&
      delegateOutputs[2]?.summary === 'Research gamma complete.' &&
      infoMessages.some((message) => message.includes('[agent-batch] running 3 delegated tasks in parallel')),
    `maxActive=${maxActiveResearchers} outputs=${JSON.stringify(delegateOutputs)} info=${infoMessages.join(' | ')}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-delegate-failure-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'delegate failure smoke' })
  await store.save(session)

  let mainCalls = 0
  const mainProvider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      mainCalls += 1

      if (mainCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Delegate to failing researcher.',
            done: false,
            actions: [
              { type: 'delegate_task', role: 'researcher', task: 'This child provider will fail.' },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Captured the child failure and continued.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const failingResearcherProvider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      throw new Error('researcher provider failed intentionally')
    },
  }

  const result = await runAgent(
    session,
    'Delegate to a failing child and keep going.',
    {
      cwd: tmpDir,
      provider: mainProvider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 3,
      profile: 'main',
      resolveProvider: (target) => target === 'researcher' ? failingResearcherProvider : mainProvider,
    },
  )

  const persistedSession = await store.load(session.id)
  const failurePayload = (persistedSession?.messages ?? [])
    .filter((message) => message.role === 'tool' && message.name === 'delegate_task')
    .map((message) => JSON.parse(message.content))
    .find((payload) => payload?.action?.type === 'delegate_task')
  const failureOutput = failurePayload?.output ? JSON.parse(failurePayload.output) : null

  assert(
    'runAgent delegate: child failure is returned as structured tool result, not a top-level crash',
    mainCalls >= 2 &&
      result.reply === 'Captured the child failure and continued.' &&
      failurePayload?.ok === false &&
      failurePayload?.error?.code === 'agent_child_failed' &&
      failureOutput?.status === 'failed' &&
      String(failureOutput?.summary).includes('researcher provider failed intentionally'),
    JSON.stringify({ failurePayload, failureOutput, reply: result.reply }),
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-delegate-notify-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'seed.txt'), 'seed\n')
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'delegate notify smoke' })
  await store.save(session)

  let mainCalls = 0
  let researcherCalls = 0
  const infoMessages: string[] = []
  const runtimeDirectory = new RuntimeDirectoryService(store)

  const mainProvider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      mainCalls += 1

      if (mainCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Delegate to a researcher and send a parent note.',
            done: false,
            actions: [
              { type: 'delegate_task', role: 'researcher', task: 'Read seed.txt, then continue after the parent note.' },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Child received the parent note and continued.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const notifyingResearcherProvider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      researcherCalls += 1

      if (researcherCalls === 1) {
        const activeRuntime = (session.taskRuntimes ?? [])
          .find((runtime) => runtime.role === 'researcher' && runtime.status === 'running')
        if (activeRuntime) {
          const queued = await runtimeDirectory.notifyRuntime(
            activeRuntime.id,
            'Parent note from runtime smoke.',
            { source: 'runtime_smoke' },
          )
          assert(
            'runAgent delegate: runtime directory can queue a notify command for an active child runtime',
            queued.found && queued.changed,
            JSON.stringify(queued),
          )
        }

        return {
          text: JSON.stringify({
            reply: 'Read once and wait for the parent note.',
            done: false,
            actions: [
              { type: 'read_file', path: 'seed.txt' },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Processed the parent note and finished.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Delegate to a child and send it a parent note.',
    {
      cwd: tmpDir,
      provider: mainProvider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 4,
      profile: 'main',
      resolveProvider: (target) => target === 'researcher' ? notifyingResearcherProvider : mainProvider,
      onInfo: (message) => infoMessages.push(message),
    },
  )

  const persistedSession = await store.load(session.id)
  const notifiedRuntime = (persistedSession.taskRuntimes ?? [])
    .find((runtime) => runtime.role === 'researcher')
  const notifyCommand = notifiedRuntime?.commandQueue?.find(
    (command) => command.type === 'notify',
  )
  const childSession = notifiedRuntime?.workerSessionId
    ? await store.load(notifiedRuntime.workerSessionId)
    : null

  assert(
    'runAgent delegate: child command queue notify is acknowledged and execution continues',
    mainCalls >= 2 &&
      researcherCalls === 2 &&
      result.reply === 'Child received the parent note and continued.' &&
      notifyCommand?.state === 'acknowledged' &&
      notifyCommand?.handledBySessionId === notifiedRuntime?.workerSessionId &&
      childSession?.messages.some(
        (message) =>
          message.role === 'tool' &&
          message.name === 'runtime_command_notify' &&
          message.content.includes('Parent note from runtime smoke.'),
      ) === true &&
      infoMessages.some((message) => message.includes('runtime_command type=notify')),
    JSON.stringify({
      reply: result.reply,
      runtime: notifiedRuntime,
      command: notifyCommand,
      childSessionId: childSession?.id,
      childMessages: childSession?.messages,
      info: infoMessages,
    }),
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-delegate-interrupt-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'seed.txt'), 'seed\n')
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'delegate interrupt smoke' })
  await store.save(session)

  let mainCalls = 0
  let researcherCalls = 0
  const infoMessages: string[] = []

  const mainProvider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      mainCalls += 1

      if (mainCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Delegate to an interruptible researcher.',
            done: false,
            actions: [
              { type: 'delegate_task', role: 'researcher', task: 'Read seed.txt, then continue until interrupted.' },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Captured the child interruption and continued.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const interruptingResearcherProvider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      researcherCalls += 1

      if (researcherCalls === 1) {
        const activeRuntime = (session.taskRuntimes ?? [])
          .find((runtime) => runtime.role === 'researcher' && runtime.status === 'running')
        if (activeRuntime) {
          appendTaskRuntimeCommand(session, activeRuntime.id, {
            type: 'interrupt',
            summary: 'Interrupted by runtime smoke test.',
            metadata: {
              source: 'runtime_smoke',
            },
          })
          await store.save(session)
        }

        return {
          text: JSON.stringify({
            reply: 'Reading once before interruption.',
            done: false,
            actions: [
              { type: 'read_file', path: 'seed.txt' },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'This reply should not be reached after interruption.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Delegate to a child and interrupt its runtime.',
    {
      cwd: tmpDir,
      provider: mainProvider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 4,
      profile: 'main',
      resolveProvider: (target) => target === 'researcher' ? interruptingResearcherProvider : mainProvider,
      onInfo: (message) => infoMessages.push(message),
    },
  )

  const persistedSession = await store.load(session.id)
  const interruptPayload = (persistedSession?.messages ?? [])
    .filter((message) => message.role === 'tool' && message.name === 'delegate_task')
    .map((message) => JSON.parse(message.content))
    .find((payload) => payload?.action?.type === 'delegate_task')
  const interruptOutput = interruptPayload?.output ? JSON.parse(interruptPayload.output) : null
  const interruptedRuntime = (persistedSession.taskRuntimes ?? [])
    .find((runtime) => runtime.role === 'researcher')
  const interruptCommand = interruptedRuntime?.commandQueue?.find(
    (command) => command.type === 'interrupt',
  )

  assert(
    'runAgent delegate: child command queue interruption propagates as structured child result',
    mainCalls >= 2 &&
      researcherCalls === 1 &&
      result.reply === 'Captured the child interruption and continued.' &&
      interruptPayload?.ok === false &&
      interruptPayload?.error?.code === 'agent_child_interrupted' &&
      interruptOutput?.status === 'interrupted' &&
      String(interruptOutput?.summary).includes('Interrupted by runtime smoke test') &&
      interruptedRuntime?.status === 'interrupted' &&
      interruptCommand?.state === 'acknowledged' &&
      interruptCommand?.handledBySessionId === interruptedRuntime.workerSessionId &&
      infoMessages.some((message) => message.includes('runtime_interrupted')),
    JSON.stringify({
      interruptPayload,
      interruptOutput,
      reply: result.reply,
      runtime: interruptedRuntime,
      command: interruptCommand,
      info: infoMessages,
    }),
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-completion-checklist-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'completion checklist smoke' })
  await store.save(session)

  let completionCalls = 0
  const infoMessages: string[] = []
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Created checklist.txt successfully.',
            done: true,
          }),
          raw: null,
        }
      }

      if (completionCalls === 2) {
        return {
          text: JSON.stringify({
            reply: 'Writing the required file now.',
            done: false,
            actions: [
              { type: 'write_file', path: 'checklist.txt', content: 'created by checklist\n' },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Created checklist.txt with real tool evidence.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Create checklist.txt in this workspace.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 4,
      profile: 'main',
      onInfo: (message) => infoMessages.push(message),
    },
  )

  assert(
    'runAgent: deterministic completion checklist blocks mutation tasks with no write evidence',
    completionCalls >= 3 &&
      fs.readFileSync(path.join(tmpDir, 'checklist.txt'), 'utf8') === 'created by checklist\n' &&
      result.reply === 'Created checklist.txt with real tool evidence.' &&
      infoMessages.some((message) => message.includes('[completion-checklist]')),
    `calls=${completionCalls} reply=${result.reply} info=${infoMessages.join(' | ')}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-completion-checklist-blocker-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'completion checklist blocker smoke' })
  await store.save(session)

  let completionCalls = 0
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1
      return {
        text: JSON.stringify({
          reply: 'Blocked: cannot create the file because the target path is unavailable in this runtime.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Create blocked.txt in this workspace.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 2,
      profile: 'main',
    },
  )

  assert(
    'runAgent: deterministic completion checklist allows explicit blockers',
    completionCalls === 1 &&
      result.reply.includes('Blocked: cannot create the file') &&
      !fs.existsSync(path.join(tmpDir, 'blocked.txt')),
    `calls=${completionCalls} reply=${result.reply}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-completion-checklist-tool-failure-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'completion checklist tool failure smoke' })
  await store.save(session)

  let completionCalls = 0
  const infoMessages: string[] = []
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Attempting the denied write.',
            done: false,
            actions: [
              { type: 'write_file', path: 'unsafe.txt', content: 'unsafe\n' },
            ],
          }),
          raw: null,
        }
      }

      if (completionCalls === 2) {
        return {
          text: JSON.stringify({
            reply: 'Created unsafe.txt successfully.',
            done: true,
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Blocked: permission denied by the runtime, so unsafe.txt was not created.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Create unsafe.txt in this workspace.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('read-only', false),
      maxTurns: 4,
      profile: 'main',
      onInfo: (message) => infoMessages.push(message),
    },
  )

  assert(
    'runAgent: deterministic completion checklist blocks final replies after unresolved tool failures',
    completionCalls >= 3 &&
      result.reply.includes('Blocked: permission denied') &&
      !fs.existsSync(path.join(tmpDir, 'unsafe.txt')) &&
      infoMessages.some((message) => message.includes('unresolved tool failure')),
    `calls=${completionCalls} reply=${result.reply} info=${infoMessages.join(' | ')}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-completion-checklist-expected-paths-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'completion checklist expected paths smoke' })
  await store.save(session)

  let completionCalls = 0
  const infoMessages: string[] = []
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Creating the first requested file.',
            done: false,
            actions: [
              { type: 'write_file', path: 'alpha.txt', content: 'alpha\n' },
            ],
          }),
          raw: null,
        }
      }

      if (completionCalls === 2) {
        return {
          text: JSON.stringify({
            reply: 'Created alpha.txt and beta.txt.',
            done: true,
          }),
          raw: null,
        }
      }

      if (completionCalls === 3) {
        return {
          text: JSON.stringify({
            reply: 'Creating the missing requested target file.',
            done: false,
            actions: [
              { type: 'write_file', path: 'beta.txt', content: 'beta\n' },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Created both alpha.txt and beta.txt.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Create alpha.txt and beta.txt in this workspace.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 5,
      profile: 'main',
      onInfo: (message) => infoMessages.push(message),
    },
  )

  assert(
    'runAgent: deterministic completion checklist enforces explicitly named target files',
    completionCalls >= 4 &&
      fs.readFileSync(path.join(tmpDir, 'alpha.txt'), 'utf8') === 'alpha\n' &&
      fs.readFileSync(path.join(tmpDir, 'beta.txt'), 'utf8') === 'beta\n' &&
      result.reply.includes('alpha.txt') &&
      result.reply.includes('beta.txt') &&
      infoMessages.some((message) => message.includes('expected mutation paths missing')),
    `calls=${completionCalls} reply=${result.reply} info=${infoMessages.join(' | ')}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-completion-checklist-file-count-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'completion checklist file count smoke' })
  await store.save(session)

  let completionCalls = 0
  const infoMessages: string[] = []
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Creating one of the requested files.',
            done: false,
            actions: [
              { type: 'write_file', path: 'count-one.txt', content: 'one\n' },
            ],
          }),
          raw: null,
        }
      }

      if (completionCalls === 2) {
        return {
          text: JSON.stringify({
            reply: 'Created exactly two files.',
            done: true,
          }),
          raw: null,
        }
      }

      if (completionCalls === 3) {
        return {
          text: JSON.stringify({
            reply: 'Creating the second requested file.',
            done: false,
            actions: [
              { type: 'write_file', path: 'count-two.txt', content: 'two\n' },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Created exactly two files with real file evidence.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Create exactly two files in this workspace.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 5,
      profile: 'main',
      onInfo: (message) => infoMessages.push(message),
    },
  )

  assert(
    'runAgent: deterministic completion checklist enforces explicit changed-file counts',
    completionCalls >= 4 &&
      fs.existsSync(path.join(tmpDir, 'count-one.txt')) &&
      fs.existsSync(path.join(tmpDir, 'count-two.txt')) &&
      result.reply.includes('two files') &&
      infoMessages.some((message) => message.includes('expected changed file count missing')),
    `calls=${completionCalls} reply=${result.reply} info=${infoMessages.join(' | ')}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-completion-checklist-expected-verification-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'completion checklist expected verification smoke' })
  await store.save(session)

  let completionCalls = 0
  const infoMessages: string[] = []
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Creating the file before verification.',
            done: false,
            actions: [
              { type: 'write_file', path: 'verified.txt', content: 'verified\n' },
            ],
          }),
          raw: null,
        }
      }

      if (completionCalls === 2) {
        return {
          text: JSON.stringify({
            reply: 'Created verified.txt and ran the requested verification.',
            done: true,
          }),
          raw: null,
        }
      }

      if (completionCalls === 3) {
        return {
          text: JSON.stringify({
            reply: 'Running the requested verification now.',
            done: false,
            actions: [
              { type: 'run_command', command: 'echo test passed' },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Created verified.txt and recorded verification evidence.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Create verified.txt and run tests to verify it.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 5,
      profile: 'main',
      onInfo: (message) => infoMessages.push(message),
    },
  )

  assert(
    'runAgent: deterministic completion checklist enforces explicitly requested verification',
    completionCalls >= 4 &&
      fs.readFileSync(path.join(tmpDir, 'verified.txt'), 'utf8') === 'verified\n' &&
      (session.verificationCommands ?? []).some((entry) => entry.command === 'echo test passed' && entry.ok) &&
      result.reply.includes('verification evidence') &&
      infoMessages.some((message) => message.includes('expected verification command missing')),
    `calls=${completionCalls} reply=${result.reply} commands=${JSON.stringify(session.verificationCommands)} info=${infoMessages.join(' | ')}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-execution-contract-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'execution contract smoke' })
  await store.save(session)

  let completionCalls = 0
  const infoMessages: string[] = []
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Implemented the scaffold successfully.',
            done: true,
          }),
          raw: null,
        }
      }

      if (completionCalls === 2) {
        return {
          text: JSON.stringify({
            reply: 'Creating the scaffold files now.',
            done: true,
            actions: [
              {
                type: 'write_file',
                path: 'blog/README.md',
                content: '# Blog\n',
              },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Created blog/README.md and left the scaffold in the workspace.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Create a minimal blog scaffold in this workspace.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 5,
      profile: 'main',
      completionContract: 'requires_execution_evidence',
      onInfo: (message) => infoMessages.push(message),
    },
  )

  assert(
    'runAgent: execution contract forces a follow-up turn after evidence-free completion text',
    completionCalls >= 3,
    `calls=${completionCalls}`,
  )
  assert(
    'runAgent: execution contract still executes actions when the model marks that action turn as done',
    infoMessages.some((message) =>
      message.includes('reply marked complete but still requested actions'),
    ),
    infoMessages.join(' | '),
  )
  assert(
    'runAgent: execution contract writes the scaffold file before returning success',
    fs.existsSync(path.join(tmpDir, 'blog', 'README.md')),
  )
  assert(
    'runAgent: execution contract returns the grounded final reply',
    result.reply.includes('Created blog/README.md'),
    result.reply,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-trimmed-action-followup-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'trimmed action follow-up smoke' })
  await store.save(session)

  let completionCalls = 0
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Writing the initial storefront scaffold now.',
            done: false,
            actions: [
              { type: 'write_file', path: 'src/App.jsx', content: 'export default function App() { return null }\n' },
              { type: 'write_file', path: 'src/index.css', content: 'body { margin: 0; }\n' },
              { type: 'write_file', path: 'src/components/Navbar.jsx', content: 'export function Navbar() { return null }\n' },
              { type: 'write_file', path: 'src/components/Footer.jsx', content: 'export function Footer() { return null }\n' },
              { type: 'write_file', path: 'src/components/ProductGrid.jsx', content: 'export function ProductGrid() { return null }\n' },
              { type: 'write_file', path: 'src/components/Newsletter.jsx', content: 'export function Newsletter() { return null }\n' },
              { type: 'write_file', path: 'src/components/HeroSection.jsx', content: 'export function HeroSection() { return null }\n' },
            ],
          }),
          raw: null,
        }
      }

      if (completionCalls === 2) {
        return {
          text: JSON.stringify({
            reply: 'Now creating the HeroSection component:',
            done: true,
          }),
          raw: null,
        }
      }

      if (completionCalls === 3) {
        return {
          text: JSON.stringify({
            reply: 'Creating the remaining deferred component now.',
            done: false,
            actions: [
              { type: 'write_file', path: 'src/components/HeroSection.jsx', content: 'export function HeroSection() { return <section>hero</section> }\n' },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Created HeroSection.jsx and completed the storefront scaffold.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Create a storefront scaffold in this workspace.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 6,
      profile: 'main',
      completionContract: 'requires_execution_evidence',
    },
  )

  assert(
    'runAgent: trimmed action batches do not allow a dangling "Now creating..." reply to finalize execution',
    completionCalls >= 4 &&
      fs.existsSync(path.join(tmpDir, 'src', 'components', 'HeroSection.jsx')) &&
      fs.readFileSync(path.join(tmpDir, 'src', 'components', 'HeroSection.jsx'), 'utf8').includes('<section>hero</section>') &&
      result.reply.includes('HeroSection.jsx'),
    `calls=${completionCalls} reply=${result.reply}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-command-evidence-followup-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'command evidence follow-up smoke' })
  await store.save(session)

  let completionCalls = 0
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'I am creating the app directory now.',
            done: false,
            actions: [
              {
                type: 'run_command',
                command: 'mkdir -p app',
              },
            ],
          }),
          raw: null,
        }
      }

      if (completionCalls === 2) {
        return {
          text: JSON.stringify({
            reply: 'Completed the app scaffold.',
            done: true,
          }),
          raw: null,
        }
      }

      if (completionCalls === 3) {
        return {
          text: JSON.stringify({
            reply: 'Verifying the generated workspace artifacts now.',
            done: false,
            actions: [
              {
                type: 'list_files',
                pattern: 'app',
              },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Verified the app directory exists and completed the scaffold step.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Create an app scaffold in this workspace.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 6,
      profile: 'main',
      completionContract: 'requires_execution_evidence',
    },
  )

  assert(
    'runAgent: shell mutations cannot finalize before a grounded follow-up verifies what changed',
    completionCalls >= 4 &&
      fs.existsSync(path.join(tmpDir, 'app')) &&
      result.reply.includes('Verified the app directory exists'),
    `calls=${completionCalls} reply=${result.reply}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-cwd-persistence-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'cwd persistence smoke' })
  await store.save(session)

  let completionCalls = 0
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: JSON.stringify({
            reply: '先进入 nested 目录。',
            done: false,
            actions: [
              {
                type: 'run_command',
                command: 'mkdir -p nested && cd nested && pwd',
              },
            ],
          }),
          raw: null,
        }
      }

      if (completionCalls === 2) {
        return {
          text: JSON.stringify({
            reply: '继续在新目录里写入文件。',
            done: false,
            actions: [
              {
                type: 'write_file',
                path: 'note.txt',
                content: 'cwd persisted\n',
              },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: '已在切换后的目录里完成写入。',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Enter nested and create note.txt there.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 4,
      profile: 'main',
    },
  )

  const persistedSession = await store.load(session.id)
  const nestedDir = fs.realpathSync(path.join(tmpDir, 'nested'))
  const nestedFile = path.join(nestedDir, 'note.txt')

  assert(
    'runAgent: run_command cwd changes persist into later relative-path tool actions',
    completionCalls >= 3 &&
      fs.existsSync(nestedFile) &&
      !fs.existsSync(path.join(tmpDir, 'note.txt')) &&
      fs.readFileSync(nestedFile, 'utf8') === 'cwd persisted\n',
    `calls=${completionCalls} cwd=${persistedSession.cwd} reply=${result.reply}`,
  )

  assert(
    'runAgent: session cwd updates after a successful shell cd',
    persistedSession.cwd === nestedDir,
    persistedSession.cwd,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-read-batch-parallel-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'alpha\n', 'utf8')
  fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'bravo\n', 'utf8')
  fs.writeFileSync(path.join(tmpDir, 'c.txt'), 'charlie\n', 'utf8')
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'read batch parallel smoke' })
  await store.save(session)

  const readTool = getToolDefinition('read_file')
  const originalReadExecute = readTool?.execute
  let activeReads = 0
  let maxActiveReads = 0
  let completionCalls = 0
  const infoMessages: string[] = []

  if (readTool && originalReadExecute) {
    readTool.execute = async (action, context) => {
      activeReads += 1
      maxActiveReads = Math.max(maxActiveReads, activeReads)
      try {
        await sleep(60)
        return await originalReadExecute(action, context)
      } finally {
        activeReads -= 1
      }
    }
  }

  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Reading three files.',
            done: false,
            actions: [
              { type: 'read_file', path: 'a.txt' },
              { type: 'read_file', path: 'b.txt' },
              { type: 'read_file', path: 'c.txt' },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Read all three files.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  try {
    await runAgent(
      session,
      'Read a.txt, b.txt, and c.txt.',
      {
        cwd: tmpDir,
        provider,
        sessionStore: store,
        permissionManager: new PermissionManager('accept-all', false),
        maxTurns: 3,
        profile: 'main',
        onInfo: (message) => infoMessages.push(message),
      },
    )
  } finally {
    if (readTool && originalReadExecute) {
      readTool.execute = originalReadExecute
    }
  }

  const persistedSession = await store.load(session.id)
  const readPayloads = (persistedSession?.messages ?? [])
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.parse(message.content))
    .filter((payload) => payload?.action?.type === 'read_file')
  const readPaths = readPayloads.map((payload) => payload.action.path)

  assert(
    'runAgent: consecutive read_file actions execute in parallel and keep result order',
    Boolean(originalReadExecute) &&
      completionCalls >= 2 &&
      maxActiveReads > 1 &&
      eq(readPaths, ['a.txt', 'b.txt', 'c.txt']) &&
      infoMessages.some((message) => message.includes('[tool-batch] running 3 read-only tools in parallel')),
    `maxActiveReads=${maxActiveReads} paths=${readPaths.join(', ')} info=${infoMessages.join(' | ')}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-read-write-order-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'target.txt'), 'old value\n', 'utf8')
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'read write ordering smoke' })
  await store.save(session)

  let completionCalls = 0
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Read, update, then read again.',
            done: false,
            actions: [
              { type: 'read_file', path: 'target.txt' },
              { type: 'write_file', path: 'target.txt', content: 'new value\n' },
              { type: 'read_file', path: 'target.txt' },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Verified the updated file.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  await runAgent(
    session,
    'Update target.txt and verify the new content.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 3,
      profile: 'main',
    },
  )

  const persistedSession = await store.load(session.id)
  const toolPayloads = (persistedSession?.messages ?? [])
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.parse(message.content))
  const readOutputs = toolPayloads
    .filter((payload) => payload?.action?.type === 'read_file')
    .map((payload) => String(payload.output))

  assert(
    'runAgent: read_file -> write_file -> read_file preserves execution order',
    completionCalls >= 2 &&
      readOutputs[0]?.includes('old value') &&
      readOutputs[1]?.includes('new value') &&
      fs.readFileSync(path.join(tmpDir, 'target.txt'), 'utf8') === 'new value\n',
    readOutputs.join(' | '),
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-write-batch-serial-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'write serial smoke' })
  await store.save(session)

  const writeTool = getToolDefinition('write_file')
  const originalWriteExecute = writeTool?.execute
  let activeWrites = 0
  let maxActiveWrites = 0
  let completionCalls = 0

  if (writeTool && originalWriteExecute) {
    writeTool.execute = async (action, context) => {
      activeWrites += 1
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
      try {
        await sleep(40)
        return await originalWriteExecute(action, context)
      } finally {
        activeWrites -= 1
      }
    }
  }

  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Writing the same file three times.',
            done: false,
            actions: [
              { type: 'write_file', path: 'same.txt', content: 'one\n' },
              { type: 'write_file', path: 'same.txt', content: 'two\n' },
              { type: 'write_file', path: 'same.txt', content: 'three\n' },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Finished serial writes.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  try {
    await runAgent(
      session,
      'Write same.txt three times.',
      {
        cwd: tmpDir,
        provider,
        sessionStore: store,
        permissionManager: new PermissionManager('accept-all', false),
        maxTurns: 3,
        profile: 'main',
      },
    )
  } finally {
    if (writeTool && originalWriteExecute) {
      writeTool.execute = originalWriteExecute
    }
  }

  assert(
    'runAgent: same-path writes stay serial and preserve final write',
    Boolean(originalWriteExecute) &&
      completionCalls >= 2 &&
      maxActiveWrites === 1 &&
      fs.readFileSync(path.join(tmpDir, 'same.txt'), 'utf8') === 'three\n',
    `maxActiveWrites=${maxActiveWrites}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-permission-serial-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'permission serial smoke' })
  await store.save(session)

  class TrackingPermissionManager extends PermissionManager {
    activeAuthorizations = 0
    maxActiveAuthorizations = 0

    async authorize(action: Parameters<PermissionManager['authorize']>[0]): ReturnType<PermissionManager['authorize']> {
      this.activeAuthorizations += 1
      this.maxActiveAuthorizations = Math.max(
        this.maxActiveAuthorizations,
        this.activeAuthorizations,
      )
      try {
        await sleep(30)
        return { allowed: false, reason: `${action.type} denied by smoke test` }
      } finally {
        this.activeAuthorizations -= 1
      }
    }
  }

  const permissionManager = new TrackingPermissionManager('prompt', false)
  let completionCalls = 0
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Requesting two writes that require permission.',
            done: false,
            actions: [
              { type: 'write_file', path: 'first.txt', content: 'first\n' },
              { type: 'write_file', path: 'second.txt', content: 'second\n' },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Permission denials handled.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  await runAgent(
    session,
    'Try two writes in prompt mode.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager,
      maxTurns: 3,
      profile: 'main',
    },
  )

  assert(
    'runAgent: permission authorization is never parallelized',
    completionCalls >= 2 &&
      permissionManager.maxActiveAuthorizations === 1 &&
      !fs.existsSync(path.join(tmpDir, 'first.txt')) &&
      !fs.existsSync(path.join(tmpDir, 'second.txt')),
    `maxActiveAuthorizations=${permissionManager.maxActiveAuthorizations}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-native-tool-invalid-args-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'native tool invalid args smoke' })
  await store.save(session)

  let completionCalls = 0
  let capturedToolOutputs: ProviderNativeToolOutput[] | undefined

  const provider: ChatProvider = {
    supportsNativeToolCalls: true,
    async complete(_messages, options): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: '',
          raw: null,
          responseId: 'resp-invalid-args-1',
          nativeToolCalls: [
            {
              name: 'read_file',
              arguments: '{}',
              callId: 'call-invalid-read',
            },
          ],
        }
      }

      capturedToolOutputs = options?.toolOutputs
      return {
        text: JSON.stringify({
          reply: 'handled invalid tool arguments',
          done: true,
        }),
        raw: null,
        responseId: 'resp-invalid-args-2',
      }
    },
  }

  const result = await runAgent(
    session,
    'Inspect README.md.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 2,
      profile: 'main',
    },
  )

  const invalidArgsPayload = capturedToolOutputs?.[0]
    ? JSON.parse(capturedToolOutputs[0].output)
    : null

  assert(
    'runAgent native tools: invalid tool arguments are returned as structured error payloads',
    completionCalls === 2 &&
      invalidArgsPayload?.ok === false &&
      invalidArgsPayload?.toolName === 'read_file' &&
      invalidArgsPayload?.error?.code === 'tool_invalid_arguments' &&
      Array.isArray(invalidArgsPayload?.error?.details?.errors) &&
      invalidArgsPayload.error.details.errors.some((entry: unknown) => String(entry).includes('path is required')) &&
      result.reply === 'handled invalid tool arguments',
    JSON.stringify(invalidArgsPayload),
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-native-tool-permission-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'native tool permission smoke' })
  await store.save(session)

  let completionCalls = 0
  let capturedToolOutputs: ProviderNativeToolOutput[] | undefined

  const provider: ChatProvider = {
    supportsNativeToolCalls: true,
    async complete(_messages, options): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: '',
          raw: null,
          responseId: 'resp-permission-1',
          nativeToolCalls: [
            {
              name: 'write_file',
              arguments: JSON.stringify({
                path: 'blocked.txt',
                content: 'nope\n',
              }),
              callId: 'call-blocked-write',
            },
          ],
        }
      }

      capturedToolOutputs = options?.toolOutputs
      return {
        text: JSON.stringify({
          reply: 'permission denial captured',
          done: true,
        }),
        raw: null,
        responseId: 'resp-permission-2',
      }
    },
  }

  const result = await runAgent(
    session,
    'Try to write a file.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('read-only', false),
      maxTurns: 2,
      profile: 'main',
    },
  )

  const permissionPayload = capturedToolOutputs?.[0]
    ? JSON.parse(capturedToolOutputs[0].output)
    : null

  assert(
    'runAgent native tools: permission denials are returned as structured error payloads',
    completionCalls === 2 &&
      permissionPayload?.ok === false &&
      permissionPayload?.action?.type === 'write_file' &&
      permissionPayload?.error?.code === 'tool_permission_denied' &&
      permissionPayload?.output?.includes('Permission denied') &&
      !fs.existsSync(path.join(tmpDir, 'blocked.txt')) &&
      result.reply === 'permission denial captured',
    JSON.stringify(permissionPayload),
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-direct-tool-reported-failure-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'direct tool reported failure smoke' })
  await store.save(session)

  let completionCalls = 0
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: JSON.stringify({
            reply: 'Reading a missing file.',
            done: false,
            actions: [
              { type: 'read_file', path: 'missing.txt' },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: 'Failed: missing.txt is unavailable, and the tool failure was acknowledged.',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Read missing.txt and report whether it exists.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 3,
      profile: 'main',
    },
  )

  const readFailurePayload = session.messages
    .filter((message) => message.role === 'tool' && message.name === 'read_file')
    .map((message) => JSON.parse(message.content))
    .find((payload) => payload?.action?.type === 'read_file')

  assert(
    'runAgent direct tools: ok=false executor results without errors receive structured tool_reported_failure',
    completionCalls === 2 &&
      readFailurePayload?.ok === false &&
      readFailurePayload?.error?.code === 'tool_reported_failure' &&
      result.reply.includes('tool failure was acknowledged'),
    JSON.stringify(readFailurePayload),
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-legacy-read-actions-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"legacy-read-actions"}\n', 'utf8')
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'legacy read actions smoke' })
  await store.save(session)

  let completionCalls = 0
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: [
            '我先查看当前目录结构和 package.json。',
            '{',
            '  "reply": "我先查看当前目录结构和 package.json。",',
            '  "done": false,',
            '  "actions": [',
            '    { "tool_name": "list_files", "args": { "target": "." } },',
            '    { "tool_name": "read_file", "args": { "target": "package.json" } }',
            '  ]',
            '}',
          ].join('\n'),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: '已查看目录和 package.json。',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Inspect this workspace and read package.json.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 3,
      profile: 'researcher',
    },
  )

  const toolNames = session.messages
    .filter((message) => message.role === 'tool')
    .map((message) => message.name)

  assert(
    'runAgent: embedded prose + legacy tool_name read actions are recovered and executed',
    completionCalls === 2 &&
      toolNames.includes('list_files') &&
      toolNames.includes('read_file') &&
      result.reply.includes('已查看目录和 package.json。'),
    `calls=${completionCalls} tools=${toolNames.join(',')} reply=${result.reply}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-legacy-write-actions-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'legacy write actions smoke' })
  await store.save(session)

  let completionCalls = 0
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: [
            '我先落地创建首页文件。',
            '{',
            '  "reply": "我先落地创建首页文件。",',
            '  "done": false,',
            '  "actions": [',
            '    { "tool_name": "write_file", "args": {',
            '      "target": "frontend/index.html",',
            '      "content": "<!doctype html><title>Legacy Action</title>"',
            '    } }',
            '  ]',
            '}',
          ].join('\n'),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: '已创建 frontend/index.html。',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Create a minimal landing page in frontend/index.html.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 4,
      profile: 'main',
      completionContract: 'requires_execution_evidence',
    },
  )

  assert(
    'runAgent: embedded prose + legacy tool_name write actions satisfy the execution contract',
    completionCalls >= 2 &&
      fs.existsSync(path.join(tmpDir, 'frontend', 'index.html')) &&
      result.reply.includes('frontend/index.html'),
    `calls=${completionCalls} exists=${fs.existsSync(path.join(tmpDir, 'frontend', 'index.html'))} reply=${result.reply}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-xml-name-write-actions-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'xml name write actions smoke' })
  await store.save(session)

  let completionCalls = 0
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: [
            '正在构建页面。',
            '<tool_calls>',
            '<call name="write_file">{"filePath":"frontend/index.html","content":"<!doctype html><title>XML Action</title>\\n"}</call>',
            '</tool_calls>',
          ].join('\n'),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: '已创建 frontend/index.html。',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Create a minimal landing page in frontend/index.html.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 4,
      profile: 'main',
      completionContract: 'requires_execution_evidence',
    },
  )

  assert(
    'runAgent: <call name> pseudo write_file actions are recovered and executed',
    completionCalls >= 2 &&
      fs.readFileSync(path.join(tmpDir, 'frontend', 'index.html'), 'utf8') ===
        '<!doctype html><title>XML Action</title>\n' &&
      result.reply.includes('frontend/index.html'),
    `calls=${completionCalls} exists=${fs.existsSync(path.join(tmpDir, 'frontend', 'index.html'))} reply=${result.reply}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-exec-no-fallback-reads-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'execution no fallback read smoke' })
  await store.save(session)

  let completionCalls = 0
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: JSON.stringify({
            reply: '我将先创建 frontend 目录和基础文件。',
            done: false,
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: '我仍然还没有实际执行任何工具。',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    [
      'Original request: create frontend files.',
      '',
      'Repo snapshot:',
      '- src/core/agent.ts',
      '- src/core/agentProfiles.ts',
    ].join('\n'),
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 2,
      profile: 'main',
      completionContract: 'requires_execution_evidence',
    },
  )

  const toolNames = session.messages
    .filter((message) => message.role === 'tool')
    .map((message) => message.name)

  assert(
    'runAgent: execution contract does not synthesize fallback read_file actions from repo-snapshot paths and checklist blocks final',
    completionCalls === 2 &&
      !toolNames.includes('read_file') &&
      result.reply.includes('deterministic completion checklist'),
    `calls=${completionCalls} tools=${toolNames.join(',')} reply=${result.reply}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-exec-readonly-shell-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'personal_intro.html'), '<!doctype html><h1>old</h1>\n', 'utf8')
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'readonly shell should not finish mutation task' })
  await store.save(session)

  let completionCalls = 0
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: JSON.stringify({
            reply: '我先确认当前目录结构。',
            done: false,
            actions: [
              {
                type: 'run_command',
                command: 'pwd; ls -la',
              },
            ],
          }),
          raw: null,
        }
      }

      if (completionCalls === 2) {
        return {
          text: JSON.stringify({
            reply: '发现仓库内已有 personal_intro.html 文件，这是一个已有的个人主页。检查该文件内容以了解当前实现。',
            done: true,
          }),
          raw: null,
        }
      }

      if (completionCalls === 3) {
        return {
          text: JSON.stringify({
            reply: '我现在实际改写 personal_intro.html。',
            done: false,
            actions: [
              {
                type: 'write_file',
                path: 'personal_intro.html',
                content: '<!doctype html><h1>new</h1>\n',
              },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: '已改写 personal_intro.html。',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    [
      'Original request: 帮我制作一个个人主页。',
      '',
      'Task:',
      '- Turn the Niko recommendation into real progress now.',
      '- If the request can be implemented safely in the workspace, do the smallest high-confidence implementation instead of repeating the plan.',
    ].join('\n'),
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 5,
      profile: 'main',
      completionContract: 'requires_execution_evidence',
    },
  )

  assert(
    'runAgent: read-only shell inspection does not satisfy execution evidence for mutation tasks',
    completionCalls >= 4 &&
      fs.readFileSync(path.join(tmpDir, 'personal_intro.html'), 'utf8').includes('<h1>new</h1>') &&
      result.reply.includes('personal_intro.html'),
    `calls=${completionCalls} reply=${result.reply}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

{
  const tmpDir = path.join(os.tmpdir(), `artemis-exec-investigation-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'investigation can finish after read-only tools' })
  await store.save(session)

  let completionCalls = 0
  const provider: ChatProvider = {
    async complete(): Promise<ProviderResponse> {
      completionCalls += 1

      if (completionCalls === 1) {
        return {
          text: JSON.stringify({
            reply: '我先确认当前工作区位置。',
            done: false,
            actions: [
              {
                type: 'run_command',
                command: 'pwd',
              },
            ],
          }),
          raw: null,
        }
      }

      return {
        text: JSON.stringify({
          reply: '已确认当前工作区路径。',
          done: true,
        }),
        raw: null,
      }
    },
  }

  const result = await runAgent(
    session,
    'Inspect the current workspace path and report it back.',
    {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 3,
      profile: 'main',
      completionContract: 'requires_execution_evidence',
    },
  )

  assert(
    'runAgent: investigation-style execution tasks may finish after read-only tool evidence',
    completionCalls === 2 &&
      result.reply.includes('当前工作区路径'),
    `calls=${completionCalls} reply=${result.reply}`,
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
}

// ── Context compression: OpenAI tool_calls pairing ──────────────────────────

{
  const now = new Date().toISOString()
  let summarizePrompt = ''
  const messages: SessionMessage[] = [
    { id: 'u1', role: 'user', content: 'head', createdAt: now },
    {
      id: 't1',
      role: 'tool',
      content: JSON.stringify({
        ok: false,
        action: { type: 'insert_in_file', path: 'src/core/agent.ts' },
        output: `${'x'.repeat(900)} tool_invalid_arguments atLine must be a positive integer ${'y'.repeat(900)}`,
        error: { code: 'tool_invalid_arguments', message: 'Invalid arguments: atLine must be a positive integer' },
      }),
      name: 'insert_in_file',
      createdAt: now,
    },
    { id: 'u2', role: 'user', content: 'tail '.repeat(2_000), createdAt: now },
  ]

  await manageContext({
    messages,
    fixedTokens: 200,
    budget: resolveContextBudget({ contextWindow: 8_000 }),
    state: createContextState(),
    summarize: sectionSummarizer((prompt) => { summarizePrompt += prompt }),
    reason: 'manual',
  })

  assert(
    'context compression: failed tool results keep actionable error details for summarization',
    summarizePrompt.includes('tool_invalid_arguments') && summarizePrompt.includes('atLine must be a positive integer'),
  )
}

{
  const now = new Date().toISOString()
  const currentTaskMarker = 'CURRENT_TASK_MARKER_keep_latest_requirement_after_compression'
  const modifiedFile = 'src/core/compaction/manager.ts'
  const messages: SessionMessage[] = [
    { id: 'u1', role: 'user', content: `Please continue the context compression audit. ${currentTaskMarker} ${'x'.repeat(900)}`, createdAt: now },
    { id: 'a1', role: 'assistant', content: `I changed ${modifiedFile} and still need to validate.`, createdAt: now },
    { id: 'u2', role: 'user', content: 'tail '.repeat(2_000), createdAt: now },
  ]

  let summarizePrompt = ''
  const result = await manageContext({
    messages,
    fixedTokens: 200,
    budget: resolveContextBudget({ contextWindow: 8_000 }),
    state: createContextState(),
    summarize: sectionSummarizer((prompt) => { summarizePrompt += prompt }, /CURRENT_TASK_MARKER_\w+|src\/[\w./-]+/g),
    reason: 'manual',
  })

  const compactedContent = result.messages.map(m => m.content).join('\n')
  assert(
    'context compression: summary prompt preserves longer latest user task markers',
    summarizePrompt.includes(currentTaskMarker),
    summarizePrompt.slice(0, 500),
  )
  assert(
    'context compression: structured summary preserves current task, modified files, and all required sections',
    compactedContent.includes(currentTaskMarker) &&
      compactedContent.includes(modifiedFile) &&
      summarySectionTitles('en').every((title) => compactedContent.includes(title)) &&
      summarizePrompt.includes('Pending tasks and next step') &&
      summarizePrompt.includes('Files and artifacts'),
    compactedContent.slice(0, 800),
  )
}

{
  const now = new Date().toISOString()
  const messages: SessionMessage[] = [
    { id: 'u1', role: 'user', content: 'head', createdAt: now },
    {
      id: 'a1',
      role: 'assistant',
      content: 'calling list_files',
      toolCalls: [{ id: 'call_1', name: 'list_files', arguments: '{}' }],
      createdAt: now,
    },
    { id: 't1', role: 'tool', content: '["alpha.txt"]', name: 'list_files', toolUseId: 'call_1', createdAt: now },
    { id: 'u2', role: 'user', content: 'x'.repeat(2400), createdAt: now },
  ]

  const result = await manageContext({
    messages,
    fixedTokens: 100,
    budget: resolveContextBudget({ contextWindow: 4_000 }),
    state: createContextState(),
    summarize: sectionSummarizer(),
    reason: 'manual',
  })

  assert(
    'context compression: head boundary does not split OpenAI tool_calls from tool results',
    openAIToolCallsRemainPaired(result.messages) && result.messages[0]?.role !== 'tool',
  )
}

{
  const now = new Date().toISOString()
  const messages: SessionMessage[] = [
    { id: 'u1', role: 'user', content: 'x'.repeat(2400), createdAt: now },
    { id: 'u2', role: 'user', content: 'y'.repeat(2400), createdAt: now },
    {
      id: 'a1',
      role: 'assistant',
      content: 'calling read_file for the requested path',
      toolCalls: [{ id: 'call_2', name: 'read_file', arguments: '{"path":"README.md"}' }],
      createdAt: now,
    },
    { id: 't1', role: 'tool', content: '# README', name: 'read_file', toolUseId: 'call_2', createdAt: now },
    { id: 'u3', role: 'user', content: 'tail', createdAt: now },
  ]

  const result = await manageContext({
    messages,
    fixedTokens: 100,
    budget: resolveContextBudget({ contextWindow: 4_000 }),
    state: createContextState(),
    summarize: sectionSummarizer(),
    reason: 'manual',
  })

  assert(
    'context compression: tail boundary does not split OpenAI tool_calls from tool results',
    openAIToolCallsRemainPaired(result.messages) && result.messages.every((m, i) => m.role !== 'tool' || i > 0),
  )
}

// ── Tool-type-aware clearing of old tool results ──────────────────────────────

{
  const now = new Date().toISOString()
  const messages: SessionMessage[] = [
    { id: 'u1', role: 'user', content: 'read and modify file', createdAt: now },
    // A read_file output — cleared when old (the file can be read again)
    { id: 't1', role: 'tool', content: 'x'.repeat(20_000), name: 'read_file', createdAt: now },
    // A write_file output — PRESERVED (execution evidence)
    { id: 't2', role: 'tool', content: 'y'.repeat(20_000), name: 'write_file', createdAt: now },
    { id: 'u2', role: 'user', content: 'continue', createdAt: now },
  ]

  const result = await manageContext({
    messages,
    fixedTokens: 500,
    budget: resolveContextBudget({ contextWindow: 16_000 }),
    state: createContextState(),
  })

  const readFileMsg = result.messages.find(m => m.id === 't1')
  assert(
    'microcompact: read_file tool output is compacted',
    result.action === 'clear_tool_results' && readFileMsg != null && readFileMsg.content.length < 200,
    `action=${result.action} len=${readFileMsg?.content.length}`,
  )

  const writeFileMsg = result.messages.find(m => m.id === 't2')
  assert(
    'microcompact: write_file tool output is PRESERVED as evidence',
    writeFileMsg != null && writeFileMsg.content.length === 20_000,
  )
}

// ── No idle-time short-circuit ────────────────────────────────────────────────

{
  // The old time-based microcompact returned early after a 42-minute gap and
  // skipped full compaction, sending ~405K tokens to a 128K window. An idle
  // gap must not change whether the history is brought under the window.
  const old = new Date(Date.now() - 60 * 60_000).toISOString()
  const messages: SessionMessage[] = []
  for (let i = 0; i < 300; i += 1) {
    messages.push({ id: `u${i}`, role: 'user', content: '聊天'.repeat(400), createdAt: old })
    messages.push({ id: `a${i}`, role: 'assistant', content: 'reply '.repeat(300), createdAt: old })
    messages.push({ id: `t${i}`, role: 'tool', name: 'run_command', content: 'log '.repeat(300), createdAt: old })
  }
  messages.push({ id: 'new', role: 'user', content: 'hi again', createdAt: new Date().toISOString() })
  const budget = resolveContextBudget({ contextWindow: 128_000 })
  let calls = 0
  const result = await manageContext({
    messages,
    fixedTokens: 8_000,
    budget,
    state: createContextState(),
    summarize: sectionSummarizer(() => { calls += 1 }),
  })
  assert(
    'context compression: an idle gap does not short-circuit compaction; the request fits the window',
    result.tokensBefore > 128_000 && result.tokensAfter <= budget.threshold && calls >= 1 && result.action === 'summary',
    `before=${result.tokensBefore} after=${result.tokensAfter} calls=${calls}`,
  )

  const recent: SessionMessage[] = [
    { id: 'u1', role: 'user', content: 'do something', createdAt: old },
    { id: 'a1', role: 'assistant', content: 'sure', createdAt: old },
    { id: 't1', role: 'tool', content: 'z'.repeat(5_000), name: 'read_file', createdAt: old },
    { id: 'u2', role: 'user', content: 'continue', createdAt: new Date().toISOString() },
  ]
  const untouched = await manageContext({ messages: recent, fixedTokens: 8_000, budget, state: createContextState() })
  assert(
    'context compression: a small history is left untouched after an idle gap (cache-friendly)',
    untouched.action === 'none' && untouched.changed === false && untouched.messages[2]?.content.length === 5_000,
  )
}

// ── Ledger FileStateSnapshot creation ────────────────────────────────────────

{
  const { createFileStateSnapshot, hashContent } = await import('../src/core/collapse/ledger.js')

  const testContent = 'export function hello() { return "world" }\n'
  const snapshot = createFileStateSnapshot('/tmp/test-file.ts', testContent, Date.now())

  assert(
    'collapse ledger: createFileStateSnapshot returns correct filePath',
    snapshot.filePath === '/tmp/test-file.ts',
  )
  assert(
    'collapse ledger: createFileStateSnapshot computes content hash',
    snapshot.contentHash === hashContent(testContent),
  )
  assert(
    'collapse ledger: createFileStateSnapshot captures head content',
    snapshot.headContent === testContent,
  )
}

// ── Provider-native tool loop ────────────────────────────────────────────────

{
  const originalCwd = process.cwd()
  const tmpDir = path.join(os.tmpdir(), `artemis-native-tools-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'alpha.txt'), 'alpha\n', 'utf8')

  const requests: Array<Record<string, unknown>> = []
  let requestCount = 0

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      requests.push(body)
      requestCount += 1

      if (req.url !== '/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })

      if (requestCount === 1) {
        res.end(JSON.stringify({
          model: 'mock-openai-compatible',
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_list_files_1',
                type: 'function',
                function: {
                  name: 'list_files',
                  arguments: '{}',
                },
              }],
            },
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
          },
        }))
        return
      }

      res.end(JSON.stringify({
        model: 'mock-openai-compatible',
        choices: [{
          message: {
            content: '当前目录包含 alpha.txt。',
          },
        }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }))
    })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Mock provider server failed to bind to a TCP port.')
    }

    const providersPath = path.join(tmpDir, '.artemis', 'providers.json')
    fs.writeFileSync(providersPath, JSON.stringify({
      defaultMainProfileId: 'mock-openai',
      profiles: [{
        id: 'mock-openai',
        label: 'Mock OpenAI-compatible',
        protocol: 'openai',
        apiKey: 'test-key',
        model: 'mock-openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}`,
      }],
    }, null, 2), 'utf8')

    process.chdir(tmpDir)
    resetSession()
    applyProviderOverrides({})

    const streamed: string[] = []
    const result = await think(
      '列出当前目录里有哪些文件',
      (delta) => streamed.push(delta),
      {
        cwd: tmpDir,
        permissionMode: 'accept-all',
      },
    )

    const firstRequestTools =
      ((requests[0]?.tools as Array<{ name?: string; function?: { name?: string } }> | undefined) ?? [])
    const firstToolNames = firstRequestTools
      .map((entry) => entry?.name ?? entry?.function?.name)
      .filter((value): value is string => typeof value === 'string')
    const firstRequestMessages =
      ((requests[0]?.messages as Array<Record<string, unknown>> | undefined) ?? [])
    const toolRoundRequest = requests.find((request, index) =>
      index > 0 && ((request.messages as Array<Record<string, unknown>> | undefined) ?? [])
        .some((message) => message.role === 'tool' && message.tool_call_id === 'call_list_files_1'))
    const secondRequestMessages =
      ((toolRoundRequest?.messages as Array<Record<string, unknown>> | undefined) ?? [])
    const echoedToolMessage = secondRequestMessages.find(
      (message) =>
        message.role === 'tool' &&
        message.tool_call_id === 'call_list_files_1',
    )
    const providerStore = new ProviderStore(tmpDir)
    const providerData = await providerStore.load()
    const telemetryProfile = providerData.profiles.find((profile) => profile.id === 'mock-openai')

    assert(
      'native tool loop: provider received two chat/completions requests',
      requests.length >= 2 && requests.length <= 3,
      `requests=${requests.length}`,
    )
    assert(
      'native tool loop: coding requests start with a projected direct tool manifest',
      firstToolNames.length > 0 && firstToolNames.length < expectedDirectToolCount,
      `tools=${firstToolNames.length}`,
    )
    assert(
      'native tool loop: first request includes repo inspection tools without unrelated media tools',
      firstToolNames.includes('list_files') &&
        firstToolNames.includes('read_file') &&
        firstToolNames.includes('search_files') &&
        firstToolNames.includes('run_command') &&
        !firstToolNames.includes('generate_image') &&
        !firstToolNames.includes('generate_video'),
      firstToolNames.join(', '),
    )
    assert(
      'native tool loop: first request carries a system prompt message',
      firstRequestMessages.some((message) => message.role === 'system'),
      JSON.stringify(firstRequestMessages),
    )
    assert(
      'native tool loop: tool result was sent back as an OpenAI tool message',
      typeof echoedToolMessage?.content === 'string' &&
        echoedToolMessage.content.includes('alpha.txt'),
      JSON.stringify(echoedToolMessage),
    )
    assert(
      'native tool loop: think() returned the provider final reply after tool execution',
      result.reply === '当前目录包含 alpha.txt。',
      result.reply,
    )
    assert(
      'provider telemetry: think() surfaces the active profile label in usage',
      result.usage?.profileLabel === 'Mock OpenAI-compatible',
      JSON.stringify(result.usage),
    )
    assert(
      'provider telemetry: think() returns cumulative turn token usage',
      (result.tokenStats?.promptTokens ?? 0) >= 22 &&
        (result.tokenStats?.completionTokens ?? 0) >= 6 &&
        (result.tokenStats?.totalTokens ?? 0) >= 28,
      JSON.stringify(result.tokenStats),
    )
    assert(
      'provider telemetry: per-profile latency samples persist back into providers.json',
      (telemetryProfile?.telemetry?.sampleCount ?? 0) >= 2 &&
        typeof telemetryProfile?.telemetry?.lastDurationMs === 'number' &&
        typeof telemetryProfile?.telemetry?.lastFirstResponseMs === 'number',
      JSON.stringify(telemetryProfile?.telemetry),
    )
    assert(
      'native tool loop: streamed output contains no fabricated run_command transcript',
      !streamed.join('').includes('run_command:'),
      streamed.join(''),
    )
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

{
  const originalCwd = process.cwd()
  const tmpDir = path.join(os.tmpdir(), `artemis-native-tool-compaction-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })
  const largePayload = [
    'HEAD-LARGE-TOOL-OUTPUT',
    'commit b45746e Add bundled legacy plugin',
    'x'.repeat(16000),
    'TAIL-LARGE-TOOL-OUTPUT',
  ].join('\n')

  const requests: Array<Record<string, unknown>> = []
  let requestCount = 0

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      requests.push(body)
      requestCount += 1

      if (req.url === '/large-tool-payload') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, output: largePayload }))
        return
      }

      if (req.url !== '/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })

      const chatRequestCount = requests.filter((request) => Array.isArray(request.messages)).length

      if (chatRequestCount === 1) {
        res.end(JSON.stringify({
          model: 'mock-openai-compatible',
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_read_large_1',
                type: 'function',
                function: {
                  name: 'http_request',
                  arguments: JSON.stringify({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/large-tool-payload` }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        }))
        return
      }

      res.end(JSON.stringify({
        model: 'mock-openai-compatible',
        choices: [{ message: { content: '大工具结果已压缩但原文已落盘。' } }],
        usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 },
      }))
    })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Mock provider server failed to bind to a TCP port.')
    }

    fs.writeFileSync(path.join(tmpDir, '.artemis', 'providers.json'), JSON.stringify({
      defaultMainProfileId: 'mock-openai-large-tool',
      profiles: [{
        id: 'mock-openai-large-tool',
        label: 'Mock OpenAI large tool output',
        protocol: 'openai',
        apiKey: 'test-key',
        model: 'mock-openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}`,
      }],
    }, null, 2), 'utf8')

    process.chdir(tmpDir)
    resetSession()
    applyProviderOverrides({})

    const result = await think('请求本地 large-tool-payload 并确认内容', () => {}, {
      cwd: tmpDir,
      permissionMode: 'accept-all',
    })

    const chatRequests = requests.filter((request) => Array.isArray(request.messages))
    const secondRequestMessages =
      ((chatRequests[1]?.messages as Array<Record<string, unknown>> | undefined) ?? [])
    const compactedToolMessage = secondRequestMessages.find(
      (message) => message.role === 'tool' && message.tool_call_id === 'call_read_large_1',
    )
    const compactedContent = String(compactedToolMessage?.content ?? '')
    const artifactPathMatch = compactedContent.match(/Full original output saved at: ([^\n"]+)/) ||
      compactedContent.match(/"artifactPath":\s*"([^"]+)"/)
    const artifactPath = artifactPathMatch?.[1]
    const artifactContent = artifactPath && fs.existsSync(artifactPath)
      ? fs.readFileSync(artifactPath, 'utf8')
      : ''

    assert(
      'native tool loop: large direct tool result is compacted before provider re-entry',
      compactedContent.includes('[Output too large for context') &&
        compactedContent.includes('HEAD-LARGE-TOOL-OUTPUT') &&
        compactedContent.includes('TAIL-LARGE-TOOL-OUTPUT') &&
        compactedContent.includes('Full original output saved at:') &&
        compactedContent.length < 12000,
      `length=${compactedContent.length}`,
    )
    assert(
      'native tool loop: compacted direct tool artifact preserves full original output',
      artifactContent.includes('HEAD-LARGE-TOOL-OUTPUT') &&
        artifactContent.includes('TAIL-LARGE-TOOL-OUTPUT') &&
        artifactContent.includes('x'.repeat(16000)),
      artifactPath,
    )
    assert(
      'provider telemetry: cumulative (billing) usage is not double-counted after native tools',
      result.tokenStats?.promptTokens === 300 &&
        result.tokenStats?.completionTokens === 30 &&
        result.tokenStats?.totalTokens === 330,
      JSON.stringify(result.tokenStats),
    )
    assert(
      'provider telemetry: context size is the last request (200), not the sum across tool rounds (300)',
      getLastPromptTokens() === 200 && result.tokenStats?.contextTokens === 200,
      `last=${getLastPromptTokens()} stats=${JSON.stringify(result.tokenStats)}`,
    )
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

{
  const originalCwd = process.cwd()
  const tmpDir = path.join(os.tmpdir(), `artemis-native-tool-limit-finalizer-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })

  const requests: Array<Record<string, unknown>> = []
  let requestCount = 0

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      requests.push(body)
      requestCount += 1

      if (req.url !== '/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })

      if (requestCount === 1) {
        res.end(JSON.stringify({
          model: 'mock-openai-compatible',
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_list_files_limit_1',
                type: 'function',
                function: {
                  name: 'list_files',
                  arguments: '{}',
                },
              }],
            },
          }],
        }))
        return
      }

      res.end(JSON.stringify({
        model: 'mock-openai-compatible',
        choices: [{
          message: {
            content: '已停止继续调用工具，并总结当前进展。',
          },
        }],
      }))
    })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Mock provider server failed to bind to a TCP port.')
    }

    fs.writeFileSync(path.join(tmpDir, '.artemis', 'providers.json'), JSON.stringify({
      defaultMainProfileId: 'mock-openai',
      profiles: [{
        id: 'mock-openai',
        label: 'Mock OpenAI-compatible',
        protocol: 'openai',
        apiKey: 'test-key',
        model: 'mock-openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}`,
      }],
    }, null, 2), 'utf8')

    process.chdir(tmpDir)
    resetSession()
    applyProviderOverrides({})

    const result = await think('一直检查直到完成', {
      cwd: tmpDir,
      permissionMode: 'accept-all',
      maxNativeToolRounds: 1,
    })

    const secondRequest = requests[1] ?? {}
    const secondTools = secondRequest.tools as unknown[] | undefined
    const secondMessages = (secondRequest.messages as Array<Record<string, unknown>> | undefined) ?? []
    const finalizerMessage = secondMessages.find(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.includes('Do not call any more tools.'),
    )

    assert(
      'native tool loop: exhausted tool budget requests a no-tool final reply',
      requests.length === 2 &&
        (!Array.isArray(secondTools) || secondTools.length === 0) &&
        result.reply === '已停止继续调用工具，并总结当前进展。',
      `requests=${requests.length} tools=${JSON.stringify(secondTools)} reply=${result.reply}`,
    )
    assert(
      'native tool loop: no-tool finalizer includes runtime guard instruction',
      Boolean(finalizerMessage),
      JSON.stringify(secondMessages),
    )
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

{
  const originalCwd = process.cwd()
  const tmpDir = path.join(os.tmpdir(), `artemis-native-tool-failure-payload-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })

  const requests: Array<Record<string, unknown>> = []
  let requestCount = 0

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      requests.push(body)
      requestCount += 1

      if (req.url !== '/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })

      if (requestCount === 1) {
        res.end(JSON.stringify({
          model: 'mock-openai-compatible',
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_read_missing_1',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: JSON.stringify({ path: 'missing.txt' }),
                },
              }],
            },
          }],
        }))
        return
      }

      res.end(JSON.stringify({
        model: 'mock-openai-compatible',
        choices: [{
          message: {
            content: 'missing.txt 读取失败，结构化错误已返回。',
          },
        }],
      }))
    })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Mock provider server failed to bind to a TCP port.')
    }

    fs.writeFileSync(path.join(tmpDir, '.artemis', 'providers.json'), JSON.stringify({
      defaultMainProfileId: 'mock-openai',
      profiles: [{
        id: 'mock-openai',
        label: 'Mock OpenAI-compatible',
        protocol: 'openai',
        apiKey: 'test-key',
        model: 'mock-openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}`,
      }],
    }, null, 2), 'utf8')

    process.chdir(tmpDir)
    resetSession()
    applyProviderOverrides({})

    const result = await think(
      'Read missing.txt and report the failure.',
      undefined,
      {
        cwd: tmpDir,
        permissionMode: 'accept-all',
      },
    )

    const toolRoundRequest = requests.find((request, index) =>
      index > 0 && ((request.messages as Array<Record<string, unknown>> | undefined) ?? [])
        .some((message) => message.role === 'tool' && message.tool_call_id === 'call_read_missing_1'))
    const secondRequestMessages =
      ((toolRoundRequest?.messages as Array<Record<string, unknown>> | undefined) ?? [])
    const toolMessage = secondRequestMessages.find(
      (message) =>
        message.role === 'tool' &&
        message.tool_call_id === 'call_read_missing_1',
    )
    const failurePayload = typeof toolMessage?.content === 'string'
      ? JSON.parse(toolMessage.content)
      : null

    assert(
      'native tool loop: direct tool failures are returned as structured JSON payloads',
      result.reply === 'missing.txt 读取失败，结构化错误已返回。' &&
        failurePayload?.ok === false &&
        failurePayload?.error?.code === 'tool_reported_failure' &&
        String(failurePayload?.output).includes('missing.txt'),
      JSON.stringify({ failurePayload, reply: result.reply }),
    )
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

{
  const originalCwd = process.cwd()
  const tmpDir = path.join(os.tmpdir(), `artemis-native-tool-failure-guard-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })

  const requests: Array<Record<string, unknown>> = []
  let requestCount = 0

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      requests.push(body)
      requestCount += 1

      if (req.url !== '/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })

      if (requestCount === 1) {
        res.end(JSON.stringify({
          model: 'mock-openai-compatible',
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_read_missing_guard_1',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: JSON.stringify({ path: 'missing.txt' }),
                },
              }],
            },
          }],
        }))
        return
      }

      if (requestCount === 2) {
        res.end(JSON.stringify({
          model: 'mock-openai-compatible',
          choices: [{
            message: {
              content: 'missing.txt was read successfully and the task is complete.',
            },
          }],
        }))
        return
      }

      res.end(JSON.stringify({
        model: 'mock-openai-compatible',
        choices: [{
          message: {
            content: 'Failed: missing.txt could not be read, so the task is blocked.',
          },
        }],
      }))
    })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Mock provider server failed to bind to a TCP port.')
    }

    fs.writeFileSync(path.join(tmpDir, '.artemis', 'providers.json'), JSON.stringify({
      defaultMainProfileId: 'mock-openai',
      profiles: [{
        id: 'mock-openai',
        label: 'Mock OpenAI-compatible',
        protocol: 'openai',
        apiKey: 'test-key',
        model: 'mock-openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}`,
      }],
    }, null, 2), 'utf8')

    process.chdir(tmpDir)
    resetSession()
    applyProviderOverrides({})

    const streamed: string[] = []
    const result = await think(
      'Read missing.txt and summarize it.',
      (delta) => streamed.push(delta),
      {
        cwd: tmpDir,
        permissionMode: 'accept-all',
      },
    )

    const thirdRequestMessages =
      ((requests[2]?.messages as Array<Record<string, unknown>> | undefined) ?? [])
    const guardMessage = thirdRequestMessages.find(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.includes('[tool:runtime_guard]') &&
        message.content.includes('missing.txt was read successfully'),
    )

    assert(
      'native tool loop: failed tools block unqualified completion claims before streaming',
      requests.length === 3 &&
        Boolean(guardMessage) &&
        result.reply === 'Failed: missing.txt could not be read, so the task is blocked.' &&
        streamed.join('') === result.reply,
      JSON.stringify({ requests: requests.length, guardMessage, reply: result.reply, streamed: streamed.join('') }),
    )
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

{
  const originalCwd = process.cwd()
  const tmpDir = path.join(os.tmpdir(), `artemis-native-tool-direct-permission-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })

  const requests: Array<Record<string, unknown>> = []
  let requestCount = 0

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      requests.push(body)
      requestCount += 1

      if (req.url !== '/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })

      if (requestCount === 1) {
        res.end(JSON.stringify({
          model: 'mock-openai-compatible',
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_write_blocked_1',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({
                    path: 'blocked.txt',
                    content: 'blocked\n',
                  }),
                },
              }],
            },
          }],
        }))
        return
      }

      res.end(JSON.stringify({
        model: 'mock-openai-compatible',
        choices: [{
          message: {
            content: 'Direct permission denial was structured.',
          },
        }],
      }))
    })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Mock provider server failed to bind to a TCP port.')
    }

    fs.writeFileSync(path.join(tmpDir, '.artemis', 'providers.json'), JSON.stringify({
      defaultMainProfileId: 'mock-openai',
      profiles: [{
        id: 'mock-openai',
        label: 'Mock OpenAI-compatible',
        protocol: 'openai',
        apiKey: 'test-key',
        model: 'mock-openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}`,
      }],
    }, null, 2), 'utf8')

    process.chdir(tmpDir)
    resetSession()
    applyProviderOverrides({})

    const result = await think(
      'Create blocked.txt in this workspace.',
      undefined,
      {
        cwd: tmpDir,
        permissionMode: 'read-only',
      },
    )

    const secondRequestMessages =
      ((requests[1]?.messages as Array<Record<string, unknown>> | undefined) ?? [])
    const toolMessage = secondRequestMessages.find(
      (message) =>
        message.role === 'tool' &&
        message.tool_call_id === 'call_write_blocked_1',
    )
    const permissionPayload = typeof toolMessage?.content === 'string'
      ? JSON.parse(toolMessage.content)
      : null

    assert(
      'native tool loop: direct permission denials are returned as structured JSON payloads',
      result.reply === 'Direct permission denial was structured.' &&
        permissionPayload?.ok === false &&
        permissionPayload?.error?.code === 'tool_permission_denied' &&
        String(permissionPayload?.output).includes('Permission denied'),
      JSON.stringify({ permissionPayload, reply: result.reply }),
    )
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

{
  const originalCwd = process.cwd()
  const tmpDir = path.join(os.tmpdir(), `artemis-native-tool-direct-http-validation-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })

  const requests: Array<Record<string, unknown>> = []
  let requestCount = 0

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      requests.push(body)
      requestCount += 1

      if (req.url !== '/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })

      if (requestCount === 1) {
        res.end(JSON.stringify({
          model: 'mock-openai-compatible',
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_http_missing_url_1',
                type: 'function',
                function: {
                  name: 'http_request',
                  arguments: '{}',
                },
              }],
            },
          }],
        }))
        return
      }

      res.end(JSON.stringify({
        model: 'mock-openai-compatible',
        choices: [{
          message: {
            content: 'Direct http_request validation failure was structured.',
          },
        }],
      }))
    })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Mock provider server failed to bind to a TCP port.')
    }

    fs.writeFileSync(path.join(tmpDir, '.artemis', 'providers.json'), JSON.stringify({
      defaultMainProfileId: 'mock-openai',
      profiles: [{
        id: 'mock-openai',
        label: 'Mock OpenAI-compatible',
        protocol: 'openai',
        apiKey: 'test-key',
        model: 'mock-openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}`,
      }],
    }, null, 2), 'utf8')

    process.chdir(tmpDir)
    resetSession()
    applyProviderOverrides({})

    const result = await think(
      'Send the requested HTTP request.',
      undefined,
      {
        cwd: tmpDir,
        permissionMode: 'accept-all',
      },
    )

    const secondRequestMessages =
      ((requests[1]?.messages as Array<Record<string, unknown>> | undefined) ?? [])
    const toolMessage = secondRequestMessages.find(
      (message) =>
        message.role === 'tool' &&
        message.tool_call_id === 'call_http_missing_url_1',
    )
    const invalidPayload = typeof toolMessage?.content === 'string'
      ? JSON.parse(toolMessage.content)
      : null

    assert(
      'native tool loop: direct http_request validation failures are returned as structured JSON payloads',
      result.reply === 'Direct http_request validation failure was structured.' &&
        invalidPayload?.ok === false &&
        invalidPayload?.error?.code === 'tool_invalid_arguments' &&
        Array.isArray(invalidPayload?.error?.details?.errors) &&
        invalidPayload.error.details.errors.some((entry: unknown) => String(entry).includes('url is required')) &&
        String(invalidPayload?.output).includes('Invalid arguments for tool http_request'),
      JSON.stringify({ invalidPayload, reply: result.reply }),
    )
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

{
  const originalCwd = process.cwd()
  const tmpDir = path.join(os.tmpdir(), `artemis-native-tool-direct-unknown-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })

  const requests: Array<Record<string, unknown>> = []
  let requestCount = 0

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      requests.push(body)
      requestCount += 1

      if (req.url !== '/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })

      if (requestCount === 1) {
        res.end(JSON.stringify({
          model: 'mock-openai-compatible',
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_unknown_direct_tool_1',
                type: 'function',
                function: {
                  name: 'unknown_direct_tool',
                  arguments: '{}',
                },
              }],
            },
          }],
        }))
        return
      }

      res.end(JSON.stringify({
        model: 'mock-openai-compatible',
        choices: [{
          message: {
            content: 'Unknown direct tool failure was structured.',
          },
        }],
      }))
    })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Mock provider server failed to bind to a TCP port.')
    }

    fs.writeFileSync(path.join(tmpDir, '.artemis', 'providers.json'), JSON.stringify({
      defaultMainProfileId: 'mock-openai',
      profiles: [{
        id: 'mock-openai',
        label: 'Mock OpenAI-compatible',
        protocol: 'openai',
        apiKey: 'test-key',
        model: 'mock-openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}`,
      }],
    }, null, 2), 'utf8')

    process.chdir(tmpDir)
    resetSession()
    applyProviderOverrides({})

    const result = await think(
      'Use the unknown tool.',
      undefined,
      {
        cwd: tmpDir,
        permissionMode: 'accept-all',
      },
    )

    const secondRequestMessages =
      ((requests[1]?.messages as Array<Record<string, unknown>> | undefined) ?? [])
    const toolMessage = secondRequestMessages.find(
      (message) =>
        message.role === 'tool' &&
        message.tool_call_id === 'call_unknown_direct_tool_1',
    )
    const unknownPayload = typeof toolMessage?.content === 'string'
      ? JSON.parse(toolMessage.content)
      : null

    assert(
      'native tool loop: unknown direct tool calls are returned as structured JSON payloads',
      result.reply === 'Unknown direct tool failure was structured.' &&
        unknownPayload?.ok === false &&
        unknownPayload?.error?.code === 'tool_unknown' &&
        Array.isArray(unknownPayload?.error?.availableTools) &&
        unknownPayload.error.availableTools.includes('read_file') &&
        String(unknownPayload?.output).includes('Unknown tool: unknown_direct_tool'),
      JSON.stringify({ unknownPayload, reply: result.reply }),
    )
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ── Provider native tool probe ───────────────────────────────────────────────

{
  const originalCwd = process.cwd()
  const tmpDir = path.join(os.tmpdir(), `artemis-projection-upgrade-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"demo"}', 'utf8')

  const requests: Array<Record<string, unknown>> = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
      requests.push(body)

      const toolNames = (
        body.tools as Array<{ function?: { name?: string } }> | undefined
      )?.map((entry) => entry?.function?.name).filter((name): name is string => typeof name === 'string') ?? []
      const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? []
      const formattedToolResult = messages.find(
        (message) =>
          message.role === 'tool' &&
          message.tool_call_id === 'call_format_json_1',
      )

      res.writeHead(200, { 'content-type': 'application/json' })

      if (formattedToolResult) {
        res.end(JSON.stringify({
          model: 'mock-openai-compatible',
          choices: [{
            message: {
              content: '已自动扩面并完成 JSON 检查。',
            },
          }],
          usage: {
            prompt_tokens: 16,
            completion_tokens: 4,
            total_tokens: 20,
          },
        }))
        return
      }

      if (toolNames.includes('format_json')) {
        res.end(JSON.stringify({
          model: 'mock-openai-compatible',
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_format_json_1',
                type: 'function',
                function: {
                  name: 'format_json',
                  arguments: JSON.stringify({
                    text: '{"name":"demo","scripts":{"test":"vitest"}}',
                    indent: 2,
                  }),
                },
              }],
            },
          }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 2,
            total_tokens: 14,
          },
        }))
        return
      }

      res.end(JSON.stringify({
        model: 'mock-openai-compatible',
        choices: [{
          message: {
            content: 'I need a JSON formatting tool before I can continue.',
          },
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 3,
          total_tokens: 13,
        },
      }))
    })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Mock provider server failed to bind to a TCP port.')
    }

    fs.writeFileSync(path.join(tmpDir, '.artemis', 'providers.json'), JSON.stringify({
      defaultMainProfileId: 'mock-openai',
      profiles: [{
        id: 'mock-openai',
        label: 'Mock OpenAI-compatible',
        protocol: 'openai',
        apiKey: 'test-key',
        model: 'mock-openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}`,
      }],
    }, null, 2), 'utf8')

    process.chdir(tmpDir)
    resetSession()
    applyProviderOverrides({})

    const result = await think(
      '修复当前项目配置里的 scripts 问题，必要时继续做结构化检查。',
      undefined,
      {
        cwd: tmpDir,
        permissionMode: 'accept-all',
      },
    )

    const firstToolNames = (
      (requests[0]?.tools as Array<{ function?: { name?: string } }> | undefined) ?? []
    )
      .map((entry) => entry?.function?.name)
      .filter((value): value is string => typeof value === 'string')
    const secondToolNames = (
      (requests[1]?.tools as Array<{ function?: { name?: string } }> | undefined) ?? []
    )
      .map((entry) => entry?.function?.name)
      .filter((value): value is string => typeof value === 'string')

    assert(
      'tool surface: coding requests no longer need a widening retry before JSON tools are available',
      requests.length === 2,
      `requests=${requests.length}`,
    )
    assert(
      'tool surface: first request already includes format_json',
      firstToolNames.includes('format_json'),
      firstToolNames.join(', '),
    )
    assert(
      'tool surface: subsequent tool round keeps format_json available',
      secondToolNames.includes('format_json'),
      secondToolNames.join(', '),
    )
    assert(
      'tool surface: full initial tool manifest still completes the task without user intervention',
      result.reply === '已自动扩面并完成 JSON 检查。',
      result.reply,
    )
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ── Provider native tool probe ───────────────────────────────────────────────

{
  const requests: Array<Record<string, unknown>> = []

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      requests.push(body)

      res.writeHead(200, { 'content-type': 'application/json' })
      const toolName = (
        body.tools as Array<{ function?: { name?: string } }> | undefined
      )?.[0]?.function?.name ?? 'unknown_probe_tool'
      res.end(JSON.stringify({
        model: 'mock-openai-compatible',
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              id: 'call_probe_1',
              type: 'function',
              function: {
                name: toolName,
                arguments: '{"probe":"ok"}',
              },
            }],
          },
        }],
      }))
    })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Mock tool-probe server failed to bind to a TCP port.')
    }

    const probe = await probeProviderNativeToolCalls({
      protocol: 'openai',
      apiKey: 'test-key',
      model: 'mock-openai-compatible',
      baseUrl: `http://127.0.0.1:${address.port}`,
    })

    const firstRequestTools =
      ((requests[0]?.tools as Array<{ function?: { name?: string } }> | undefined) ?? [])

    assert(
      'native tool probe: request carried exactly one probe tool',
      firstRequestTools.length === 1,
      `tools=${firstRequestTools.length}`,
    )
    assert(
      'native tool probe: tool-capable provider is detected as compatible',
      probe.ok,
      probe.message,
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

// ── Pseudo tool transcript hard failure ──────────────────────────────────────

{
  const originalCwd = process.cwd()
  const tmpDir = path.join(os.tmpdir(), `artemis-fake-tool-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'alpha.txt'), 'alpha\n', 'utf8')

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      if (req.url !== '/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: 'mock-openai-compatible',
        choices: [{
          message: {
            content: 'run_command: ls -la\nalpha.txt',
          },
        }],
      }))
    })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Mock fake-tool server failed to bind to a TCP port.')
    }

    const providersPath = path.join(tmpDir, '.artemis', 'providers.json')
    fs.writeFileSync(providersPath, JSON.stringify({
      defaultMainProfileId: 'mock-openai',
      profiles: [{
        id: 'mock-openai',
        label: 'Mock OpenAI-compatible',
        protocol: 'openai',
        apiKey: 'test-key',
        model: 'mock-openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}`,
      }],
    }, null, 2), 'utf8')

    process.chdir(tmpDir)
    resetSession()
    applyProviderOverrides({})

    let errorMessage = ''
    try {
      await think(
        '请读取当前目录里的文件并告诉我 alpha.txt 里写了什么',
        () => {},
        {
          cwd: tmpDir,
          permissionMode: 'accept-all',
        },
      )
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    assert(
      'native tool loop: pseudo run_command transcript without tool_calls hard-fails',
      /Provider incompatibility detected: openai \/ mock-openai-compatible/.test(errorMessage),
      errorMessage,
    )
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ── think(): cancelling while the vision helper reads the images ────────────

{
  const originalCwd = process.cwd()
  const tmpDir = path.join(os.tmpdir(), `artemis-think-vision-abort-${Date.now()}`)
  fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })
  let chatRequests = 0
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      chatRequests += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
    })
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Mock think-abort server failed to bind.')
    fs.writeFileSync(path.join(tmpDir, '.artemis', 'providers.json'), JSON.stringify({
      defaultMainProfileId: 'mock-text',
      profiles: [{ id: 'mock-text', protocol: 'openai', apiKey: 'k', model: 'mock-text-only', supportsImages: false, baseUrl: `http://127.0.0.1:${address.port}` }],
    }), 'utf8')
    process.chdir(tmpDir)
    resetSession()
    applyProviderOverrides({})
    // A helper that only returns when the run is cancelled.
    let helperSawSignal = false
    const helper: VisionHelper = {
      label: 'slow-eye',
      describe: (images, context) => new Promise((resolve) => {
        helperSawSignal = context?.signal !== undefined
        const done = () => resolve(images.map(() => ({ ok: false as const, error: 'the run was cancelled' })))
        if (!context?.signal) return done()
        context.signal.addEventListener('abort', done, { once: true })
      }),
    }
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    let errorName = ''
    try {
      await think('what is in this picture?', () => {}, {
        cwd: tmpDir,
        permissionMode: 'accept-all',
        imageAttachments: [{ data: 'iVBORw0KGgo=', mediaType: 'image/png', label: 'Image: a.png' }],
        visionHelper: helper,
        abortSignal: controller.signal,
      })
    } catch (error) {
      errorName = error instanceof Error ? error.name : String(error)
    }
    assert(
      'think: the abort signal reaches the vision helper, and a cancelled run sends nothing to the model',
      helperSawSignal && errorName === 'AbortError' && chatRequests === 0,
      JSON.stringify({ helperSawSignal, errorName, chatRequests }),
    )
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ── Tool deflection retry guard ──────────────────────────────────────────────

{
  const originalCwd = process.cwd()
  const tmpDir = path.join(os.tmpdir(), `artemis-tool-deflection-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>\n', 'utf8')

  const requests: Array<Record<string, unknown>> = []
  let requestCount = 0

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      requests.push(body)
      requestCount += 1

      if (req.url !== '/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })

      if (requestCount === 1) {
        res.end(JSON.stringify({
          model: 'mock-openai-compatible',
          choices: [{
            message: {
              content: '为了开始，请运行：cat index.html | head -20，然后把结果粘贴给我。我无法直接读取你的文件。',
            },
          }],
        }))
        return
      }

      if (requestCount === 2) {
        res.end(JSON.stringify({
          model: 'mock-openai-compatible',
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_list_files_after_guard',
                type: 'function',
                function: {
                  name: 'list_files',
                  arguments: '{}',
                },
              }],
            },
          }],
        }))
        return
      }

      res.end(JSON.stringify({
        model: 'mock-openai-compatible',
        choices: [{
          message: {
            content: '已改用真实工具检查工作区。',
          },
        }],
      }))
    })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Mock tool-deflection server failed to bind to a TCP port.')
    }

    const providersPath = path.join(tmpDir, '.artemis', 'providers.json')
    fs.writeFileSync(providersPath, JSON.stringify({
      defaultMainProfileId: 'mock-openai',
      profiles: [{
        id: 'mock-openai',
        label: 'Mock OpenAI-compatible',
        protocol: 'openai',
        apiKey: 'test-key',
        model: 'mock-openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}`,
      }],
    }, null, 2), 'utf8')

    process.chdir(tmpDir)
    resetSession()
    applyProviderOverrides({})

    const streamed: string[] = []
    const result = await think(
      '请直接读取当前目录里的 index.html 内容，不要让我自己运行命令。',
      (delta) => streamed.push(delta),
      {
        cwd: tmpDir,
        permissionMode: 'accept-all',
      },
    )

    const secondRequestMessages =
      ((requests[1]?.messages as Array<Record<string, unknown>> | undefined) ?? [])
    const runtimeGuardMessage = secondRequestMessages.find(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.includes('[tool:runtime_guard]') &&
        message.content.includes('Do not ask the user to run cat'),
    )

    assert(
      'native tool loop: tool-deflection reply triggers a retry instead of reaching the user',
      requests.length === 3,
      `requests=${requests.length}`,
    )
    assert(
      'native tool loop: retry request includes runtime guard against asking the user to run cat',
      typeof runtimeGuardMessage?.content === 'string',
      JSON.stringify(runtimeGuardMessage),
    )
    assert(
      'native tool loop: final reply comes from the post-guard tool round',
      result.reply === '已改用真实工具检查工作区。',
      result.reply,
    )
    assert(
      'native tool loop: streamed output does not leak the blocked cat index.html instruction',
      !streamed.join('').includes('cat index.html'),
      streamed.join(''),
    )
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

{
  const originalCwd = process.cwd()
  const tmpDir = path.join(os.tmpdir(), `artemis-native-tool-summary-command-quote-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })

  const requests: Array<Record<string, unknown>> = []
  let requestCount = 0

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      requests.push(body)
      requestCount += 1

      if (req.url !== '/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })
      if (requestCount === 1) {
        res.end(JSON.stringify({
          model: 'mock-openai-compatible',
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_list_files_before_summary_quote',
                type: 'function',
                function: {
                  name: 'list_files',
                  arguments: '{}',
                },
              }],
            },
          }],
        }))
        return
      }

      res.end(JSON.stringify({
        model: 'mock-openai-compatible',
        choices: [{
          message: {
            content: '已完成修复并验证通过：npm run typecheck、npm run build。当前工作区只有相关文件被修改。',
          },
        }],
      }))
    })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Mock command-quote summary server failed to bind to a TCP port.')
    }

    const providersPath = path.join(tmpDir, '.artemis', 'providers.json')
    fs.writeFileSync(providersPath, JSON.stringify({
      defaultMainProfileId: 'mock-openai',
      profiles: [{
        id: 'mock-openai',
        label: 'Mock OpenAI-compatible',
        protocol: 'openai',
        apiKey: 'test-key',
        model: 'mock-openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}`,
      }],
    }, null, 2), 'utf8')

    process.chdir(tmpDir)
    resetSession()
    applyProviderOverrides({})

    const streamed: string[] = []
    const result = await think(
      '修复问题并汇报验证结果。',
      (delta) => streamed.push(delta),
      {
        cwd: tmpDir,
        permissionMode: 'accept-all',
      },
    )

    assert(
      'native tool loop: final summary may mention already-run npm validation commands without runtime_guard retry',
      requests.length === 2 &&
        result.reply.includes('npm run typecheck') &&
        streamed.join('') === result.reply,
      JSON.stringify({ requests: requests.length, reply: result.reply, streamed: streamed.join('') }),
    )
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ── True SSE tool-call preamble buffering ────────────────────────────────────

{
  const originalCwd = process.cwd()
  const tmpDir = path.join(os.tmpdir(), `artemis-sse-tool-call-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'alpha.txt'), 'alpha\n', 'utf8')

  const requests: Array<Record<string, unknown>> = []
  let requestCount = 0

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      requests.push(body)
      requestCount += 1

      if (req.url !== '/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }

      if (requestCount === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"model":"mock-openai-compatible","choices":[{"delta":{"content":"我先看一下。"}}]}\n\n')
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_sse_list_files_1","function":{"name":"list_files","arguments":"{}"}}]}}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n')
        res.end('data: [DONE]\n\n')
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: 'mock-openai-compatible',
        choices: [{
          message: {
            content: '我已经检查完目录。',
          },
        }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }))
    })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Mock SSE tool-call server failed to bind to a TCP port.')
    }

    const providersPath = path.join(tmpDir, '.artemis', 'providers.json')
    fs.writeFileSync(providersPath, JSON.stringify({
      defaultMainProfileId: 'mock-openai',
      profiles: [{
        id: 'mock-openai',
        label: 'Mock OpenAI-compatible',
        protocol: 'openai',
        apiKey: 'test-key',
        model: 'mock-openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}`,
      }],
    }, null, 2), 'utf8')

    process.chdir(tmpDir)
    resetSession()
    applyProviderOverrides({})

    const streamed: string[] = []
    const result = await think(
      '请直接读取当前目录里的文件并告诉我有哪些文件。',
      (delta) => streamed.push(delta),
      {
        cwd: tmpDir,
        permissionMode: 'accept-all',
      },
    )

    assert(
      'native tool loop: true SSE reply still flushes the pre-tool preamble once tool_calls start',
      streamed.join('').includes('我先看一下。'),
      streamed.join(''),
    )
    assert(
      'native tool loop: true SSE tool-call path still reaches the final reply',
      result.reply === '我已经检查完目录。',
      result.reply,
    )
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ── True SSE deflection does not leak before retry ───────────────────────────

{
  const originalCwd = process.cwd()
  const tmpDir = path.join(os.tmpdir(), `artemis-sse-deflection-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>\n', 'utf8')

  const requests: Array<Record<string, unknown>> = []
  let requestCount = 0

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      requests.push(body)
      requestCount += 1

      if (req.url !== '/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }

      if (requestCount === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"model":"mock-openai-compatible","choices":[{"delta":{"content":"为了开始，请运行："}}]}\n\n')
        res.write('data: {"choices":[{"delta":{"content":"cat index.html"}}]}\n\n')
        res.write('data: {"choices":[{"delta":{"content":" | head -20，然后把结果粘贴给我。"}}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n')
        res.end('data: [DONE]\n\n')
        return
      }

      if (requestCount === 2) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          model: 'mock-openai-compatible',
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_sse_guard_list_files_1',
                type: 'function',
                function: {
                  name: 'list_files',
                  arguments: '{}',
                },
              }],
            },
          }],
        }))
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: 'mock-openai-compatible',
        choices: [{
          message: {
            content: '已改用真实工具检查工作区。',
          },
        }],
      }))
    })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Mock SSE deflection server failed to bind to a TCP port.')
    }

    const providersPath = path.join(tmpDir, '.artemis', 'providers.json')
    fs.writeFileSync(providersPath, JSON.stringify({
      defaultMainProfileId: 'mock-openai',
      profiles: [{
        id: 'mock-openai',
        label: 'Mock OpenAI-compatible',
        protocol: 'openai',
        apiKey: 'test-key',
        model: 'mock-openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}`,
      }],
    }, null, 2), 'utf8')

    process.chdir(tmpDir)
    resetSession()
    applyProviderOverrides({})

    const streamed: string[] = []
    const result = await think(
      '请直接读取当前目录里的 index.html 内容，不要让我自己运行命令。',
      (delta) => streamed.push(delta),
      {
        cwd: tmpDir,
        permissionMode: 'accept-all',
      },
    )

    assert(
      'native tool loop: true SSE deflection reply still retries instead of reaching the user',
      requests.length === 3,
      `requests=${requests.length}`,
    )
    // Intentional tradeoff (2026-04-17): on a true SSE stream, deflection
    // text may be partially visible to the user before the runtime-guard
    // retry fires. The `guardStreamingText` buffer that prevented this was
    // disabled because its trigger (any mention of 测试/code/file/…)
    // caused a perceptible pause on every coding-intent prompt and wiped
    // out the first-token-latency win. The retry still corrects the reply
    // and the final answer is authoritative.
    assert(
      'native tool loop: true SSE deflection path still reaches the final reply',
      result.reply === '已改用真实工具检查工作区。',
      result.reply,
    )
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ── Casual chat bypasses native tool loop ────────────────────────────────────

{
  const originalCwd = process.cwd()
  const tmpDir = path.join(os.tmpdir(), `artemis-plain-chat-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })

  const requests: Array<Record<string, unknown>> = []

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      requests.push(body)

      if (req.url !== '/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: 'mock-openai-compatible',
        choices: [{
          message: {
            content: '你好，我在。',
          },
        }],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 4,
          total_tokens: 13,
        },
      }))
    })
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Mock plain-chat server failed to bind to a TCP port.')
    }

    const providersPath = path.join(tmpDir, '.artemis', 'providers.json')
    fs.writeFileSync(providersPath, JSON.stringify({
      defaultMainProfileId: 'mock-openai',
      profiles: [{
        id: 'mock-openai',
        label: 'Mock OpenAI-compatible',
        protocol: 'openai',
        apiKey: 'test-key',
        model: 'mock-openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}`,
      }],
    }, null, 2), 'utf8')

    process.chdir(tmpDir)
    resetSession()
    applyProviderOverrides({})

    const streamed: string[] = []
    const result = await think(
      '我来测试一下',
      (delta) => streamed.push(delta),
      {
        cwd: tmpDir,
        permissionMode: 'accept-all',
      },
    )

    assert(
      'plain chat: supported providers skip the native tool loop for casual test messages',
      requests.length === 1,
      `requests=${requests.length}`,
    )
    assert(
      'plain chat: casual messages do not send a tool manifest',
      !Array.isArray(requests[0]?.tools),
      JSON.stringify(requests[0]?.tools),
    )
    assert(
      'plain chat: think() returns the direct conversational reply',
      result.reply === '你好，我在。',
      result.reply,
    )
    assert(
      'plain chat: streamed output contains the direct conversational reply',
      streamed.join('') === '你好，我在。',
      streamed.join(''),
    )
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

{
  // Platform capabilities: values the agent server wrote into the profile
  // (capabilitiesSource "platform") beat every model-name rule, because the
  // name can be a gateway alias (gpt-6-sol serving a GLM model).
  const platformAlias = {
    protocol: 'openai' as const,
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'k',
    model: 'gpt-6-sol',
    contextLength: 1_000_000,
    maxOutputTokens: 12_345,
    capabilitiesSource: 'platform' as const,
  }
  assert(
    'platform capabilities: contextLength beats the GPT-6 cap for an alias named gpt-6-sol',
    resolveProfileContextLength(platformAlias) === 1_000_000 &&
      resolveProfileContextLength({ ...platformAlias, contextLength: 131_072 }) === 131_072 &&
      estimateContextLimit('gpt-6-sol', 1_000_000, true) === 1_000_000 &&
      new OpenAICompatibleProvider(platformAlias).contextLength === 1_000_000 &&
      new MessagesCompatibleProvider({ ...platformAlias, protocol: 'messages' }).contextLength === 1_000_000 &&
      new ResponsesCompatibleProvider({ ...platformAlias, protocol: 'responses' }).contextLength === 1_000_000,
  )
  const { capabilitiesSource: _source, ...nonPlatform } = platformAlias
  assert(
    'platform capabilities: non-platform profiles keep the GPT-6 / GPT-5.6 caps',
    resolveProfileContextLength(nonPlatform) === GPT_5_6_CONTEXT_LENGTH &&
      resolveProfileContextLength({ ...nonPlatform, model: 'gpt-5.6-sol' }) === GPT_5_6_CONTEXT_LENGTH &&
      estimateContextLimit('gpt-6-sol', 1_000_000) === GPT_5_6_CONTEXT_LENGTH &&
      new OpenAICompatibleProvider(nonPlatform).contextLength === undefined,
  )

  const hud = createHudState('gpt-6-sol')
  updateHudState(hud, { model: 'gpt-6-sol', contextLimit: 1_000_000, contextLimitAuthoritative: true, promptTokens: 500_000 })
  const platformHud = renderHud(hud)
  updateHudState(hud, { model: 'gpt-6-sol', contextLimit: 1_000_000, promptTokens: 200_000 })
  const cappedHud = renderHud(hud)
  assert(
    'platform capabilities: the HUD shows the platform window and still caps a non-platform one',
    platformHud.includes('1.0M') && cappedHud.includes('272.0K') && !cappedHud.includes('1.0M'),
    `${platformHud} | ${cappedHud}`,
  )

  // Store: the fields survive load and save; platform windows are not capped
  // or re-detected; malformed values are dropped; visionProfileId is kept.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-platform-caps-'))
  try {
    fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.artemis', 'providers.json'), JSON.stringify({
      defaultMainProfileId: 'platform-main',
      visionProfileId: 'platform-vision',
      profiles: [
        { ...platformAlias, id: 'platform-main', supportsImages: false },
        { ...platformAlias, id: 'platform-vision', model: 'vision-alias', supportsImages: true, maxOutputTokens: 'lots', capabilitiesSource: 'server' },
        { ...nonPlatform, id: 'byok' },
        { ...platformAlias, id: 'platform-no-window', contextLength: undefined },
      ],
    }), 'utf8')
    const store = new ProviderStore(tmpDir)
    const loaded = await store.load()
    await store.save(loaded)
    const reloaded = await store.load()
    const main = store.getProfile(reloaded, 'platform-main')
    const vision = store.getProfile(reloaded, 'platform-vision')
    const byok = store.getProfile(reloaded, 'byok')
    const refreshed = await store.refreshProfileContextLength('platform-main')
    const noWindow = await store.refreshProfileContextLength('platform-no-window')
    assert(
      'platform capabilities: profile fields and visionProfileId survive load and save',
      reloaded.visionProfileId === 'platform-vision' &&
        main?.contextLength === 1_000_000 &&
        main.maxOutputTokens === 12_345 &&
        main.capabilitiesSource === 'platform' &&
        main.supportsImages === false &&
        refreshed?.contextLength === 1_000_000 &&
        vision?.supportsImages === true &&
        vision.maxOutputTokens === undefined &&
        vision.capabilitiesSource === undefined &&
        byok?.contextLength === GPT_5_6_CONTEXT_LENGTH &&
        noWindow?.contextLength === undefined &&
        resolveProfileContextLength(noWindow) === GPT_5_6_CONTEXT_LENGTH,
      JSON.stringify({ visionProfileId: reloaded.visionProfileId, main, vision, byok, noWindow }),
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  // max output: the platform's maxOutputTokens replaces the name-based
  // max_tokens on the Messages API, and a per-request limit only lowers it.
  const bodies: Array<Record<string, unknown>> = []
  let reply: unknown = {}
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      bodies.push(raw ? JSON.parse(raw) as Record<string, unknown> : {})
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    if (!address || typeof address === 'string') throw new Error('Mock max-output server failed to bind.')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const userMessage = { id: 'u1', role: 'user' as const, content: 'hi', createdAt: new Date().toISOString() }
    reply = { content: [{ type: 'text', text: 'ok' }], usage: {} }
    await new MessagesCompatibleProvider({ ...platformAlias, protocol: 'messages', baseUrl }).complete([userMessage])
    await new MessagesCompatibleProvider({ ...platformAlias, protocol: 'messages', baseUrl }).complete([userMessage], { maxOutputTokens: 1500 })
    await new MessagesCompatibleProvider({ ...nonPlatform, protocol: 'messages', baseUrl }).complete([userMessage])
    reply = { choices: [{ message: { content: 'ok' } }], usage: {} }
    await new OpenAICompatibleProvider({ ...platformAlias, baseUrl }).complete([userMessage])
    await new OpenAICompatibleProvider({ ...platformAlias, baseUrl, maxOutputTokens: 1000 }).complete([userMessage], { maxOutputTokens: 1500 })
    assert(
      'platform capabilities: maxOutputTokens replaces the name-based max_tokens and bounds per-request limits',
      bodies[0]?.max_tokens === 12_345 &&
        bodies[1]?.max_tokens === 1500 &&
        bodies[2]?.max_tokens === 8_192 &&
        bodies[3]?.max_tokens === undefined && bodies[3]?.max_completion_tokens === undefined &&
        bodies[4]?.max_tokens === 1000,
      JSON.stringify(bodies.map((b) => ({ max_tokens: b.max_tokens, max_completion_tokens: b.max_completion_tokens }))),
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

{
  // runAgent sizes its context window from the active provider's platform
  // window: a 1M-token platform model keeps more history than the default.
  const runWithWindow = async (contextLength: number | undefined) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-platform-window-'))
    const store = new SessionStore(tmpDir)
    const session = store.createSession({ title: 'platform window smoke' })
    // ~120K tokens: over the default window's threshold, far under 1M.
    for (let i = 0; i < 60; i += 1) {
      session.messages.push({ id: `h${i}`, role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${'x '.repeat(4_000)}`, createdAt: new Date().toISOString() })
    }
    await store.save(session)
    const info: string[] = []
    const provider: ChatProvider = {
      contextLength,
      async complete(): Promise<ProviderResponse> {
        return { text: JSON.stringify({ reply: 'ok', done: true }), raw: null }
      },
    }
    await runAgent(session, 'continue', {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 1,
      profile: 'main',
      onInfo: (message) => info.push(message),
    })
    fs.rmSync(tmpDir, { recursive: true, force: true })
    const line = info.find((m) => m.startsWith('[context] tokens~')) ?? ''
    return {
      window: Number(/tokens~\d+\/(\d+)/.exec(line)?.[1] ?? NaN),
      kept: Number(/messages=(\d+)/.exec(line)?.[1] ?? NaN),
    }
  }
  const byDefault = await runWithWindow(undefined)
  const byPlatform = await runWithWindow(1_000_000)
  assert(
    'platform capabilities: runAgent budgets its context by the platform window',
    byDefault.window === 128_000 && byPlatform.window === 1_000_000 && byPlatform.kept > byDefault.kept,
    `default=${JSON.stringify(byDefault)} platform=${JSON.stringify(byPlatform)}`,
  )
}

{
  // Vision helper on the runAgent path (headless, web, workflows): a model
  // that cannot see images gets a description from the vision profile.
  const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const userImage = { data: pngBytes.toString('base64'), mediaType: 'image/png' as const, label: 'Image: screenshot.png' }
  type MainCall = { images?: number; tools: string[]; messages: SessionMessage[] }
  const runVision = async (options: {
    helper: VisionHelper | null
    images?: ImageAttachment[]
    viewImage?: boolean
    prompt?: string
    /** The main profile points at the platform gateway, which reads images itself. */
    bridges?: boolean
  }) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-vision-helper-'))
    fs.writeFileSync(path.join(tmpDir, 'screenshot.png'), pngBytes)
    const store = new SessionStore(tmpDir)
    const session = store.createSession({ title: 'vision helper smoke' })
    await store.save(session)
    const mainCalls: MainCall[] = []
    const provider: ChatProvider = {
      supportsImages: false,
      bridgesImages: options.bridges === true,
      supportsNativeToolCalls: true,
      async complete(messages, requestOptions): Promise<ProviderResponse> {
        mainCalls.push({
          images: requestOptions?.imageAttachments?.length,
          tools: (requestOptions?.nativeFunctionTools ?? []).map((t) => t.name),
          messages,
        })
        if (options.viewImage && mainCalls.length === 1) {
          return { text: JSON.stringify({ reply: 'Let me look.', done: false, actions: [{ type: 'view_image', path: 'screenshot.png' }] }), raw: null }
        }
        return { text: JSON.stringify({ reply: 'It is a sign-in page.', done: true }), raw: null }
      },
    }
    const result = await runAgent(session, options.prompt ?? 'What does this screenshot show?', {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 3,
      profile: 'main',
      visionHelper: options.helper,
      visionRetryDelayMs: 5,
      ...(options.images ? { imageAttachments: options.images } : {}),
    })
    const userText = session.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n')
    const toolText = session.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n')
    fs.rmSync(tmpDir, { recursive: true, force: true })
    return { result, mainCalls, userText, toolText }
  }
  const makeHelper = (behaviour: 'ok' | 'fail') => {
    const calls: Array<{ images: number; maxOutputTokens?: number; prompt: string }> = []
    const visionProvider: ChatProvider = {
      supportsImages: true,
      async complete(messages, requestOptions): Promise<ProviderResponse> {
        calls.push({
          images: requestOptions?.imageAttachments?.length ?? 0,
          maxOutputTokens: requestOptions?.maxOutputTokens,
          prompt: messages.map((m) => m.content).join('\n'),
        })
        if (behaviour === 'fail') throw new Error('vision gateway unavailable')
        return { text: 'A sign-in form. Visible text: "Sign in", "Forgot password?". Blue button.', raw: null }
      },
    }
    return { calls, helper: createVisionHelper(visionProvider, { label: 'platform-vision' }) }
  }
  const mainRequestHasImageParts = (calls: MainCall[]) => calls.some((call) => (call.images ?? 0) > 0)

  {
    const { calls, helper } = makeHelper('ok')
    const run = await runVision({ helper, images: [userImage] })
    const firstUser = run.mainCalls[0]?.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n') ?? ''
    assert(
      'vision helper: supportsImages:false with a vision profile calls the helper once and injects the description',
      calls.length === 1 &&
        calls[0]!.images === 1 &&
        calls[0]!.maxOutputTokens === 1500 &&
        calls[0]!.prompt.includes('What does this screenshot show?') &&
        /verbatim/.test(calls[0]!.prompt) &&
        firstUser.includes('[Image 1 description by vision helper]') &&
        firstUser.includes('"Forgot password?"') &&
        run.result.reply.includes('sign-in page'),
      JSON.stringify({ calls: calls.map((c) => ({ images: c.images, max: c.maxOutputTokens })), firstUser: firstUser.slice(0, 300) }),
    )
    assert(
      'vision helper: the main request carries no image parts',
      !mainRequestHasImageParts(run.mainCalls),
      JSON.stringify(run.mainCalls.map((c) => c.images)),
    )
  }

  {
    // The user attaches screenshot.png and the agent then views the same file:
    // the second look is a cache hit, and view_image returns the description.
    const { calls, helper } = makeHelper('ok')
    const run = await runVision({ helper, images: [userImage], viewImage: true })
    assert(
      'vision helper: view_image is offered and returns the description instead of queueing the image',
      run.mainCalls[0]?.tools.includes('view_image') === true &&
        run.toolText.includes('description by vision helper') &&
        run.toolText.includes('Forgot password?') &&
        run.toolText.includes('<image_description n=') &&
        /<\/image_description id=\\?"[0-9a-f]{12}\\?">/.test(run.toolText) &&
        run.toolText.includes('transcribed from an image by a vision helper') &&
        !run.toolText.includes('attached to your next step') &&
        !mainRequestHasImageParts(run.mainCalls),
      JSON.stringify({ tools: run.mainCalls[0]?.tools.includes('view_image'), tool: run.toolText.slice(0, 300) }),
    )
    assert(
      'vision helper: the same image is described once per run (cache hit by content hash)',
      calls.length === 1,
      `helper calls=${calls.length}`,
    )
  }

  {
    const { calls, helper } = makeHelper('fail')
    const run = await runVision({ helper, images: [userImage] })
    assert(
      'vision helper: a helper failure is retried once, then leaves a "temporarily unreadable" note and the run continues',
      calls.length === 2 &&
        run.userText.includes('the attached image is temporarily unreadable') &&
        run.userText.includes('Tell the user briefly that the image is temporarily unreadable and that you will retry. Do not mention plans, tiers or models.') &&
        !/plan|tier|model/i.test(run.userText.replace('Do not mention plans, tiers or models.', '')) &&
        run.result.reply.includes('sign-in page') &&
        !mainRequestHasImageParts(run.mainCalls),
      run.userText.slice(0, 300),
    )
  }

  {
    // The helper fails twice; the main profile goes through the platform gateway,
    // so the image is sent to it as an image and the gateway reads it.
    const { calls, helper } = makeHelper('fail')
    const run = await runVision({ helper, images: [userImage], bridges: true })
    assert(
      'vision helper: when the helper fails, a gateway-bridged main model gets the image itself',
      calls.length === 2 &&
        run.mainCalls[0]?.images === 1 &&
        run.userText.includes('[Image 1 (screenshot.png) is attached to this message as an image.]') &&
        !run.userText.includes('temporarily unreadable') &&
        run.result.reply.includes('sign-in page'),
      JSON.stringify({ calls: calls.length, images: run.mainCalls.map((c) => c.images), text: run.userText.slice(0, 300) }),
    )
  }

  {
    // No helper at all, but the gateway reads images: they go to it unchanged.
    const run = await runVision({ helper: null, images: [userImage], bridges: true })
    assert(
      'vision helper: without a helper, a gateway-bridged main model gets the images and no note',
      run.mainCalls[0]?.images === 1 && !run.userText.includes('unreadable') && run.result.reply.includes('sign-in page'),
      JSON.stringify({ images: run.mainCalls.map((c) => c.images), text: run.userText.slice(0, 300) }),
    )
  }

  {
    const run = await runVision({ helper: null, images: [userImage, { ...userImage, label: 'Image: chart.jpg' }] })
    assert(
      'vision helper: without a helper the model gets a graceful note and the run succeeds',
      run.userText.includes('The user attached 2 image(s) (file names: screenshot.png, chart.jpg); they are temporarily unreadable. Tell the user briefly that the image is temporarily unreadable and that you will retry. Do not mention plans, tiers or models. Continue with the text.') &&
        run.result.reply.includes('sign-in page') &&
        !mainRequestHasImageParts(run.mainCalls) &&
        run.mainCalls.every((call) => !call.tools.includes('view_image')),
      run.userText.slice(0, 300),
    )
  }

  {
    // Two images in one batch: one helper call, one labelled part per image.
    const calls: number[] = []
    const helper = createVisionHelper({
      supportsImages: true,
      async complete(_messages, requestOptions): Promise<ProviderResponse> {
        calls.push(requestOptions?.imageAttachments?.length ?? 0)
        return { text: '### Image 1\nA bar chart of sales.\n\n### Image 2\nA photo of a cat.', raw: null }
      },
    })
    const run = await runVision({ helper, images: [userImage, { data: 'R0lGODlh', mediaType: 'image/gif', label: 'Image: cat.gif' }] })
    assert(
      'vision helper: a batch of images is described in one call and labelled per image',
      calls.length === 1 && calls[0] === 2 &&
        /\[Image 1 description by vision helper[^\]]*\]\n<image_description n="1" source="vision-helper" id="([0-9a-f]{12})">\nA bar chart of sales\.\n<\/image_description id="\1">/.test(run.userText) &&
        /\[Image 2 description by vision helper[^\]]*\]\n<image_description n="2" source="vision-helper" id="([0-9a-f]{12})">\nA photo of a cat\.\n<\/image_description id="\1">/.test(run.userText),
      run.userText.slice(0, 400),
    )
  }
}

{
  // End to end through the provider store: `artemis execute --image` on a
  // text-only platform model with visionProfileId -> platform-vision.
  const requests: Array<Record<string, unknown>> = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
      requests.push(body)
      const content = body.model === 'vision-alias'
        ? 'A terminal window showing the text "build passed".'
        : 'The screenshot shows a passing build.'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: body.model, choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-vision-headless-'))
  try {
    if (!address || typeof address === 'string') throw new Error('Mock vision server failed to bind.')
    const baseUrl = `http://127.0.0.1:${address.port}`
    fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.artemis', 'providers.json'), JSON.stringify({
      defaultMainProfileId: 'platform-main',
      visionProfileId: 'platform-vision',
      profiles: [
        { id: 'platform-main', protocol: 'openai', baseUrl, apiKey: 'k', model: 'gpt-6-sol', supportsImages: false, contextLength: 200_000, maxOutputTokens: 8192, capabilitiesSource: 'platform' },
        { id: 'platform-vision', protocol: 'openai', baseUrl, apiKey: 'k', model: 'vision-alias', supportsImages: true, capabilitiesSource: 'platform' },
      ],
    }), 'utf8')
    fs.writeFileSync(path.join(tmpDir, 'build.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
    const result = await runHeadlessAgent(tmpDir, 'Did the build pass?', {
      permissionMode: 'read-only',
      maxTurns: 1,
      imagePaths: ['build.png'],
    })
    const visionRequests = requests.filter((r) => r.model === 'vision-alias')
    const mainRequests = requests.filter((r) => r.model === 'gpt-6-sol')
    const mainRaw = JSON.stringify(mainRequests)
    assert(
      'vision helper (--image, headless/web): resolved from visionProfileId, called once, main request text-only with the description',
      visionRequests.length === 1 &&
        JSON.stringify(visionRequests[0]).includes('image_url') &&
        visionRequests[0]?.max_tokens === 1500 &&
        mainRequests.length >= 1 &&
        !mainRaw.includes('image_url') &&
        !mainRaw.includes('not shown: they cannot be read in this request') &&
        mainRaw.includes('Image 1 description by vision helper') &&
        mainRaw.includes('build passed') &&
        result.reply.includes('passing build'),
      JSON.stringify({ vision: visionRequests.length, main: mainRequests.length, reply: result.reply, raw: mainRaw.slice(0, 300) }),
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

{
  // Bridge / pasted images go through think(): the same vision helper turns
  // them into text for a text-only main model.
  const requests: Array<Record<string, unknown>> = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
      requests.push(body)
      const content = body.model === 'vision-alias'
        ? '一张收据，文字：“合计 42 元”。'
        : '收据上的合计是 42 元。'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: body.model, choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-vision-bridge-'))
  const originalCwd = process.cwd()
  try {
    if (!address || typeof address === 'string') throw new Error('Mock vision bridge server failed to bind.')
    const baseUrl = `http://127.0.0.1:${address.port}`
    fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.artemis', 'providers.json'), JSON.stringify({
      defaultMainProfileId: 'platform-main',
      visionProfileId: 'platform-vision',
      profiles: [
        { id: 'platform-main', protocol: 'openai', baseUrl, apiKey: 'k', model: 'gpt-6-sol', supportsImages: false, capabilitiesSource: 'platform' },
        { id: 'platform-vision', protocol: 'openai', baseUrl, apiKey: 'k', model: 'vision-alias', supportsImages: true, capabilitiesSource: 'platform' },
      ],
    }), 'utf8')
    process.chdir(tmpDir)
    resetSession()
    applyProviderOverrides({})
    const result = await think('这张收据合计多少？', () => {}, {
      cwd: tmpDir,
      permissionMode: 'accept-all',
      disableNativeTools: true,
      imageAttachments: [{ data: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64'), mediaType: 'image/png' }],
    })
    const visionRequests = requests.filter((r) => r.model === 'vision-alias')
    const mainRaw = JSON.stringify(requests.filter((r) => r.model === 'gpt-6-sol'))
    assert(
      'vision helper (bridge think()): the helper describes the pasted image and the main request is text-only',
      visionRequests.length === 1 &&
        JSON.stringify(visionRequests[0]).includes('image_url') &&
        JSON.stringify(visionRequests[0]).includes('这张收据合计多少') &&
        !mainRaw.includes('image_url') &&
        mainRaw.includes('Image 1 description by vision helper') &&
        mainRaw.includes('合计 42 元') &&
        result.reply.includes('42'),
      JSON.stringify({ vision: visionRequests.length, reply: result.reply, raw: mainRaw.slice(0, 300) }),
    )
  } finally {
    process.chdir(originalCwd)
    resetSession()
    applyProviderOverrides({})
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

{
  // Sub-agents: a text-only worker never receives image parts. view_image goes
  // through the vision helper when one exists, otherwise through the main
  // profile (which can see images).
  const runSubAgent = async (helper: VisionHelper | null) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-vision-subagent-'))
    fs.writeFileSync(path.join(tmpDir, 'screenshot.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
    fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.artemis', 'providers.json'), JSON.stringify({
      specialistProfileId: 'worker',
      profiles: [{ id: 'worker', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'text-worker', supportsImages: false }],
    }), 'utf8')
    const workerImages: number[] = []
    const mainImages: number[] = []
    let workerCalls = 0
    const worker: ChatProvider = {
      supportsImages: false,
      async complete(_messages, requestOptions): Promise<ProviderResponse> {
        workerCalls += 1
        workerImages.push(requestOptions?.imageAttachments?.length ?? 0)
        if (workerCalls === 1) {
          return { text: JSON.stringify({ reply: 'Let me look.', done: false, actions: [{ type: 'view_image', path: 'screenshot.png' }] }), raw: null }
        }
        return { text: JSON.stringify({ reply: 'Reviewed.', done: true }), raw: null }
      },
    }
    const main: ChatProvider = {
      supportsImages: true,
      async complete(_messages, requestOptions): Promise<ProviderResponse> {
        mainImages.push(requestOptions?.imageAttachments?.length ?? 0)
        return { text: JSON.stringify({ reply: 'Reviewed with the image.', done: true }), raw: null }
      },
    }
    const router = await createProviderRouter({ cwd: tmpDir, mainProvider: main, createProviderFromProfile: () => worker })
    const store = new SessionStore(tmpDir)
    const session = store.createSession({ title: 'vision sub-agent smoke' })
    await store.save(session)
    await runAgent(session, 'Review the screenshot.', {
      cwd: tmpDir,
      provider: main,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 3,
      profile: 'reviewer',
      resolveProvider: router.resolveProvider,
      visionHelper: helper,
    })
    const toolText = session.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n')
    fs.rmSync(tmpDir, { recursive: true, force: true })
    return { workerImages, mainImages, toolText }
  }
  const helperCalls: number[] = []
  const withHelper = await runSubAgent(createVisionHelper({
    supportsImages: true,
    async complete(_messages, requestOptions): Promise<ProviderResponse> {
      helperCalls.push(requestOptions?.imageAttachments?.length ?? 0)
      return { text: 'A dashboard with a red error banner.', raw: null }
    },
  }))
  assert(
    'vision helper (sub-agent): a text-only worker uses the helper, and neither worker nor main gets image parts',
    helperCalls.length === 1 &&
      withHelper.toolText.includes('red error banner') &&
      withHelper.workerImages.every((n) => n === 0) &&
      withHelper.mainImages.every((n) => n === 0),
    JSON.stringify({ helperCalls, worker: withHelper.workerImages, main: withHelper.mainImages }),
  )
  const withoutHelper = await runSubAgent(null)
  assert(
    'vision helper (sub-agent): without a helper the viewed image goes to the main profile, never to the text-only worker',
    withoutHelper.workerImages.every((n) => n === 0) &&
      withoutHelper.mainImages.includes(1),
    JSON.stringify({ worker: withoutHelper.workerImages, main: withoutHelper.mainImages }),
  )
}

{
  // max_tokens is bounded by the room left in the context window, because
  // some providers reject prompt + max_tokens above the window.
  const bodies: Array<Record<string, unknown>> = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
      bodies.push(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      // One reply that both the Messages and the chat/completions parsers accept.
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], choices: [{ message: { content: 'ok' } }], usage: {} }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    if (!address || typeof address === 'string') throw new Error('Mock window server failed to bind.')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const big = { id: 'u1', role: 'user' as const, content: 'x'.repeat(32_000), createdAt: new Date().toISOString() }
    const small = { ...big, content: 'hi' }
    const platform = { baseUrl, apiKey: 'k', model: 'gpt-6-sol', contextLength: 20_000, maxOutputTokens: 128_000, capabilitiesSource: 'platform' as const }
    await new MessagesCompatibleProvider({ ...platform, protocol: 'messages' }).completeStream([big], () => {})
    await new MessagesCompatibleProvider({ ...platform, protocol: 'messages' }).completeStream([small], () => {})
    await new OpenAICompatibleProvider({ ...platform, protocol: 'openai' }).complete([big], { maxOutputTokens: 128_000 })
    const [bigMessages, smallMessages, bigOpenAI] = bodies.map((b) => Number(b.max_tokens))
    assert(
      'platform capabilities: max_tokens = min(maxOutputTokens, window − estimated prompt − margin)',
      bigMessages! >= 256 && bigMessages! <= 20_000 - 8_000 - 1_024 &&
        smallMessages! <= 20_000 - 1_024 && smallMessages! > bigMessages! &&
        bigOpenAI === bigMessages,
      JSON.stringify({ bigMessages, smallMessages, bigOpenAI }),
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

{
  // Platform profiles always send plain max_tokens (the gateway translates it
  // per upstream); other profiles keep the name rule for OpenAI reasoning models.
  const bodies: Array<Record<string, unknown>> = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    if (!address || typeof address === 'string') throw new Error('Mock output-param server failed to bind.')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const userMessage = { id: 'u1', role: 'user' as const, content: 'hi', createdAt: new Date().toISOString() }
    await new OpenAICompatibleProvider({ protocol: 'openai', baseUrl, apiKey: 'k', model: 'gpt-5.4', capabilitiesSource: 'platform' }).complete([userMessage], { maxOutputTokens: 1500 })
    await new OpenAICompatibleProvider({ protocol: 'openai', baseUrl, apiKey: 'k', model: 'gpt-5.4' }).complete([userMessage], { maxOutputTokens: 1500 })
    assert(
      'platform capabilities: platform profiles send plain max_tokens even for a reasoning-model alias',
      bodies[0]?.max_tokens === 1500 && bodies[0]?.max_completion_tokens === undefined &&
        bodies[1]?.max_completion_tokens === 1500 && bodies[1]?.max_tokens === undefined,
      JSON.stringify(bodies.map((b) => ({ max_tokens: b.max_tokens, max_completion_tokens: b.max_completion_tokens }))),
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

{
  // A 413 makes the provider retry without the images; the helper must not
  // use (or cache) a description of a request whose images were dropped.
  let requests = 0
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      requests += 1
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.includes('image_url')) {
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'request too large' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'I cannot see any image.' } }], usage: {} }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    if (!address || typeof address === 'string') throw new Error('Mock 413 server failed to bind.')
    const provider = new OpenAICompatibleProvider({ protocol: 'openai', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'k', model: 'vision-alias', supportsImages: true })
    const helper = createVisionHelper(provider)
    const image = { data: 'iVBORw0KGgo=', mediaType: 'image/png' as const }
    const first = await helper.describe([image], { userText: 'what is it?' })
    const second = await helper.describe([image], { userText: 'what is it?' })
    assert(
      'vision helper: a reply after a 413 image strip is a failure and is never cached',
      first[0]?.ok === false && /too large/.test(first[0].error) && second[0]?.ok === false && requests === 4,
      JSON.stringify({ first, second, requests }),
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

{
  // brain: a --model override drops all four platform fields, and a cached
  // lead provider is rebuilt when providers.json changes (a long-lived bridge
  // sees a plan change that flips supportsImages).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-brain-platform-'))
  const originalCwd = process.cwd()
  const providersPath = path.join(tmpDir, '.artemis', 'providers.json')
  const writeProviders = (supportsImages: boolean, mtime: Date) => {
    fs.writeFileSync(providersPath, JSON.stringify({
      defaultMainProfileId: 'platform-main',
      profiles: [{ id: 'platform-main', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'gpt-6-sol', supportsImages, contextLength: 1_000_000, maxOutputTokens: 32_000, capabilitiesSource: 'platform' }],
    }), 'utf8')
    fs.utimesSync(providersPath, mtime, mtime)
  }
  try {
    fs.mkdirSync(path.join(tmpDir, '.artemis'), { recursive: true })
    writeProviders(true, new Date(Date.now() - 60_000))
    process.chdir(tmpDir)
    switchModel(undefined)
    applyProviderOverrides({ model: 'deepseek-chat' })
    const overridden = await getLeadProvider()
    switchModel(undefined)
    applyProviderOverrides({})
    const before = await getLeadProvider()
    writeProviders(false, new Date())
    const after = await getLeadProvider()
    assert(
      'platform capabilities: a --model override clears supportsImages, contextLength, maxOutputTokens and capabilitiesSource',
      overridden.config.model === 'deepseek-chat' &&
        overridden.config.supportsImages === undefined &&
        overridden.config.contextLength === undefined &&
        overridden.config.maxOutputTokens === undefined &&
        overridden.config.capabilitiesSource === undefined &&
        overridden.provider.supportsImages === false,
      JSON.stringify(overridden.config),
    )
    assert(
      'platform capabilities: brain re-reads its provider when providers.json changes (stale supportsImages)',
      before.provider.supportsImages === true && after.provider.supportsImages === false && before.provider !== after.provider,
      `before=${before.provider.supportsImages} after=${after.provider.supportsImages}`,
    )
  } finally {
    process.chdir(originalCwd)
    switchModel(undefined)
    resetSession()
    applyProviderOverrides({})
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ── MCP stdio transport ───────────────────────────────────────────────────────

{
  // The MCP stdio transport is newline-delimited JSON; servers built on the
  // official SDKs read only that. Servers that read only LSP-style
  // Content-Length frames are detected at initialize and still work. A stray
  // non-JSON stdout line must not break a call, and must show up in the error
  // when the server fails. A malformed frame header fails fast (it used to
  // spin forever).
  const { callMcpServerTool, closeCachedMcpClients } = await import('../src/mcp/client.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-mcp-stdio-'))
  type Mode = 'newline' | 'newline-noisy' | 'content-length' | 'content-length-exit'
  const serverSource = (mode: Mode) => `
const framed = ${mode.startsWith('content-length')}
const write = (m) => {
  const body = JSON.stringify(m)
  process.stdout.write(framed ? 'Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body : body + '\\n')
}
${mode === 'newline-noisy' ? "process.stdout.write('server starting...\\n')" : ''}
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  for (;;) {
    let line
    if (framed) {
      // Strict LSP-style reader: anything else is never answered${mode === 'content-length-exit' ? ' (this one exits)' : ''}.
      const m = /^Content-Length: (\\d+)\\r\\n\\r\\n/.exec(buf)
      if (!m) {
        ${mode === 'content-length-exit' ? "if (buf.length > 0) { process.stderr.write('expected Content-Length header\\n'); process.exit(1) }" : ''}
        return
      }
      const end = m[0].length + Number(m[1])
      if (buf.length < end) return
      line = buf.slice(m[0].length, end)
      buf = buf.slice(end)
    } else {
      const i = buf.indexOf('\\n')
      if (i < 0) return
      line = buf.slice(0, i)
      buf = buf.slice(i + 1)
    }
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.id === undefined) continue
    if (msg.method === 'initialize') write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'smoke', version: '1' } } })
    else if (msg.method === 'tools/list') write({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } })
    else if (msg.method === 'tools/call') write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + msg.params.arguments.text }] } })
    else write({ jsonrpc: '2.0', id: msg.id, result: {} })
  }
})
`
  const stdioServer = (id: string, source: string) => {
    const file = path.join(dir, `${id}.mjs`)
    fs.writeFileSync(file, source)
    return {
      id,
      enabled: true,
      transport: 'stdio' as const,
      command: process.execPath,
      commandArgs: [file],
      authType: 'none' as const,
      authState: 'unknown' as const,
      createdAt: '',
      updatedAt: '',
    }
  }
  const callEcho = async (server: ReturnType<typeof stdioServer>): Promise<{ output: string; ms: number }> => {
    const started = Date.now()
    try {
      return { output: (await callMcpServerTool({ server, cwd: dir, toolName: 'echo', args: { text: 'hi' }, timeoutMs: 5000 })).output, ms: Date.now() - started }
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error), ms: Date.now() - started }
    }
  }
  try {
    const cases: [string, Mode][] = [
      ['newline-delimited JSON (MCP spec, official SDKs)', 'newline'],
      ['a server that reads only Content-Length frames (detected at initialize)', 'content-length'],
      ['a Content-Length-only server that exits on unframed input', 'content-length-exit'],
      ['a stray log line on stdout before the first message', 'newline-noisy'],
    ]
    for (const [label, mode] of cases) {
      const { output } = await callEcho(stdioServer(`smoke-${mode}`, serverSource(mode)))
      assert(`mcp stdio: ${label}`, output.includes('echo:hi'), output)
    }

    // The detected framing is remembered: a fresh spawn skips the probe.
    await closeCachedMcpClients()
    const again = await callEcho(stdioServer('smoke-content-length', serverSource('content-length')))
    assert('mcp stdio: detected Content-Length framing is reused on the next spawn', again.output.includes('echo:hi') && again.ms < 2500, `${again.ms}ms ${again.output}`)

    const badHeader = await callEcho(stdioServer('smoke-bad-header', `process.stdin.on('data', () => { process.stdout.write('Content-Length: x\\r\\n\\r\\n{}') })\n`))
    assert('mcp stdio: a malformed Content-Length header fails fast instead of hanging', /Content-Length/.test(badHeader.output) && badHeader.ms < 4000, `${badHeader.ms}ms ${badHeader.output}`)

    const dying = await callEcho(stdioServer('smoke-dying', `process.stdout.write('fatal: missing API token\\n'); setTimeout(() => process.exit(1), 50)\n`))
    assert('mcp stdio: dropped non-JSON stdout lines appear in the failure message', dying.output.includes('fatal: missing API token'), dying.output)
  } finally {
    await closeCachedMcpClients()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ── MCP call timeout and cancellation ─────────────────────────────────────────

{
  // Real tools (search, scrape, render) take longer than a probe: a call that
  // needs ~5 s must not hit the old 4 s default. Connecting keeps a shorter
  // budget than the call, and a cancelled run stops waiting at once (also
  // while the server is still starting) instead of after the timeout.
  const { callMcpServerTool, closeCachedMcpClients, resolveMcpRequestTimeouts, McpCallCancelledError } = await import('../src/mcp/client.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-mcp-timeout-'))
  const slowFile = path.join(dir, 'slow.mjs')
  fs.writeFileSync(slowFile, `
const write = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  for (;;) {
    const i = buf.indexOf('\\n')
    if (i < 0) return
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.id === undefined) continue
    if (msg.method === 'initialize') write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '1' } } })
    else if (msg.method === 'tools/list') write({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'slow', inputSchema: { type: 'object' } }] } })
    else if (msg.method === 'tools/call') setTimeout(() => write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'slow done' }] } }), 5000)
    else write({ jsonrpc: '2.0', id: msg.id, result: {} })
  }
})
`)
  const silentFile = path.join(dir, 'silent.mjs')
  fs.writeFileSync(silentFile, `process.stdin.on('data', () => {})\n`)
  const stdioServer = (id: string, file: string) => ({ id, enabled: true, transport: 'stdio' as const, command: process.execPath, commandArgs: [file], authType: 'none' as const, authState: 'unknown' as const, createdAt: '', updatedAt: '' })
  const callSlow = async (server: ReturnType<typeof stdioServer>, abortAfterMs?: number): Promise<{ output: string; error?: unknown; ms: number }> => {
    const controller = new AbortController()
    const timer = abortAfterMs === undefined ? undefined : setTimeout(() => controller.abort(), abortAfterMs)
    const started = Date.now()
    try {
      const output = (await callMcpServerTool({ server, cwd: dir, toolName: 'slow', args: {}, abortSignal: controller.signal })).output
      return { output, ms: Date.now() - started }
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error), error, ms: Date.now() - started }
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    const timeouts = resolveMcpRequestTimeouts(undefined)
    assert('mcp call: default budget is 120 s for the call and 30 s for connecting', timeouts.callTimeoutMs === 120_000 && timeouts.setupTimeoutMs === 30_000, JSON.stringify(timeouts))
    const explicit = resolveMcpRequestTimeouts(5_000)
    assert('mcp call: an explicit shorter timeout bounds connecting too', explicit.callTimeoutMs === 5_000 && explicit.setupTimeoutMs === 5_000, JSON.stringify(explicit))

    const done = await callSlow(stdioServer('slow', slowFile))
    assert('mcp call: a 5 s tool call completes under the default call timeout', done.output.includes('slow done'), done.output)

    const cancelled = await callSlow(stdioServer('slow-cancel', slowFile), 300)
    assert('mcp call: cancelling a running tool call stops waiting at once', cancelled.error instanceof McpCallCancelledError && cancelled.ms < 2000, `${cancelled.ms}ms ${cancelled.output}`)

    const cancelledConnect = await callSlow(stdioServer('silent-cancel', silentFile), 300)
    assert('mcp call: cancelling while the server never answers initialize stops waiting at once', cancelledConnect.error instanceof McpCallCancelledError && cancelledConnect.ms < 2000, `${cancelledConnect.ms}ms ${cancelledConnect.output}`)
  } finally {
    await closeCachedMcpClients()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

{
  // The retired "Odin" skill subsystem must stay gone: no tool in any table,
  // and a leftover odin.json in the data root is neither read nor touched.
  const retired = 'odin'
  const retiredToolPattern = new RegExp(`\\b${retired}_`, 'i')
  const retiredTools = ['search_skills', 'execute_task', 'fix_skill', 'upload_skill', 'import_cloud_skills'].map((name) => `${retired}_${name}`)
  const profiles = ['main', 'planner', 'researcher', 'builder', 'reviewer', 'brainstormer', 'arbiter', 'architect', 'designer', 'qa'] as const
  const nameLists: Record<string, string[]> = {
    actionTypes: [...ALL_AGENT_ACTION_TYPES],
    runtimeManaged: [...RUNTIME_MANAGED_AGENT_ACTION_TYPES],
    providerCallable: getProviderCallableActionTypes(),
    providerNative: buildProviderNativeFunctionTools().map((tool) => tool.name),
    directNative: buildDirectNativeFunctionTools().map((tool) => tool.name),
    ...Object.fromEntries(profiles.map((profile) => [`profile:${profile}`, getAllowedActionTypesForProfile(profile)])),
  }
  const leaks = Object.entries(nameLists).flatMap(([list, names]) =>
    names.filter((name) => retiredToolPattern.test(name)).map((name) => `${list}:${name}`),
  )
  assert('retired skill tools: no tool list, profile, or native projection exposes them', leaks.length === 0, leaks.join(', '))
  assert(
    'retired skill tools: the detailed tool manifest does not mention them',
    !new RegExp(`\\b${retired}\\b`, 'i').test(renderDetailedToolManifest()) && !retiredToolPattern.test(renderDetailedToolManifest()),
  )
  assert(
    'retired skill tools: registry has no definition and validation rejects them as unknown',
    retiredTools.every((type) => getToolDefinition(type) === undefined && isRuntimeManagedTool(type) === false) &&
      retiredTools.every((type) => validateToolAction({ type, query: 'x', task: 'x', skillId: 'x' }).includes('Unknown tool type')),
  )
  const nativeCall = mapProviderNativeToolCallToAction({
    callId: 'retired-call',
    name: retiredTools[0]!,
    arguments: '{"query":"x"}',
  })
  assert('retired skill tools: a provider-native call to one is rejected', nativeCall.ok === false, JSON.stringify(nativeCall))
  assert(
    `retired skill CLI: parseArgs(['${retired}']) behaves like any unknown command`,
    eq(
      { ...parseArgs([retired, 'list']), prompt: undefined, promptArgs: undefined },
      { ...parseArgs(['zz-not-a-command', 'list']), prompt: undefined, promptArgs: undefined },
    ) &&
      parseArgs([retired, 'list']).command === 'chat' &&
      parseArgs([retired, 'list']).prompt === `${retired} list`,
    JSON.stringify(parseArgs([retired, 'list'])),
  )

  // A corrupt odin.json left in the data root by an older release must not
  // break runAgent or a workflow run, and must be left exactly as it was.
  const tmpDir = path.join(os.tmpdir(), `artemis-retired-skill-store-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const dataRoot = resolveDataRootDir(tmpDir)
  fs.mkdirSync(dataRoot, { recursive: true })
  const legacyFile = path.join(dataRoot, `${retired}.json`)
  const corrupt = '{"version":1,"skills":[{"id":"x", this is not json'
  fs.writeFileSync(legacyFile, corrupt)
  const store = new SessionStore(tmpDir)
  const session = store.createSession({ title: 'retired skill store smoke' })
  await store.save(session)
  const systemTexts: string[] = []
  const infos: string[] = []
  const provider: ChatProvider = {
    async complete(messages, options): Promise<ProviderResponse> {
      systemTexts.push(JSON.stringify({ messages, options }))
      return { text: JSON.stringify({ reply: 'Done without skill hints.', done: true }), raw: null }
    },
  }
  let runError: unknown
  let reply = ''
  try {
    const result = await runAgent(session, 'search skills for a deploy task', {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 2,
      profile: 'main',
      onInfo: (message) => infos.push(message),
    })
    reply = result.reply
  } catch (error) {
    runError = error
  }
  assert(
    'retired skill store: runAgent still runs with a corrupt odin.json in the data root',
    runError === undefined && reply.includes('Done without skill hints'),
    runError instanceof Error ? runError.message : reply,
  )
  assert(
    'retired skill store: no skill-hint section or info line reaches the run',
    systemTexts.length > 0 &&
      systemTexts.every((text) => !new RegExp(`\\b${retired}\\b`, 'i').test(text)) &&
      infos.every((message) => !new RegExp(`\\b${retired}\\b`, 'i').test(message)),
    infos.join(' | '),
  )

  let workflowError: unknown
  let workflowReply = ''
  try {
    const result = await runWorkflowMode('direct', session, 'one more simple step', {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 2,
      profile: 'main',
    })
    workflowReply = result.reply
  } catch (error) {
    workflowError = error
  }
  assert(
    'retired skill store: a direct workflow run completes with a corrupt odin.json present',
    workflowError === undefined && workflowReply.includes('Done without skill hints'),
    workflowError instanceof Error ? workflowError.message : workflowReply,
  )
  // buildContextWindow is gone; the shared context manager must likewise
  // not depend on the workspace for anything skill-related.
  const contextInput = {
    messages: session.messages,
    fixedTokens: 1_000,
    budget: resolveContextBudget({ contextWindow: 128_000 }),
  }
  const contextWithCwd = await manageContext({ ...contextInput, state: createContextState(), restore: { cwd: tmpDir } })
  const contextWithoutCwd = await manageContext({ ...contextInput, state: createContextState() })
  assert(
    'retired skill store: context management gives the same result with or without a cwd',
    eq(contextWithCwd.messages, contextWithoutCwd.messages) &&
      contextWithCwd.messages.every((message) => !new RegExp(`\\b${retired}\\b`, 'i').test(message.content)),
  )
  assert(
    'retired skill store: the legacy odin.json is left untouched',
    fs.existsSync(legacyFile) && fs.readFileSync(legacyFile, 'utf8') === corrupt,
  )
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

// ── summary ───────────────────────────────────────────────────────────────────

console.log()
if (failed === 0) {
  console.log(`  \x1b[32m✔ All ${passed} tests passed\x1b[0m\n`)
} else {
  console.log(`  \x1b[31m✘ ${failed} failed, ${passed} passed\x1b[0m\n`)
  process.exit(1)
}
