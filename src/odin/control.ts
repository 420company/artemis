import path from 'node:path';
import { pickLocale, type UiLocale } from '../cli/locale.js';
import { buildPanel } from '../cli/ui.js';
import { resolveDataRootDir } from '../utils/fs.js';
import { OdinStore } from './store.js';

type OdinCommandAction = 'status' | 'skills' | 'search' | 'events';

export function parseOdinCommandBody(input: string | undefined): {
  action: OdinCommandAction;
  query?: string;
} {
  const trimmed = (input ?? '').trim();
  if (!trimmed) {
    return { action: 'status' };
  }

  if (trimmed === 'skills') {
    return { action: 'skills' };
  }
  if (trimmed === 'events') {
    return { action: 'events' };
  }
  if (trimmed.startsWith('search ')) {
    const query = trimmed.slice('search '.length).trim();
    return {
      action: 'search',
      query: query || undefined,
    };
  }

  return {
    action: 'search',
    query: trimmed,
  };
}

function formatSkillLine(skill: Awaited<ReturnType<OdinStore['load']>>['skills'][number]): string {
  return `${skill.name} [${skill.status}/${skill.source}] conf=${skill.confidence} rev=${skill.lineage?.revision ?? 0}`;
}

export async function buildOdinDoctorLines(options: {
  cwd: string;
  locale: UiLocale;
}): Promise<string[]> {
  const store = new OdinStore(options.cwd);
  const data = await store.load();
  const localCount = data.skills.filter((skill) => skill.scope === 'local').length;
  const cloudCount = data.skills.filter((skill) => skill.scope === 'cloud').length;
  return [
    `file: ${path.join(resolveDataRootDir(options.cwd), 'odin.json')}`,
    `${pickLocale(options.locale, { zh: '技能数', en: 'skills' })}: ${data.skills.length}`,
    `${pickLocale(options.locale, { zh: '本地技能', en: 'local skills' })}: ${localCount}`,
    `${pickLocale(options.locale, { zh: '云端技能', en: 'cloud skills' })}: ${cloudCount}`,
    `${pickLocale(options.locale, { zh: '搜索记录', en: 'search records' })}: ${data.searchRecords.length}`,
    `${pickLocale(options.locale, { zh: '进化事件', en: 'evolution events' })}: ${data.evolutionEvents.length}`,
  ];
}

export async function buildOdinReport(options: {
  cwd: string;
  locale: UiLocale;
  action?: OdinCommandAction;
  query?: string;
}): Promise<string> {
  const store = new OdinStore(options.cwd);
  const data = await store.load();
  const filePath = path.join(resolveDataRootDir(options.cwd), 'odin.json');
  const action = options.action ?? 'status';

  if (action === 'skills') {
    const skills = store.listSkills(data);
    return buildPanel(
      pickLocale(options.locale, {
        zh: 'Odin 技能库',
        en: 'Odin Skill Registry',
      }),
      skills.length > 0
        ? [
            `file: ${filePath}`,
            ...skills.slice(0, 12).map(formatSkillLine),
          ]
        : [
            `file: ${filePath}`,
            pickLocale(options.locale, {
              zh: '当前还没有保存任何 Odin 技能。',
              en: 'No Odin skills have been saved yet.',
            }),
          ],
    );
  }

  if (action === 'events') {
    const events = [...data.evolutionEvents]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 12);
    return buildPanel(
      pickLocale(options.locale, {
        zh: 'Odin 进化事件',
        en: 'Odin Evolution Events',
      }),
      events.length > 0
        ? [
            `file: ${filePath}`,
            ...events.map(
              (event) =>
                `${event.kind}/${event.outcome} :: ${event.summary} :: ${event.skillIds.join(',') || 'no-skills'}`,
            ),
          ]
        : [
            `file: ${filePath}`,
            pickLocale(options.locale, {
              zh: '当前还没有记录任何 Odin 进化事件。',
              en: 'No Odin evolution events have been recorded yet.',
            }),
          ],
    );
  }

  if (action === 'search') {
    if (!options.query) {
      return buildPanel(
        pickLocale(options.locale, {
          zh: 'Odin 搜索',
          en: 'Odin Search',
        }),
        [
          `file: ${filePath}`,
          pickLocale(options.locale, {
            zh: '用法：odin search <query>',
            en: 'Usage: odin search <query>',
          }),
        ],
      );
    }

    const result = await store.searchSkills({
      query: options.query,
      scope: 'all',
      limit: 8,
    });
    return buildPanel(
      pickLocale(options.locale, {
        zh: 'Odin 搜索',
        en: 'Odin Search',
      }),
      result.hits.length > 0
        ? [
            `file: ${filePath}`,
            `${pickLocale(options.locale, { zh: '查询', en: 'Query' })}: ${result.query}`,
            ...result.hits.map(
              (hit) =>
                `${hit.skillId} :: score=${hit.score} :: ${hit.reasons.join(', ')}`,
            ),
          ]
        : [
            `file: ${filePath}`,
            `${pickLocale(options.locale, { zh: '查询', en: 'Query' })}: ${result.query}`,
            pickLocale(options.locale, {
              zh: '没有找到匹配技能。',
              en: 'No matching skills found.',
            }),
          ],
    );
  }

  const localCount = data.skills.filter((skill) => skill.scope === 'local').length;
  const cloudCount = data.skills.filter((skill) => skill.scope === 'cloud').length;
  const recentSkills = store.listSkills(data).slice(0, 5);

  return buildPanel(
    pickLocale(options.locale, {
      zh: 'Odin 技能进化引擎',
      en: 'Odin Skill Evolution Engine',
    }),
    [
      pickLocale(options.locale, {
        zh: 'Odin 是 Artemis 的本地优先技能进化层，用来记录、检索和演化高价值工作模式。',
        en: 'Odin is Artemis’s local-first skill evolution layer for recording, searching, and evolving high-value work patterns.',
      }),
      `file: ${filePath}`,
      `${pickLocale(options.locale, { zh: '技能总数', en: 'Total skills' })}: ${data.skills.length}`,
      `${pickLocale(options.locale, { zh: '本地技能', en: 'Local skills' })}: ${localCount}`,
      `${pickLocale(options.locale, { zh: '云端技能', en: 'Cloud skills' })}: ${cloudCount}`,
      `${pickLocale(options.locale, { zh: '搜索记录', en: 'Search records' })}: ${data.searchRecords.length}`,
      `${pickLocale(options.locale, { zh: '进化事件', en: 'Evolution events' })}: ${data.evolutionEvents.length}`,
      ...(recentSkills.length > 0
        ? [
            '',
            pickLocale(options.locale, {
              zh: '最近技能',
              en: 'Recent skills',
            }),
            ...recentSkills.map(formatSkillLine),
          ]
        : []),
      '',
      pickLocale(options.locale, {
        zh: '入口示例：artemis odin · artemis odin skills · artemis odin search docker monitor · /odin',
        en: 'Entry points: artemis odin · artemis odin skills · artemis odin search docker monitor · /odin',
      }),
    ],
  );
}
