import type { SessionMessage } from './types.js';
import { listDirectToolNames } from '../tools/directTools.js';

const ALL_DIRECT_TOOL_NAMES = listDirectToolNames();
const ALL_DIRECT_TOOL_NAME_SET = new Set(ALL_DIRECT_TOOL_NAMES);

const CORE_INSPECT_TOOLS = [
  'list_files',
  'read_file',
  'search_files',
  'path_info',
  'file_info',
  'list_directory',
  'get_imports',
  'count_lines',
] as const;

const EDIT_TOOLS = [
  'write_file',
  'insert_in_file',
  'replace_in_file',
  'apply_patch',
  'delete_file',
  'create_directory',
  'delete_directory',
  'move_file',
  'copy_file',
  'format_code',
] as const;

const SHELL_VERIFY_TOOLS = [
  'run_command',
  'npm_run',
  'which_command',
  'get_system_info',
  'git_status',
] as const;

const GIT_TOOLS = [
  'git_status',
  'git_diff',
  'git_log',
  'git_add',
  'git_commit',
  'git_branch',
] as const;

const DOCS_TOOLS = [
  'lookup_docs',
  'http_request',
  'parse_url',
  'check_url',
] as const;

const NETWORK_TOOLS = [
  'http_request',
  'check_url',
  'download_file',
  'dns_lookup',
  'parse_url',
] as const;

const TEXT_UTILITY_TOOLS = [
  'regex_match',
  'json_query',
  'format_json',
  'diff_text',
  'sort_lines',
  'dedupe_lines',
  'base64_encode',
  'base64_decode',
  'hash_text',
  'hash_file',
  'url_encode',
  'calculate',
  'generate_uuid',
] as const;

const ENV_TIME_TOOLS = [
  'get_env',
  'date_now',
] as const;

const MEDIA_TOOLS = [
  'generate_image',
  'generate_video',
  'generate_long_video',
] as const;

const BROWSER_TOOLS = [
  'browser_navigate',
  'browser_screenshot',
  'browser_extract_text',
  'browser_click',
  'browser_type',
  'browser_wait_for',
  'browser_close',
] as const;

const MUSIC_TOOLS = [
  'spotify_play_liked',
  'spotify_search_and_play',
  'spotify_play_playlist',
  'spotify_resume',
  'spotify_pause',
  'spotify_skip_next',
  'spotify_skip_previous',
  'spotify_set_volume',
  'spotify_now_playing',
  'spotify_set_device',
] as const;

const PRODUCTIVITY_TOOLS = [
  'calendar_list_today',
  'calendar_list_upcoming',
  'calendar_add_event',
  'reminders_list',
  'reminders_add',
  'reminders_complete',
] as const;

const AMBIENT_INFO_TOOLS = [
  'weather_current',
  'weather_forecast',
  'world_clock',
  'time_diff',
  'currency_convert',
  'currency_rates',
  'flight_lookup',
] as const;

const SPEECH_TOOLS = [
  'synthesize_speech',
  'transcribe_audio',
] as const;

const MCP_MANAGEMENT_TOOLS = [
  'mcp_list',
  'mcp_enable',
  'mcp_disable',
  'mcp_suggest',
] as const;

const BRIDGE_TOOLS = [
  'bridge_send_video',
  'bridge_send_image',
] as const;

const FILE_OPERATION_REQUEST_RE =
  /(?:\b(create|mkdir|directory|folder|进入|cd|工作区|workspace|setup)\b|建立|创建|文件夹|目录|进入|工作区)/i;

const CONTINUATION_REQUEST_RE =
  /^(?:继续|接着|继续吧|继续做|继续处理|继续改|往下|继续往下|go on|continue|carry on|keep going|then\b|next\b)/iu;

const CODING_REQUEST_RE =
  /(?:\b(code|coding|file|files|directory|repo|repository|project|patch|edit|modify|fix|implement|refactor|rename|command|shell|terminal|git|diff|bug|error|test|tests|build|compile|lint|html|css|javascript|typescript|jsx|tsx|json|yaml|xml|markdown|component|script|create|generate|write|scaffold|init|setup)\b|代码|文件|目录|仓库|项目|补丁|修改|修复|实现|重构|命令|终端|报错|错误|测试|构建|编译|组件|脚本|创建|生成|编写|初始化)/i;

