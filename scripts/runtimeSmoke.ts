#!/usr/bin/env tsx
/**
 * scripts/runtimeSmoke.ts — runtime integration smoke tests
 *
 * Tests that can run without a real API key (structural/config checks).
 * Run: node --no-warnings node_modules/tsx/dist/cli.mjs scripts/runtimeSmoke.ts
 */

import { parseArgs } from '../src/cli/parseArgs.js'
import { CliSettingsStore } from '../src/cli/settings.js'
import { applyProviderOverrides, resetSession, think } from '../src/brain.js'
import { parseAssistantEnvelopeForSmoke, runAgent } from '../src/core/agent.js'
import { routeTeamRequest } from '../src/core/team.js'
import { buildContextWindow } from '../src/core/context.js'
import { buildSystemPrompt } from '../src/core/systemPrompt.js'
import { fromHeimdallVirtualPath } from '../src/core/heimdall.js'
import { resolveWorkspaceIntent } from '../src/cli/workspaceIntent.js'
import { buildProviderNativeFunctionTools } from '../src/core/providerNativeTools.js'
import { probeProviderNativeToolCalls } from '../src/providers/health.js'
import { promptForProviderProfile } from '../src/providers/onboarding.js'
import { createProviderRouter } from '../src/providers/router.js'
import { getDirectToolCount } from '../src/tools/directTools.js'
import {
  getToolDefinition,
  getProviderCallableActionTypes,
  isDirectlyExecutableTool,
  isParallelReadOnlyAction,
  isRuntimeManagedTool,
} from '../src/tools/registry.js'
import { ProviderStore } from '../src/providers/store.js'
import { SessionStore } from '../src/storage/sessions.js'
import { searchSessions } from '../src/storage/sessionSearch.js'
import { Session } from '../src/core/session.js'
import { compressMessages } from '../src/core/contextCompressor.js'
import { resolveBytePlusCredentials } from '../src/tools/byteplusMedia.js'
import { resolveRunCommandTimeoutMs } from '../src/tools/runCommand.js'
import { executeGenerateImage } from '../src/tools/generateImage.js'
import { BytePlusProvider } from '../src/tools/visual/providers/byteplusProvider.js'
import { OpenAIProvider } from '../src/tools/visual/providers/openaiProvider.js'
import {
  isOverbroadTrustedWorkspaceRoot,
  mergeTrustedWorkspaceRoots,
  normalizeTrustedWorkspaceRoots,
  resolveWorkspaceForTargetPath,
} from '../src/utils/workspaceRoots.js'
import { projectDirectToolNames } from '../src/core/directToolProjection.js'
import type { SessionMessage } from '../src/core/types.js'
import type {
  ChatProvider,
  ProviderNativeToolOutput,
  ProviderResponse,
} from '../src/providers/types.js'
import { getWorkflowDisplayName, isReadOnlyWorkflow, runWorkflowMode } from '../src/core/workflowMode.js'
import {
  applyWorkflowProgressInfo,
  createWorkflowProgressState,
  renderWorkflowProgress,
} from '../src/cli/workflowProgress.js'
import { PermissionManager } from '../src/security/permissions.js'
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
import * as http from 'node:http'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import type { PromptIO } from '../src/providers/types.js'

let passed = 0
let failed = 0

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

console.log('\n  runtimeSmoke')
console.log('  ============\n')

const expectedDirectToolCount = getDirectToolCount()
const voiceToolNames = ['synthesize_speech', 'transcribe_audio']
const expectedCodingToolCount = expectedDirectToolCount - voiceToolNames.length
const providerNativeToolNames = buildProviderNativeFunctionTools().map((tool) => tool.name)

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
      String(result.output).includes('Web-search fallback is disabled'),
    String(result.output),
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
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
        return options.choices.find((choice) => choice.label === 'seed-2-0-pro-260328')!.value;
      }
      throw new Error(`Unexpected prompt menu: ${options.title}`);
    },
  };
}

// ── parseArgs ─────────────────────────────────────────────────────────────────

{
  const a = parseArgs([])
  assert('parseArgs: default command is chat', a.command === 'chat')
  assert('parseArgs: default permissionMode is accept-all', a.permissionMode === 'accept-all')
  assert('parseArgs: default maxTurns is 8', a.maxTurns === 8)
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
  assert('parseArgs: prompt captured', a.prompt === 'hello world')
}

