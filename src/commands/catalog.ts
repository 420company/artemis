/* eslint-disable @typescript-eslint/no-unused-vars */
import { DUAL_MODEL_COMMAND, WHOSYOURDADDY_FLAG } from '../cli/branding.js';
import { pickLocale, type UiLocale } from '../cli/locale.js';
import {
  COMMAND_GROUP_ORDER,
  COMMAND_GROUP_TITLES,
  getCommandDescriptors,
  getCommandUsage,
  type CommandDescriptor,
} from './descriptors.js';

export const CLI_COMMAND_TOKENS = [
  'run',
  'athena',
  'design',
  'niko',
  'contest',
  'nidhogg',
  'docs',
  'search-engine',
  'research-engine',
  'deep-research',
  'sponsor',
  'artemis-md',
  'revise-artemis-md',
  'wordup',
  'wordupnow',
  'bragi',
  'telegram',
  'bifrost',
  DUAL_MODEL_COMMAND,
  'doublekill',
  'resume',
  'ps',
  'logs',
  'wait',
  'attach',
  'kill',
  'evidence',
  'conflicts',
  'verify',
  'tasks',
  'runtimes',
  'heimdall',
  'mcp',
  'odin',
  'providers',
  'skills',
  'plugins',
  'commands',
  'doctor',
  'sessions',
  'version',
  'whosyourdaddy',
] as const;

function formatCommandLine(
  descriptor: CommandDescriptor,
  surface: 'cli' | 'slash' | 'remote',
  locale: UiLocale,
): string | undefined {
  const usage = getCommandUsage(descriptor, surface);
  if (!usage) {
    return undefined;
  }

  const prefix = surface === 'cli' ? 'artemis ' : '';
  const visibleUsage =
    surface === 'cli' && descriptor.id === 'whosyourdaddy'
      ? WHOSYOURDADDY_FLAG
      : `${prefix}${usage}`;
  return `${visibleUsage} - ${pickLocale(locale, descriptor.desc)}`;
}

export function isCliCommandToken(
  value: string | undefined,
): value is (typeof CLI_COMMAND_TOKENS)[number] {
  return (
    value !== undefined &&
    CLI_COMMAND_TOKENS.includes(value as (typeof CLI_COMMAND_TOKENS)[number])
  );
}

export function normalizeCliCommandToken(value: string): string {
  if (value === DUAL_MODEL_COMMAND || value === 'bifrost') {
    return 'doublekill';
  }
  if (value === 'whosyourdaddy') {
    return 'chat';
  }
  return value;
}

export function getCliUsageLines(): string[] {
  return getCommandDescriptors({ surface: 'cli' }).map((descriptor) =>
    descriptor.id === 'whosyourdaddy'
      ? `artemis ${WHOSYOURDADDY_FLAG}`
       : `artemis ${descriptor.cli}`,
  );
}

export function getCliHelpUsageLines(): string[] {
  return getCliUsageLines();
}

export function getSlashHelpLines(locale: UiLocale = 'en'): string[] {
  return getCommandDescriptors({ surface: 'slash' }).map(
    (descriptor) => descriptor.slash as string,
  );
}

export function getSlashAutocompleteEntries(): string[] {
  return getCommandDescriptors({
    surface: 'slash',
    autocompleteOnly: true,
  }).map((descriptor) => (descriptor.slash as string).split(' ')[0]);
}

export function getQuickCommandChoices(locale: UiLocale): Array<{
  label: string;
  value: string;
  description: string;
}> {
  return getCommandDescriptors({ surface: 'slash', quickOnly: true }).map(
    (descriptor) => ({
      label: descriptor.slash as string,
      value: descriptor.quickValue as string,
      description: pickLocale(locale, descriptor.desc),
    }),
  );
}

export function buildQuickMenuOptions(locale: UiLocale): Array<{
  label: string;
  value: string;
  description: string;
}> {
  return getQuickCommandChoices(locale);
}

export function getInteractiveHelpCommands(locale: UiLocale = 'en'): string[] {
  return getSlashHelpLines(locale);
}

export function getSlashAutocompleteCommands(): string[] {
  return getSlashAutocompleteEntries();
}

export function buildRemoteCommandHelpSections(locale: UiLocale): Array<{
  title: string;
  lines: string[];
}> {
  return COMMAND_GROUP_ORDER.map((group) => ({
    title: pickLocale(locale, COMMAND_GROUP_TITLES[group]),
    lines: getCommandDescriptors({ surface: 'remote' })
      .filter((descriptor) => descriptor.group === group)
      .map((descriptor) => formatCommandLine(descriptor, 'remote', locale))
      .filter((line): line is string => Boolean(line)),
  })).filter((section) => section.lines.length > 0);
}

export function buildCommandSurfaceReport(
  locale: UiLocale,
  surface: 'cli' | 'slash' | 'remote' | 'all' = 'all',
  query?: string,
): string {
  const activeSurfaces =
    surface === 'all' ? (['cli', 'slash', 'remote'] as const) : [surface];
  const lines: string[] = [];

  for (const activeSurface of activeSurfaces) {
    lines.push(
      pickLocale(locale, {
        zh:
          activeSurface === 'cli'
            ? 'CLI 命令'
            : activeSurface === 'slash'
              ? 'Slash 命令'
              : '远程命令',
        en:
          activeSurface === 'cli'
            ? 'CLI commands'
            : activeSurface === 'slash'
              ? 'Slash commands'
              : 'Remote commands',
      }),
    );

    for (const group of COMMAND_GROUP_ORDER) {
      const groupLines = getCommandDescriptors({
        surface: activeSurface,
        query,
      })
        .filter((descriptor) => descriptor.group === group)
        .map((descriptor) => formatCommandLine(descriptor, activeSurface, locale))
        .filter((line): line is string => Boolean(line));

      if (groupLines.length === 0) {
        continue;
      }

      lines.push(`${pickLocale(locale, COMMAND_GROUP_TITLES[group])}:`);
      lines.push(...groupLines.map((line) => `- ${line}`));
    }

    if (activeSurface !== activeSurfaces[activeSurfaces.length - 1]) {
      lines.push('');
    }
  }

  if (query?.trim() && !lines.some((line) => line.startsWith('- '))) {
    return `No commands match "${query.trim()}".`;
  }

  return lines.join('\n');
}

export function buildCommandCatalogReport(
  locale: UiLocale,
  options?: {
    query?: string;
    surface?: 'cli' | 'slash' | 'remote' | 'all';
  },
): string {
  return buildCommandSurfaceReport(
    locale,
    options?.surface ?? 'all',
    options?.query,
  );
}
