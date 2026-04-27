import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathExists, resolveDataRootDir, truncate } from '../utils/fs.js';
import { pickLocale, type UiLocale } from '../cli/locale.js';
import { SkillAdapterManager } from '../core/externalSkillAdapter.js';

export type SkillSource = 'workspace' | 'data-root';
export type SkillStatus = 'ready' | 'invalid';

export type DiscoveredSkill = {
  id: string;
  name: string;
  title: string;
  description?: string;
  source: SkillSource;
  dirPath: string;
  skillPath?: string;
  status: SkillStatus;
  issues: string[];
};

export type SkillDiscoveryResult = {
  roots: Array<{ source: SkillSource; path: string; exists: boolean }>;
  skills: DiscoveredSkill[];
};

function normalizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function deriveTitleFromMarkdown(content: string, fallback: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || fallback;
}

function deriveDescriptionFromMarkdown(content: string): string | undefined {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'));
  const firstBodyLine = lines[0];
  return firstBodyLine ? truncate(firstBodyLine, 160) : undefined;
}

async function loadSkillFromDirectory(options: {
  root: string;
  name: string;
  source: SkillSource;
}): Promise<DiscoveredSkill> {
  const dirPath = path.join(options.root, options.name);
  const skillMdPath = path.join(dirPath, 'SKILL.md');
  const skillJsonPath = path.join(dirPath, 'SKILL.json');
  const issues: string[] = [];

  // 检查是否是外部技能格式（Claude Code 或 OpenClaw）
  const adapterManager = new SkillAdapterManager();
  try {
    const adapter = await adapterManager.findAdapterForDirectory(dirPath);
    if (adapter) {
      const externalSkill = await adapter.discoverSkills(dirPath);
      if (externalSkill.length > 0) {
        const skill = externalSkill[0];
        return {
          id: skill.id,
          name: skill.name,
          title: skill.title,
          description: skill.description,
          source: options.source,
          dirPath,
          skillPath: skill.skillPath,
          status: 'ready',
          issues: []
        };
      }
    }
  } catch (error) {
    console.warn(`Failed to load external skill from ${dirPath}: ${(error as Error).message}`);
  }

  if (await pathExists(skillMdPath)) {
    const content = (await readFile(skillMdPath, 'utf8')).trim();
    if (!content) {
      issues.push('SKILL.md is empty.');
    }

    return {
      id: normalizeId(options.name),
      name: options.name,
      title: deriveTitleFromMarkdown(content, options.name),
      description: deriveDescriptionFromMarkdown(content),
      source: options.source,
      dirPath,
      skillPath: skillMdPath,
      status: issues.length === 0 ? 'ready' : 'invalid',
      issues,
    };
  } else if (await pathExists(skillJsonPath)) {
    try {
      const content = JSON.parse(await readFile(skillJsonPath, 'utf8'));
      
      return {
        id: normalizeId(content.id || options.name),
        name: content.name || options.name,
        title: content.name || options.name,
        description: content.description,
        source: options.source,
        dirPath,
        skillPath: skillJsonPath,
        status: 'ready',
        issues,
      };
    } catch (error) {
      issues.push(`Invalid SKILL.json: ${(error as Error).message}`);
      return {
        id: normalizeId(options.name),
        name: options.name,
        title: options.name,
        source: options.source,
        dirPath,
        skillPath: skillJsonPath,
        status: 'invalid',
        issues,
      };
    }
  } else {
    issues.push('Missing SKILL.md or SKILL.json.');
    return {
      id: normalizeId(options.name),
      name: options.name,
      title: options.name,
      source: options.source,
      dirPath,
      status: 'invalid',
      issues,
    };
  }
}

async function loadSkillFromJsonFile(options: {
  root: string;
  fileName: string;
  source: SkillSource;
}): Promise<DiscoveredSkill> {
  const skillPath = path.join(options.root, options.fileName);
  const issues: string[] = [];

  try {
    const content = JSON.parse(await readFile(skillPath, 'utf8'));
    const skillName = path.basename(options.fileName, '.json');
    
    return {
      id: normalizeId(content.id || skillName),
      name: content.name || skillName,
      title: content.name || skillName,
      description: content.description,
      source: options.source,
      dirPath: options.root,
      skillPath,
      status: 'ready',
      issues,
    };
  } catch (error) {
    issues.push(`Invalid JSON: ${(error as Error).message}`);
    return {
      id: normalizeId(path.basename(options.fileName, '.json')),
      name: path.basename(options.fileName, '.json'),
      title: path.basename(options.fileName, '.json'),
      source: options.source,
      dirPath: options.root,
      skillPath,
      status: 'invalid',
      issues,
    };
  }
}

export async function discoverSkills(
  cwd: string,
): Promise<SkillDiscoveryResult> {
  const roots = [
    {
      source: 'workspace' as const,
      path: path.join(cwd, 'skills'),
    },
    {
      source: 'data-root' as const,
      path: path.join(resolveDataRootDir(cwd), 'skills'),
    },
  ];

  const discovered: DiscoveredSkill[] = [];

  for (const root of roots) {
    if (!(await pathExists(root.path))) {
      continue;
    }

    const entries = await readdir(root.path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        discovered.push(
          await loadSkillFromDirectory({
            root: root.path,
            name: entry.name,
            source: root.source,
          }),
        );
      } else if (entry.name.endsWith('.json') && entry.name !== 'registry.json') {
        discovered.push(
          await loadSkillFromJsonFile({
            root: root.path,
            fileName: entry.name,
            source: root.source,
          }),
        );
      }
    }
  }

  const duplicates = new Map<string, number>();
  for (const skill of discovered) {
    duplicates.set(skill.id, (duplicates.get(skill.id) ?? 0) + 1);
  }

  const skills = discovered
    .map((skill) =>
      (duplicates.get(skill.id) ?? 0) > 1
        ? {
            ...skill,
            status: 'invalid' as const,
            issues: [...skill.issues, 'Duplicate skill id detected.'],
          }
        : skill
    )
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    roots: await Promise.all(
      roots.map(async (root) => ({
        ...root,
        exists: await pathExists(root.path),
      })),
    ),
    skills,
  };
}

function buildSkillLine(skill: DiscoveredSkill): string {
  return [
    `- ${skill.id}`,
    `[${skill.source} ${skill.status}]`,
    `title=${truncate(skill.title, 80)}`,
    skill.description ? `desc=${truncate(skill.description, 100)}` : '',
    `path=${skill.dirPath}`,
    skill.issues.length > 0
      ? `issues=${truncate(skill.issues.join(' '), 120)}`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function buildSkillsReport(
  result: SkillDiscoveryResult,
  locale: UiLocale = 'en',
): string {
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en });
  const ready = result.skills.filter((skill) => skill.status === 'ready').length;
  const invalid = result.skills.length - ready;
  const lines = [
    `${t('技能总数', 'Total skills')}: ${result.skills.length}`,
    `${t('可用', 'Ready')}: ${ready}`,
    `${t('无效', 'Invalid')}: ${invalid}`,
    '',
    ...result.roots.map(
      (root) =>
        `${t(root.source === 'workspace' ? '工作区目录' : '数据目录', root.source === 'workspace' ? 'Workspace root' : 'Data-root')}: ${root.path} (${root.exists ? t('存在', 'present') : t('缺失', 'missing')})`,
    ),
  ];

  if (result.skills.length === 0) {
    lines.push('');
    lines.push(t('当前没有发现本地 skills。', 'No local skills discovered.'));
    return lines.join('\n');
  }

  lines.push('');
  lines.push(...result.skills.map(buildSkillLine));
  return lines.join('\n');
}