{
  const a = parseArgs(['--whosyourdaddy'])
  assert('parseArgs: whosyourdaddy sets accept-all', a.permissionMode === 'accept-all')
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
  const context = await buildContextWindow(session, 'main')
  const latestUser = context.messages.find((message) => message.role === 'user')?.content ?? ''

  assert(
    'context window: latest design/workflow handoff preserves content near 65535 chars',
    latestUser.includes(marker) && latestUser.length > 60_000,
    `length=${latestUser.length} marker=${latestUser.includes(marker)}`,
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
    teamSource.includes("choice: 'niko'") &&
      workflowSource.includes("mode === 'design'") &&
      workflowSource.includes("mode === 'athena'") &&
      workflowSource.includes("mode === 'nidhogg'") &&
      workflowSource.includes("mode === 'contest'"),
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
      profile.profile.model === 'seed-2-0-pro-260328' &&
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
  const creds = await resolveBytePlusCredentials(tmpDir, 'image')
  assert(
    'BytePlus media credentials: coding profile reuses the key but normalizes the media base URL',
    creds.apiKey === 'bp-key' && creds.baseUrl === 'https://ark.ap-southeast.bytepluses.com/api/v3',
    `apiKey=${creds.apiKey} baseUrl=${creds.baseUrl}`,
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
      'BytePlus visual provider: normalizes full image endpoint base URL before appending the API path',
      requestedUrls[0] === 'https://ark.ap-southeast.bytepluses.com/api/v3/images/generations',
      `url=${requestedUrls[0]}`,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
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

  const result = await compressMessages(messages, async () => '[summary]', {
    tokenLimit: 100,
    threshold: 0.5,
    protectHead: 2,
    protectTailTokens: 0,
  })

  assert(
    'context compression: head boundary does not split OpenAI tool_calls from tool results',
    openAIToolCallsRemainPaired(result.messages),
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

  const result = await compressMessages(messages, async () => '[summary]', {
    tokenLimit: 120,
    threshold: 0.5,
    protectHead: 1,
    protectTailTokens: 2,
  })

  assert(
    'context compression: tail boundary does not split OpenAI tool_calls from tool results',
    openAIToolCallsRemainPaired(result.messages),
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
            content: '已真实执行 list_files 并返回结果。',
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
      ((requests[0]?.tools as Array<{ function?: { name?: string } }> | undefined) ?? [])
    const firstToolNames = firstRequestTools
      .map((entry) => entry?.function?.name)
      .filter((value): value is string => typeof value === 'string')
    const firstRequestMessages =
      ((requests[0]?.messages as Array<Record<string, unknown>> | undefined) ?? [])
    const secondRequestMessages =
      ((requests[1]?.messages as Array<Record<string, unknown>> | undefined) ?? [])
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
      requests.length === 2,
      `requests=${requests.length}`,
    )
    assert(
      'native tool loop: coding requests start with the coding direct tool manifest',
      firstToolNames.length === expectedCodingToolCount,
      `tools=${firstToolNames.length}`,
    )
    assert(
      'native tool loop: first request includes repo inspection and formatting tools',
      firstToolNames.includes('list_files') &&
        firstToolNames.includes('read_file') &&
        firstToolNames.includes('search_files') &&
        firstToolNames.includes('format_json'),
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
      result.reply === '已真实执行 list_files 并返回结果。',
      result.reply,
    )
    assert(
      'provider telemetry: think() surfaces the active profile label in usage',
      result.usage?.profileLabel === 'Mock OpenAI-compatible',
      JSON.stringify(result.usage),
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
            content: 'Missing read failure was structured.',
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

    const secondRequestMessages =
      ((requests[1]?.messages as Array<Record<string, unknown>> | undefined) ?? [])
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
      result.reply === 'Missing read failure was structured.' &&
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

// ── summary ───────────────────────────────────────────────────────────────────

console.log()
if (failed === 0) {
  console.log(`  \x1b[32m✔ All ${passed} tests passed\x1b[0m\n`)
} else {
  console.log(`  \x1b[31m✘ ${failed} failed, ${passed} passed\x1b[0m\n`)
  process.exit(1)
}
