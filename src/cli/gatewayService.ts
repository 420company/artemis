import path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { appendFile, mkdir, writeFile, unlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { UiLocale } from './locale.js'
import type { PermissionMode } from './parseArgs.js'
import { buildPanel } from './ui.js'
import { SessionStore } from '../storage/sessions.js'
import { runTelegramBridge, shouldAutoStartTelegram } from '../telegram/bridge.js'
import { runDiscordBridge, shouldAutoStartDiscordBridge } from '../discord/bridge.js'
import { runWeChatBridge, shouldAutoStartWeChatBridge } from '../wechat/bridge.js'
import { BragiStore } from '../bragi/store.js'

const LAUNCH_AGENT_LABEL = 'com.artemis.gateway'
const LAUNCH_AGENT_FILE = `${LAUNCH_AGENT_LABEL}.plist`
const LEGACY_LAUNCH_AGENT_LABEL = 'company.420.artemis.gateway'
const LEGACY_LAUNCH_AGENT_FILE = `${LEGACY_LAUNCH_AGENT_LABEL}.plist`
const WINDOWS_TASK_NAME = 'ArtemisGateway'

type GatewayCommandOptions = {
  cwd: string
  locale: UiLocale
  args: string[]
}

type CommandResult = {
  code: number
  stdout: string
  stderr: string
}

function t(locale: UiLocale, zh: string, en: string): string {
  return locale === 'zh-CN' ? zh : en
}

function dataDir(): string {
  return path.join(os.homedir(), '.artemis')
}

function normalizeGatewayCwd(cwd: string): string {
  return path.resolve(cwd)
}

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', LAUNCH_AGENT_FILE)
}

function legacyPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', LEGACY_LAUNCH_AGENT_FILE)
}

function windowsWrapperPath(): string {
  return path.join(dataDir(), 'gateway.cmd')
}

function windowsVbsWrapperPath(): string {
  return path.join(dataDir(), 'gateway.vbs')
}