const EDIT_REQUEST_RE =
  /(?:\b(fix|edit|modify|change|patch|implement|refactor|rename|create|write|scaffold|generate|make|build)\b|修复|修改|编辑|改|实现|重构|重命名|创建|生成|编写|搭建)/i;

const SHELL_REQUEST_RE =
  /(?:\b(run|command|shell|terminal|npm|pnpm|yarn|bun|build|test|lint|typecheck|install|start|dev|compile|verify|check)\b|运行|命令|终端|测试|构建|安装|启动|校验|检查)/i;

const GIT_REQUEST_RE =
  /(?:\b(git|commit|branch|diff|merge|rebase|stash|cherry-pick|pull request|pr\b)\b|提交|分支|差异|合并)/i;

const DOCS_REQUEST_RE =
  /(?:\b(doc|docs|documentation|reference|api|library|framework|package|version|readme|manual)\b|文档|资料|参考|接口|库|框架|版本)/i;

const NETWORK_REQUEST_RE =
  /(?:\b(url|http|https|api|endpoint|request|download|fetch|dns|webhook|hostname|curl)\b|网址|链接|下载|请求|接口|域名)/i;

const TEXT_UTILITY_REQUEST_RE =
  /(?:\b(regex|regexp|json|yaml|xml|base64|hash|encode|decode|sort|dedupe|diff text|calculate|uuid)\b|正则|格式化|编码|解码|哈希|排序|去重|计算|uuid)/i;

const ENV_TIME_REQUEST_RE =
  /(?:\b(env|environment|variable|variables|date|time|timestamp|timezone)\b|环境变量|日期|时间|时区)/i;

const MEDIA_REQUEST_RE =
  /(?:\b(image|png|jpg|jpeg|gif|svg|icon|logo|banner|poster|screenshot|video|mp4|animation)\b|图片|图像|截图|视频|图标|标志|海报)/i;

const BROWSER_REQUEST_RE =
  /(?:\b(browser|browse|navigate|click|type|screenshot|extract text|web page|webpage|page automation)\b|浏览器|网页自动化|打开网页|点击|输入到|网页截图|提取网页)/i;

const MUSIC_REQUEST_RE =
  /(?:\b(spotify|music|song|playlist|volume|pause|resume|skip|now playing)\b|音乐|歌曲|播放|暂停|继续播放|下一首|上一首|歌单|音量|正在播放)/i;

const PRODUCTIVITY_REQUEST_RE =
  /(?:\b(calendar|event|meeting|schedule|reminder|todo|to-do|task list)\b|日历|日程|会议|活动|提醒|待办|备忘|完成提醒)/i;

const AMBIENT_INFO_REQUEST_RE =
  /(?:\b(weather|forecast|temperature|rain|snow|currency|exchange rate|fx|flight|timezone|world clock|time difference)\b|天气|气温|温度|下雨|下雪|汇率|货币|航班|飞机|时区|世界时钟|时差)/i;

const SPEECH_REQUEST_RE =
  /(?:\b(tts|speech|voice|audio|transcribe|transcription|dictation|read aloud|synthesize)\b|语音|音频|朗读|合成语音|转写|转录|听写|录音)/i;

const MCP_REQUEST_RE =
  /(?:\b(mcp|model context protocol|server config|tool server)\b|工具服务器|插件服务器|上下文协议)/i;

const BRIDGE_REQUEST_RE =
  /(?:\b(bridge|send image|send video|mobile media|phone image|phone video|wechat|telegram|discord|mp4)\b|桥接|发送图片|发送视频|发视频|手机图片|手机视频|媒体桥|微信|视频)/i;

