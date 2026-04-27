/**
 * security/commandPolicy.ts — read-only shell command classification
 *
 * Used by the permission system to automatically allow read-only commands
 * without prompting the user, even in 'prompt' permission mode.
 *
 * Command policy helpers for the local shell runtime.
 */

const DANGEROUS_SHELL_CHARS = /&&|\|\||;|>>?|<|`|\$\(|\r|\n|&/

const SAFE_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more',
  'ls', 'dir', 'tree',
  'echo', 'printf',
  'pwd', 
  'grep', 'rg', 'ag', 'ack',
  'awk',
  'sort', 'uniq', 'wc', 'cut', 'tr',
  'jq', 'yq',
  'which', 'where', 'whereis', 'type',
  'whoami', 'id', 'hostname',
  'date', 'uname',
  'env', 'printenv',
  'file',
  'stat',
  'diff', 'diff3', // only read commands
  'md5', 'md5sum', 'sha256sum',
])

const GIT_SIMPLE_READ_SUBCOMMANDS = new Set([
  'blame', 'diff', 'diff-tree', 'grep', 'log',
  'ls-files', 'ls-tree', 'rev-parse', 'show',
  'shortlog', 'status', 'describe',
])

function tokenize(segment: string): string[] {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
}

function stripQuotes(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) return token.slice(1, -1)
  return token
}

function optionName(token: string): string {
  const stripped = stripQuotes(token).toLowerCase()
  const equalsIndex = stripped.indexOf('=')
  return equalsIndex >= 0 ? stripped.slice(0, equalsIndex) : stripped
}

function optionHasInlineValue(token: string): boolean {
  return stripQuotes(token).includes('=')
}

function isReadOnlyEnvCommand(tokens: string[]): boolean {
  // `env` alone prints the current environment; `env NAME=value cmd` executes cmd.
  return tokens.length === 1
}

function isReadOnlyAwkCommand(tokens: string[]): boolean {
  const strippedTokens = tokens.map(stripQuotes)
  if (
    strippedTokens.some((token) => {
      const normalized = token.toLowerCase()
      return normalized === '-i' ||
        normalized.startsWith('-i') ||
        normalized === '--in-place' ||
        normalized.startsWith('--in-place=')
    })
  ) {
    return false
  }

  return !/\bsystem\s*\(/i.test(strippedTokens.join(' '))
}

function isReadOnlySortCommand(tokens: string[]): boolean {
  return !tokens.some((token) => {
    const normalized = optionName(token)
    return normalized === '-o' ||
      normalized.startsWith('-o') ||
      normalized === '--output'
  })
}

const GIT_TOP_LEVEL_OPTIONS_WITH_VALUE = new Set([
  '-c', '--git-dir', '--work-tree', '--namespace',
])

const GIT_TOP_LEVEL_OPTIONS_WITH_INLINE_VALUE = new Set([
  '--git-dir', '--work-tree', '--namespace',
])

const GIT_CONFIG_WRITE_OPTIONS = new Set([
  '--add', '--replace-all', '--unset', '--unset-all', '--rename-section',
  '--remove-section', '--edit', '-e', '--set', '--set-all',
])

const GIT_CONFIG_READ_OPTIONS = new Set([
  '--get', '--get-all', '--get-regexp', '--get-urlmatch',
  '--get-color', '--get-colorbool', '--list', '-l',
])

const GIT_CONFIG_OPTIONS_WITH_VALUE = new Set([
  '--get', '--get-all', '--get-regexp', '--get-urlmatch',
  '--get-color', '--get-colorbool', '--file', '-f', '--blob',
  '--type', '--default',
])

const GIT_CONFIG_PASSIVE_OPTIONS = new Set([
  '--global', '--system', '--local', '--worktree', '--file', '-f', '--blob',
  '--name-only', '--show-origin', '--show-scope', '--null', '-z',
  '--includes', '--no-includes', '--fixed-value', '--type', '--default',
  '--bool', '--int', '--bool-or-int', '--path', '--expiry-date',
])

const GIT_BRANCH_WRITE_OPTIONS = new Set([
  '-d', '-m', '-c', '--delete', '--move', '--copy',
  '--set-upstream-to', '--unset-upstream', '--edit-description',
  '--track', '--no-track',
])

const GIT_TAG_WRITE_OPTIONS = new Set([
  '-a', '-s', '-u', '-m', '-f', '-d', '--annotate', '--sign',
  '--local-user', '--message', '--file', '--delete',
  '--force',
])

function hasGitOutputWriteOption(args: string[]): boolean {
  return args.some((arg) => {
    const normalized = optionName(arg)
    return normalized === '-o' ||
      normalized.startsWith('-o') ||
      normalized === '--output'
  })
}

function hasWriteOption(args: string[], writeOptions: Set<string>): boolean {
  return args.some((arg) => writeOptions.has(optionName(arg)))
}

function isReadOnlyGitConfigCommand(args: string[]): boolean {
  let explicitRead = false
  let positionalCount = 0

  for (let i = 0; i < args.length; i++) {
    const arg = stripQuotes(args[i] ?? '')
    const normalized = optionName(arg)

    if (!arg.startsWith('-')) {
      positionalCount += 1
      continue
    }

    if (GIT_CONFIG_WRITE_OPTIONS.has(normalized)) {
      return false
    }

    if (GIT_CONFIG_READ_OPTIONS.has(normalized)) {
      explicitRead = true
    } else if (!GIT_CONFIG_PASSIVE_OPTIONS.has(normalized)) {
      return false
    }

    if (GIT_CONFIG_OPTIONS_WITH_VALUE.has(normalized) && !optionHasInlineValue(arg)) {
      if (i + 1 >= args.length) return false
      i += 1
    }
  }

  return explicitRead || positionalCount <= 1
}

function isReadOnlyGitBranchCommand(args: string[]): boolean {
  if (hasWriteOption(args, GIT_BRANCH_WRITE_OPTIONS)) {
    return false
  }

  return args.every((arg) => stripQuotes(arg).startsWith('-'))
}

function isReadOnlyGitRemoteCommand(args: string[]): boolean {
  if (args.length === 0) return true
  if (args.every((arg) => ['-v', '--verbose'].includes(optionName(arg)))) return true

  const subcommand = stripQuotes(args[0] ?? '').toLowerCase()
  return subcommand === 'show' || subcommand === 'get-url'
}

function isReadOnlyGitStashCommand(args: string[]): boolean {
  const subcommand = stripQuotes(args[0] ?? '').toLowerCase()
  return subcommand === 'list' || subcommand === 'show'
}

function isReadOnlyGitTagCommand(args: string[]): boolean {
  if (hasWriteOption(args, GIT_TAG_WRITE_OPTIONS)) {
    return false
  }

  return args.every((arg) => stripQuotes(arg).startsWith('-'))
}

function isReadOnlyGitCommand(tokens: string[]): boolean {
  let i = 1
  while (i < tokens.length) {
    const t = stripQuotes(tokens[i] ?? '')
    if (!t.startsWith('-')) break
    // These flags take a value argument
    const normalized = optionName(t)
    if (GIT_TOP_LEVEL_OPTIONS_WITH_VALUE.has(normalized)) {
      if (
        GIT_TOP_LEVEL_OPTIONS_WITH_INLINE_VALUE.has(normalized) &&
        optionHasInlineValue(t)
      ) {
        i += 1
        continue
      }
      if (i + 1 >= tokens.length) return false
      i += 2
      continue
    }
    i++
  }
  const sub = stripQuotes(tokens[i] ?? '').toLowerCase()
  const args = tokens.slice(i + 1).map(stripQuotes)

  if (sub === 'config') return isReadOnlyGitConfigCommand(args)
  if (sub === 'branch') return isReadOnlyGitBranchCommand(args)
  if (sub === 'remote') return isReadOnlyGitRemoteCommand(args)
  if (sub === 'stash') return isReadOnlyGitStashCommand(args)
  if (sub === 'tag') return isReadOnlyGitTagCommand(args)
  if (!GIT_SIMPLE_READ_SUBCOMMANDS.has(sub)) return false
  if (hasGitOutputWriteOption(args)) return false
  return true
}

function isReadOnlySegment(segment: string): boolean {
  const tokens = tokenize(segment)
  if (tokens.length === 0) return false
  const cmd = stripQuotes(tokens[0] ?? '').toLowerCase()
  if (cmd === 'env') return isReadOnlyEnvCommand(tokens)
  if (cmd === 'awk') return isReadOnlyAwkCommand(tokens)
  if (cmd === 'sort') return isReadOnlySortCommand(tokens)
  if (SAFE_COMMANDS.has(cmd)) return true
  if (cmd === 'git') return isReadOnlyGitCommand(tokens)
  return false
}

/**
 * Returns true if the command is read-only and can be allowed without prompting.
 * Conservative — returns false on any shell metacharacter that could chain writes.
 */
export function isReadOnlyCommand(command: string): boolean {
  const normalized = command.trim()
  if (!normalized) return false
  if (DANGEROUS_SHELL_CHARS.test(normalized)) return false
  const segments = normalized.split('|').map(s => s.trim()).filter(Boolean)
  if (segments.length === 0) return false
  return segments.every(isReadOnlySegment)
}