function guiDomain(): string {
  return `gui/${process.getuid?.() ?? os.userInfo().uid}`
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function runLaunchctl(args: string[]): Promise<CommandResult> {
  return new Promise(resolve => {
    execFile('/bin/launchctl', args, (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
        ? Number((error as NodeJS.ErrnoException).code)
        : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

function runWindowsCommand(args: string[]): Promise<CommandResult> {
  return new Promise(resolve => {
    execFile('cmd.exe', ['/d', '/s', '/c', ...args], (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
        ? Number((error as NodeJS.ErrnoException).code)
        : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

function resolveNpmInstalledCli(): string[] | undefined {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const names = process.platform === 'win32' ? ['artemis.cmd', 'artemis.exe', 'artemis'] : ['artemis']
  for (const dir of pathEntries) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (!fs.existsSync(candidate)) continue
        const real = fs.realpathSync(candidate)
        if (!real.replace(/\\/g, '/').includes('/node_modules/artemis-code/')) continue
        if (real.endsWith('.js')) return [process.execPath, real]
        if (process.platform === 'win32' && (name.endsWith('.cmd') || name.endsWith('.exe'))) return [candidate]
      } catch {
        // keep searching PATH
      }
    }
  }
  return undefined
}

function resolveCliProgramArguments(cwd: string): string[] {
  const npmCli = resolveNpmInstalledCli()
  if (npmCli) {
    return [...npmCli, 'gateway', 'daemon', '--cwd', cwd]
  }

  const argvEntry = process.argv[1]
  if (argvEntry && fs.existsSync(argvEntry) && argvEntry.endsWith('.js')) {
    return [process.execPath, argvEntry, 'gateway', 'daemon', '--cwd', cwd]
  }

  const here = path.dirname(fileURLToPath(import.meta.url))
  const distCli = path.resolve(here, '..', 'cli.js')
  if (fs.existsSync(distCli)) {
    return [process.execPath, distCli, 'gateway', 'daemon', '--cwd', cwd]
  }

  const sourceCli = path.resolve(here, '..', '..', 'src', 'cli.ts')
  const tsxCli = path.resolve(here, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
  if (fs.existsSync(sourceCli) && fs.existsSync(tsxCli)) {
    return [process.execPath, '--no-warnings', '--disable-warning=DEP0005', tsxCli, sourceCli, 'gateway', 'daemon', '--cwd', cwd]
  }

  return [process.execPath, argvEntry ?? 'artemis', 'gateway', 'daemon', '--cwd', cwd]
}

function buildLaunchAgentPlist(cwd: string): string {
  const programArgs = resolveCliProgramArguments(cwd)
  const outLog = path.join(dataDir(), 'gateway.launchd.log')
  const errLog = path.join(dataDir(), 'gateway.launchd.err.log')
  const argXml = programArgs.map(arg => `    <string>${escapeXml(arg)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(cwd)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(errLog)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ARTEMIS_GATEWAY_DAEMON</key>
    <string>1</string>
  </dict>
</dict>
</plist>
`
}

function quoteCmdArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

function buildWindowsWrapper(cwd: string): string {
  const argsArray = resolveCliProgramArguments(cwd).map(quoteCmdArg)
  let cmdStr = argsArray.join(' ')
  if (argsArray[0]?.toLowerCase().endsWith('.cmd"')) {
    cmdStr = 'call ' + cmdStr
  }
  const log = path.join(dataDir(), 'gateway.windows.log')
  const nodeDir = path.dirname(process.execPath)
  return `@echo off\r\nset "PATH=${nodeDir};%PATH%"\r\ncd /d ${quoteCmdArg(cwd)}\r\n${cmdStr} >> ${quoteCmdArg(log)} 2>&1\r\n`
}

function buildWindowsVbsWrapper(): string {
  return `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run chr(34) & "${windowsWrapperPath()}" & Chr(34), 0\r\nSet WshShell = Nothing\r\n`
}

async function installLaunchAgent(cwd: string): Promise<void> {
  await mkdir(path.dirname(plistPath()), { recursive: true })
  await mkdir(dataDir(), { recursive: true })
  await runLaunchctl(['bootout', guiDomain(), legacyPlistPath()])
  await unlink(legacyPlistPath()).catch(err => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  })
  await writeFile(plistPath(), buildLaunchAgentPlist(cwd), 'utf8')
  await runLaunchctl(['bootout', guiDomain(), plistPath()])
  const loaded = await runLaunchctl(['bootstrap', guiDomain(), plistPath()])
  if (loaded.code !== 0) {
    throw new Error((loaded.stderr || loaded.stdout || 'launchctl bootstrap failed').trim())
  }
  await runLaunchctl(['enable', `${guiDomain()}/${LAUNCH_AGENT_LABEL}`])
}

async function uninstallLaunchAgent(): Promise<void> {
  await runLaunchctl(['bootout', guiDomain(), plistPath()])
  await unlink(plistPath()).catch(err => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  })
  await runLaunchctl(['bootout', guiDomain(), legacyPlistPath()])
  await unlink(legacyPlistPath()).catch(err => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  })
}

async function startLaunchAgent(cwd: string): Promise<void> {
  if (!fs.existsSync(plistPath())) {
    await installLaunchAgent(cwd)
    return
  }
  await runLaunchctl(['bootstrap', guiDomain(), plistPath()])
  await runLaunchctl(['kickstart', '-k', `${guiDomain()}/${LAUNCH_AGENT_LABEL}`])
}

async function stopLaunchAgent(): Promise<void> {
  await runLaunchctl(['bootout', guiDomain(), plistPath()])
}

async function getLaunchAgentStatus(): Promise<string[]> {
  const result = await runLaunchctl(['print', `${guiDomain()}/${LAUNCH_AGENT_LABEL}`])
  const installed = fs.existsSync(plistPath())
  const legacyInstalled = fs.existsSync(legacyPlistPath())
  const plist = installed ? fs.readFileSync(plistPath(), 'utf8') : ''
  const plistStrings = [...plist.matchAll(/<string>([\s\S]*?)<\/string>/g)]
    .map(match => match[1]
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&'))
  const argStart = plistStrings.findIndex(value => value === process.execPath || value.endsWith('/node') || value.endsWith('node.exe'))
  const programArgs = argStart >= 0 ? plistStrings.slice(argStart, argStart + 6).join(' ') : undefined
  const workingDirectory = plist.match(/<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/)?.[1]
  if (result.code !== 0) {
    return [
      `Installed: ${installed ? 'yes' : 'no'}`,
      'Loaded: no',
      `Plist: ${plistPath()}`,
      programArgs ? `Program: ${programArgs}` : undefined,
      workingDirectory ? `WorkingDirectory: ${workingDirectory}` : undefined,
      legacyInstalled ? `Legacy plist present: ${legacyPlistPath()}` : undefined,
    ].filter((line): line is string => Boolean(line))
  }
  const pid = result.stdout.match(/pid = (\d+)/)?.[1]
  const state = result.stdout.match(/state = ([^\n]+)/)?.[1]?.trim()
  return [
    `Installed: ${installed ? 'yes' : 'no'}`,
    'Loaded: yes',
    `Running: ${pid ? `yes (pid ${pid})` : 'unknown'}`,
    state ? `State: ${state}` : undefined,
    `Plist: ${plistPath()}`,
    programArgs ? `Program: ${programArgs}` : undefined,
    workingDirectory ? `WorkingDirectory: ${workingDirectory}` : undefined,
    legacyInstalled ? `Legacy plist present: ${legacyPlistPath()}` : undefined,
    `Log: ${path.join(dataDir(), 'gateway.log')}`,
  ].filter((line): line is string => Boolean(line))
}

export async function ensureGatewayAutoStart(cwd: string): Promise<void> {
  cwd = normalizeGatewayCwd(cwd)
  if (process.platform === 'darwin') {
    await installLaunchAgent(cwd)
    return
  }
  if (process.platform === 'win32') {
    await installWindowsTask(cwd)
    return
  }
}

async function getBridgeConfigStatus(cwd: string): Promise<string[]> {
  const bragiData = await new BragiStore(cwd).load().catch(() => undefined)
  const lines = ['Bridges:']
  let runnable = 0
  for (const platform of ['telegram', 'discord', 'wechat'] as const) {
    const config = bragiData?.platforms[platform]
    const enabled = config?.enabled !== false && Boolean(config)
    const autoStart = config?.autoStartOnLaunch === true
    const hasCredentials = Boolean(config?.credentials && Object.keys(config.credentials).length > 0)
    if (enabled && autoStart && hasCredentials) runnable += 1
    lines.push(`  ${platform}: configured=${hasCredentials ? 'yes' : 'no'}, enabled=${enabled ? 'yes' : 'no'}, autoStart=${autoStart ? 'yes' : 'no'}`)
  }
  if (runnable === 0) {
    lines.push('No runnable bridge yet. Configure Telegram/Discord/WeChat once; setup now enables background auto-start automatically.')
  }
  return lines
}

async function installWindowsTask(cwd: string): Promise<void> {
  await mkdir(dataDir(), { recursive: true })
  await writeFile(windowsWrapperPath(), buildWindowsWrapper(cwd), 'utf8')
  await writeFile(windowsVbsWrapperPath(), buildWindowsVbsWrapper(), 'utf8')
  const create = await runWindowsCommand([
    'schtasks', '/Create', '/TN', WINDOWS_TASK_NAME, '/TR', `wscript.exe "${windowsVbsWrapperPath()}"`,
    '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F',
  ])
  if (create.code !== 0) {
    throw new Error((create.stderr || create.stdout || 'schtasks create failed').trim())
  }
  await runWindowsCommand(['schtasks', '/Run', '/TN', WINDOWS_TASK_NAME])
}

async function uninstallWindowsTask(): Promise<void> {
  await runWindowsCommand(['schtasks', '/End', '/TN', WINDOWS_TASK_NAME])
  await runWindowsCommand(['schtasks', '/Delete', '/TN', WINDOWS_TASK_NAME, '/F'])
  await unlink(windowsWrapperPath()).catch(err => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  })
  await unlink(windowsVbsWrapperPath()).catch(err => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  })
}

async function startWindowsTask(cwd: string): Promise<void> {
  if (!fs.existsSync(windowsWrapperPath())) {
    await installWindowsTask(cwd)
    return
  }
  await runWindowsCommand(['schtasks', '/Run', '/TN', WINDOWS_TASK_NAME])
}

async function stopWindowsTask(): Promise<void> {
  await runWindowsCommand(['schtasks', '/End', '/TN', WINDOWS_TASK_NAME])
}

async function getWindowsTaskStatus(): Promise<string[]> {
  const result = await runWindowsCommand(['schtasks', '/Query', '/TN', WINDOWS_TASK_NAME, '/FO', 'LIST', '/V'])
  const installed = result.code === 0
  return [
    `Installed: ${installed ? 'yes' : 'no'}`,
    installed ? result.stdout.split(/\r?\n/).filter(line => /TaskName:|Status:|Last Run Time:|Next Run Time:/.test(line)).join('\n') : 'Loaded: no',
    `Task: ${WINDOWS_TASK_NAME}`,
    `Wrapper: ${windowsVbsWrapperPath()}`,
    `Log: ${path.join(dataDir(), 'gateway.windows.log')}`,
  ]
}

export async function runGatewayDaemon(options: { cwd: string; permissionMode?: PermissionMode }): Promise<void> {
  options = { ...options, cwd: normalizeGatewayCwd(options.cwd) }
  await mkdir(dataDir(), { recursive: true })
  const sessionStore = new SessionStore(options.cwd)
  const logPath = path.join(dataDir(), 'gateway.log')
  const log = (name: string, message: string) => {
    const line = `[${new Date().toISOString()}] [${name}] ${message}\n`
    appendFile(logPath, line).catch(() => {})
  }

  const aborts: AbortController[] = []
  const started = new Set<string>()
  const defaultPermissionMode = options.permissionMode ?? 'accept-all'
  let active = 0

  // The daemon is the sole bridge owner. The interactive CLI never kills this
  // process; it only monitors the gateway.log file to display bridge messages.

  const startBridge = (name: string, fn: (signal: AbortSignal) => Promise<void>) => {
    if (started.has(name)) return
    started.add(name)
    active += 1
    const ac = new AbortController()
    aborts.push(ac)
    const run = (delayMs: number) => {
      if (ac.signal.aborted) return
      log(name, 'starting')
      fn(ac.signal).catch(err => {
        const msg = err instanceof Error ? err.message : String(err)
        if (ac.signal.aborted || msg.includes('aborted')) return
        log(name, `crash: ${msg}`)
        const next = Math.min(delayMs * 2, 60_000)
        log(name, `restarting in ${next / 1000}s`)
        setTimeout(() => run(next), next)
      })
    }
    run(2_000)
  }

  if (await shouldAutoStartTelegram(options.cwd)) {
    startBridge('telegram', signal => runTelegramBridge({ cwd: options.cwd, sessionStore, maxTurns: 8, defaultPermissionMode, signal, onInfo: msg => log('telegram', msg) }))
  }
  if (await shouldAutoStartDiscordBridge(options.cwd)) {
    startBridge('discord', signal => runDiscordBridge({ cwd: options.cwd, sessionStore, maxTurns: 8, defaultPermissionMode, signal, onInfo: msg => log('discord', msg) }))
  }
  if (await shouldAutoStartWeChatBridge(options.cwd)) {
    startBridge('wechat', signal => runWeChatBridge({ cwd: options.cwd, sessionStore, maxTurns: 8, defaultPermissionMode, signal, onInfo: msg => log('wechat', msg) }))
  }

  if (active === 0) {
    log('gateway', 'no auto-start bridges configured; staying alive')
  } else {
    log('gateway', `started ${active} bridge(s) for ${options.cwd}`)
  }

  // Keep the daemon process alive even when no bridge is configured yet, or
  // when all bridge clients are currently waiting in promise-only polling code.
  // A bare unresolved Promise does not keep Node's event loop alive, so launchd
  // used to see a clean exit immediately after reboot and the phone bridges had
  // nothing left to wake up.
  const keepAlive = setInterval(() => {
    log('gateway', `heartbeat; active=${active}; cwd=${options.cwd}`)
  }, 5 * 60_000)

  let stopIdle: (() => void) | undefined
  try {
    const { startIdleWatcher } = await import('../services/idleWatcher.js')
    stopIdle = startIdleWatcher(options.cwd)
    log('gateway', 'idle watcher started')
  } catch (err) {
    log('gateway', `failed to start idle watcher: ${err instanceof Error ? err.message : String(err)}`)
  }

  await new Promise<void>(resolve => {
    const stop = () => {
      log('gateway', 'stopping')
      clearInterval(keepAlive)
      stopIdle?.()
      for (const ac of aborts) ac.abort()
      setTimeout(resolve, 250)
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  })
}

export async function runGatewayCommand(options: GatewayCommandOptions): Promise<void> {
  const { locale, args } = options
  const cwd = normalizeGatewayCwd(options.cwd)
  const sub = args[0]?.toLowerCase() ?? 'help'
  const platformName = process.platform === 'win32' ? 'Windows Task Scheduler' : 'macOS LaunchAgent'

  if (sub === 'daemon') {
    await runGatewayDaemon({ cwd })
    return
  }

  if (sub === 'install' || sub === 'enable') {
    if (process.platform === 'darwin') await installLaunchAgent(cwd)
    else if (process.platform === 'win32') await installWindowsTask(cwd)
    else throw new Error('Artemis gateway auto-start currently supports macOS LaunchAgent and Windows Task Scheduler only.')
    console.log()
    console.log(buildPanel(t(locale, 'Gateway 已安装并启动', 'Gateway installed and started'), [
      t(locale, '以后系统登录后，Telegram/Discord/WeChat bridge 会在后台自动启动。', 'After OS login, Telegram/Discord/WeChat bridges will start in the background.'),
      `Backend: ${platformName}`,
      process.platform === 'darwin' ? `Plist: ${plistPath()}` : `Task: ${WINDOWS_TASK_NAME}`,
      `CWD: ${cwd}`,
      ...(await getBridgeConfigStatus(cwd)),
    ]))
    console.log()
    return
  }

  if (sub === 'uninstall' || sub === 'disable') {
    if (process.platform === 'darwin') await uninstallLaunchAgent()
    else if (process.platform === 'win32') await uninstallWindowsTask()
    else throw new Error('Artemis gateway auto-start currently supports macOS LaunchAgent and Windows Task Scheduler only.')
    console.log()
    console.log(buildPanel(t(locale, 'Gateway 已卸载', 'Gateway uninstalled'), [
      t(locale, '重启后不会再自动启动第三方通讯 bridge。', 'Bridges will not auto-start after reboot.'),
    ]))
    console.log()
    return
  }

  if (sub === 'start') {
    if (process.platform === 'darwin') await startLaunchAgent(cwd)
    else if (process.platform === 'win32') await startWindowsTask(cwd)
    else throw new Error('Artemis gateway auto-start currently supports macOS LaunchAgent and Windows Task Scheduler only.')
    console.log()
    console.log(buildPanel(t(locale, 'Gateway 已启动', 'Gateway started'), process.platform === 'win32' ? await getWindowsTaskStatus() : await getLaunchAgentStatus()))
    console.log()
    return
  }

  if (sub === 'stop') {
    if (process.platform === 'darwin') await stopLaunchAgent()
    else if (process.platform === 'win32') await stopWindowsTask()
    else throw new Error('Artemis gateway auto-start currently supports macOS LaunchAgent and Windows Task Scheduler only.')
    console.log()
    console.log(buildPanel(t(locale, 'Gateway 已停止', 'Gateway stopped'), [
      t(locale, '自启配置仍保留；下次登录会再次自动启动。若要永久关闭，运行 artemis gateway uninstall。', 'Auto-start config remains installed; it will start again next login. To disable permanently, run artemis gateway uninstall.'),
    ]))
    console.log()
    return
  }

  if (sub === 'restart') {
    if (process.platform === 'darwin') {
      await stopLaunchAgent()
      await startLaunchAgent(cwd)
    } else if (process.platform === 'win32') {
      await stopWindowsTask()
      await startWindowsTask(cwd)
    } else throw new Error('Artemis gateway auto-start currently supports macOS LaunchAgent and Windows Task Scheduler only.')
    console.log()
    console.log(buildPanel(t(locale, 'Gateway 已重启', 'Gateway restarted'), process.platform === 'win32' ? await getWindowsTaskStatus() : await getLaunchAgentStatus()))
    console.log()
    return
  }

  if (sub === 'status') {
    console.log()
    console.log(buildPanel(
      t(locale, 'Gateway 状态', 'Gateway status'),
      [
        ...(process.platform === 'win32' ? await getWindowsTaskStatus() : await getLaunchAgentStatus()),
        `CWD: ${cwd}`,
        ...(await getBridgeConfigStatus(cwd)),
      ]
    ))
    console.log()
    return
  }

  console.log()
  console.log(buildPanel(t(locale, 'Gateway 后台服务', 'Gateway background service'), [
    'artemis gateway install    ' + t(locale, '安装并启动开机/登录自启', 'Install and start login auto-start'),
    'artemis gateway start      ' + t(locale, '启动后台服务', 'Start background service'),
    'artemis gateway stop       ' + t(locale, '停止本次后台服务（保留自启）', 'Stop current service, keep auto-start'),
    'artemis gateway restart    ' + t(locale, '重启后台服务并重新读取 bridge 配置', 'Restart background service and reload bridge config'),
    'artemis gateway uninstall  ' + t(locale, '永久关闭并移除自启', 'Disable and remove auto-start'),
    'artemis gateway status     ' + t(locale, '查看状态', 'Show status'),
  ]))
  console.log()
}