const EXTERNAL_PROTOCOL_DEBUG_RE =
  /(?:\b(protocol|schema|sdk|api|gateway|webhook|cdn|media[_\s-]?type|message[_\s-]?type|enum|wire format|undocumented|third[-\s]?party|integration|wechat|weixin|telegram|discord)\b|协议|接口|网关|第三方|外部|微信|企业微信|电报|飞书|钉钉|枚举|字段|常量|上传类型|消息类型|不渲染|手机不显示|accepted)/i;

const CODING_FALLBACK_TOOLS = [
  ...EDIT_TOOLS,
  ...SHELL_VERIFY_TOOLS,
  ...GIT_TOOLS,
  ...DOCS_TOOLS,
  ...NETWORK_TOOLS,
  ...TEXT_UTILITY_TOOLS,
  ...ENV_TIME_TOOLS,
] as const;

function getLatestUserInput(messages: SessionMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      return message.content.trim();
    }
  }
  return '';
}

function collectRecentToolNames(messages: SessionMessage[], lookback = 10): string[] {
  const result = new Set<string>();
  let scanned = 0;

  for (let index = messages.length - 1; index >= 0 && scanned < lookback; index -= 1) {
    const message = messages[index];
    if (!message || message.role === 'system') {
      continue;
    }
    scanned += 1;

    if (message.role === 'tool' && message.name && ALL_DIRECT_TOOL_NAME_SET.has(message.name)) {
      result.add(message.name);
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      for (const call of message.toolCalls) {
        if (ALL_DIRECT_TOOL_NAME_SET.has(call.name)) {
          result.add(call.name);
        }
      }
    }
  }

  return [...result];
}

function addTools(target: Set<string>, tools: readonly string[]): void {
  for (const name of tools) {
    if (ALL_DIRECT_TOOL_NAME_SET.has(name)) {
      target.add(name);
    }
  }
}

function addRecentTools(target: Set<string>, recentToolNames: string[]): void {
  for (const name of recentToolNames) {
    if (ALL_DIRECT_TOOL_NAME_SET.has(name)) {
      target.add(name);
    }
  }
}

