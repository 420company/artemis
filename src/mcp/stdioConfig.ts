function tokenizeShellLike(input: string): string[] {
  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((entry) => entry.replace(/^['"]|['"]$/g, ''));
}

function quoteShellToken(value: string): string {
  if (!value || /[\s"]/u.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

export function normalizeStdioCommandParts(options: {
  command?: string;
  args?: string[];
}): {
  command?: string;
  args?: string[];
} {
  const rawCommand = options.command?.trim();
  const rawArgs = (options.args ?? []).map((entry) => entry.trim()).filter(Boolean);

  if (!rawCommand) {
    return {};
  }

  if (rawArgs.length > 0) {
    return {
      command: rawCommand,
      args: rawArgs,
    };
  }

  const tokens = tokenizeShellLike(rawCommand);
  if (tokens.length === 0) {
    return {};
  }

  return {
    command: tokens[0],
    args: tokens.slice(1),
  };
}

export function formatStdioCommandTarget(options: {
  command?: string;
  args?: string[];
}): string {
  const normalized = normalizeStdioCommandParts(options);
  if (!normalized.command) {
    return '<missing>';
  }

  return [normalized.command, ...(normalized.args ?? []).map(quoteShellToken)]
    .filter(Boolean)
    .join(' ');
}