export function projectDirectToolNames(messages: SessionMessage[]): string[] {
  const latestUserInput = getLatestUserInput(messages);
  if (!latestUserInput) {
    return ALL_DIRECT_TOOL_NAMES;
  }

  const recentToolNames = collectRecentToolNames(messages);
  const selected = new Set<string>();

  addTools(selected, CORE_INSPECT_TOOLS);

  if (CONTINUATION_REQUEST_RE.test(latestUserInput) && recentToolNames.length > 0) {
    addRecentTools(selected, recentToolNames);
  }

  const looksCoding = CODING_REQUEST_RE.test(latestUserInput);
  const wantsEdit = EDIT_REQUEST_RE.test(latestUserInput);
  const wantsShell = SHELL_REQUEST_RE.test(latestUserInput);
  const wantsGit = GIT_REQUEST_RE.test(latestUserInput);
  const wantsDocs = DOCS_REQUEST_RE.test(latestUserInput);
  const wantsNetwork = NETWORK_REQUEST_RE.test(latestUserInput);
  const wantsTextUtility = TEXT_UTILITY_REQUEST_RE.test(latestUserInput);
  const wantsEnvTime = ENV_TIME_REQUEST_RE.test(latestUserInput);
  const wantsMedia = MEDIA_REQUEST_RE.test(latestUserInput);
  const wantsBrowser = BROWSER_REQUEST_RE.test(latestUserInput);
  const wantsMusic = MUSIC_REQUEST_RE.test(latestUserInput);
  const wantsProductivity = PRODUCTIVITY_REQUEST_RE.test(latestUserInput);
  const wantsAmbientInfo = AMBIENT_INFO_REQUEST_RE.test(latestUserInput);
  const wantsSpeech = SPEECH_REQUEST_RE.test(latestUserInput);
  const wantsMcp = MCP_REQUEST_RE.test(latestUserInput);
  const wantsBridge = BRIDGE_REQUEST_RE.test(latestUserInput);
  const wantsFileOperation = FILE_OPERATION_REQUEST_RE.test(latestUserInput);
  const wantsExternalProtocolDebug = EXTERNAL_PROTOCOL_DEBUG_RE.test(latestUserInput) &&
    (looksCoding || wantsNetwork || wantsBridge || wantsDocs);

  if (looksCoding) {
    addTools(selected, EDIT_TOOLS);
    addTools(selected, TEXT_UTILITY_TOOLS);
  }

  if (wantsEdit) {
    addTools(selected, EDIT_TOOLS);
    addTools(selected, SHELL_VERIFY_TOOLS);
  }

  if (wantsShell) {
    addTools(selected, SHELL_VERIFY_TOOLS);
  }

  if (wantsGit) {
    addTools(selected, GIT_TOOLS);
  }

  if (wantsDocs) {
    addTools(selected, DOCS_TOOLS);
  }

  if (wantsNetwork) {
    addTools(selected, NETWORK_TOOLS);
  }

  if (wantsExternalProtocolDebug) {
    addTools(selected, ['search_web', 'http_request', 'lookup_docs']);
  }

  if (wantsTextUtility) {
    addTools(selected, TEXT_UTILITY_TOOLS);
  }

  if (wantsEnvTime) {
    addTools(selected, ENV_TIME_TOOLS);
  }

  if (wantsMedia) {
    addTools(selected, MEDIA_TOOLS);
  }

  if (wantsBrowser) {
    addTools(selected, BROWSER_TOOLS);
  }

  if (wantsMusic) {
    addTools(selected, MUSIC_TOOLS);
  }

  if (wantsProductivity) {
    addTools(selected, PRODUCTIVITY_TOOLS);
  }

  if (wantsAmbientInfo) {
    addTools(selected, AMBIENT_INFO_TOOLS);
  }

  if (wantsSpeech) {
    addTools(selected, SPEECH_TOOLS);
  }

  if (wantsMcp) {
    addTools(selected, MCP_MANAGEMENT_TOOLS);
  }

  if (wantsBridge) {
    addTools(selected, BRIDGE_TOOLS);
  }

  if (wantsFileOperation) {
    addTools(selected, EDIT_TOOLS); // 包含 create_directory
    addTools(selected, SHELL_VERIFY_TOOLS); // 包含 run_command，用于 cd
  }

  // Generic code work nearly always benefits from at least one verification
  // path, but we keep the shell surface compact unless the prompt asks for more.
  if (looksCoding && !wantsShell) {
    addTools(selected, ['run_command', 'git_status']);
  }

  if (!looksCoding && recentToolNames.length > 0) {
    addRecentTools(selected, recentToolNames);
  }

  return ALL_DIRECT_TOOL_NAMES.filter((name) => selected.has(name));
}

export function hasFullDirectToolProjection(toolNames: Iterable<string>): boolean {
  const seen = new Set<string>();
  for (const name of toolNames) {
    if (ALL_DIRECT_TOOL_NAME_SET.has(name)) {
      seen.add(name);
    }
  }
  return seen.size >= ALL_DIRECT_TOOL_NAMES.length;
}

export function widenProjectedDirectToolNames(
  messages: SessionMessage[],
  currentToolNames: Iterable<string>,
  widenAttempt = 0,
): string[] {
  if (widenAttempt > 0) {
    return [...ALL_DIRECT_TOOL_NAMES];
  }

  const widened = new Set<string>();
  addTools(widened, CORE_INSPECT_TOOLS);
  addTools(widened, CODING_FALLBACK_TOOLS);
  addRecentTools(widened, collectRecentToolNames(messages, 16));

  for (const name of currentToolNames) {
    if (ALL_DIRECT_TOOL_NAME_SET.has(name)) {
      widened.add(name);
    }
  }

  const latestUserInput = getLatestUserInput(messages);
  if (MEDIA_REQUEST_RE.test(latestUserInput)) {
    addTools(widened, MEDIA_TOOLS);
  }

  const expanded = ALL_DIRECT_TOOL_NAMES.filter((name) => widened.has(name));
  return expanded.length > 0 ? expanded : [...ALL_DIRECT_TOOL_NAMES];
}
