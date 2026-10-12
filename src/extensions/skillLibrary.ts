/**
 * extensions/skillLibrary.ts — the skill library as the agent sees it.
 *
 * The library is every installed playbook (a folder with SKILL.md and/or
 * SKILL.json): the ones that ship with Artemis (`skills/`), the groups of
 * optional packs the owner enabled (`skill-packs/<pack>/<audience>/`), and
 * the workspace's and data root's own `skills/` folders (which win on a
 * clash of ids). Learned skills (storage/skillStore.ts) are separate.
 *
 * Each run's context gets a short index (renderSkillLibraryIndex): the
 * skills that fit the request, as "id: one line", within a character
 * budget, and how big the library is. load_skill reads one in full, or
 * searches the library. `$skill-id` in a message still activates one
 * directly (extensions/runtime.ts), packs included, as the owner's choice.
 *
 * Packs are off by default. ARTEMIS_SKILL_PACKS (comma-separated, e.g.
 * "cco" or "cco/traders,cco/creators") or `artemis skills packs enable`
 * (skill-packs.json in the Artemis home) turns groups on.
 */

import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveArtemisHomeDir, resolveDataRootDir } from '../utils/fs.js';

export type LibrarySource = 'bundled' | 'pack' | 'workspace' | 'data-root';

export interface LibrarySkill {
  id: string;
  name: string;
  /** The full description (SKILL.json, else SKILL.md front matter or first line). */
  description: string;
  /** Its first sentence, at most SUMMARY_MAX_CHARS: what the index shows. */
  summary: string;
  category?: string;
  tags: string[];
  source: LibrarySource;
  /** Pack skills: "cco/traders". */
  pack?: string;
  dirPath: string;
  /** The library folder it was found in (its skill folder must stay inside it). */
  root: string;
  /** SKILL.md when there is one (the instructions), else SKILL.json. */
  skillPath?: string;
  /** Whether it is in the index and search (packs: only the enabled groups). */
  enabled: boolean;
}

export interface PackAudience {
  id: string;
  title: { zh: string; en: string };
  count: number;
  enabled: boolean;
}

export interface PackInfo {
  id: string;
  title: { zh: string; en: string };
  description: { zh: string; en: string };
  audiences: PackAudience[];
}

export interface SkillLibrary {
  skills: LibrarySkill[];
  packs: PackInfo[];
}

/** Longest skill id (an id is an index line's handle and a `$id` token). */
export const MAX_SKILL_ID_CHARS = 64;
/** The index's share of the per-run context. */
export const SKILL_LIBRARY_INDEX_MAX_CHARS = 1_400;
/** Skills the index names at most. */
export const SKILL_LIBRARY_INDEX_MAX_ENTRIES = 8;
const SUMMARY_MAX_CHARS = 110;
/** What load_skill returns of one SKILL.md. */
export const LIBRARY_SKILL_MAX_CHARS = 16_000;
/** What load_skill returns of one reference file. */
export const LIBRARY_FILE_MAX_CHARS = 20_000;
const LIBRARY_FILE_MAX_BYTES = 256 * 1024;
const READABLE_FILE = /\.(?:md|markdown|txt|json|ya?ml|toml|csv|tsv|py|js|mjs|cjs|ts|sh|sql|html?|css|xml)$/i;

// ── roots ───────────────────────────────────────────────────────────────────

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The skills that ship with Artemis, when installed. */
export function bundledSkillsDir(): string | undefined {
  const dir = process.env.ARTEMIS_BUNDLED_SKILLS_DIR?.trim() || path.join(PACKAGE_ROOT, 'skills');
  return existsSync(dir) ? dir : undefined;
}

/** The optional packs that ship with Artemis, when installed. */
export function skillPacksDir(): string | undefined {
  const dir = process.env.ARTEMIS_SKILL_PACKS_DIR?.trim() || path.join(PACKAGE_ROOT, 'skill-packs');
  return existsSync(dir) ? dir : undefined;
}

function packSettingsFile(): string {
  return path.join(resolveArtemisHomeDir(), 'skill-packs.json');
}

/** "cco" or "cco/traders" entries from the environment and skill-packs.json. */
export async function enabledPackGroups(env: NodeJS.ProcessEnv = process.env): Promise<Set<string>> {
  const groups = new Set<string>();
  const add = (value: unknown) => {
    const entry = String(value ?? '').trim().toLowerCase().replace(/:/g, '/');
    if (/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/.test(entry)) groups.add(entry);
  };
  for (const entry of (env.ARTEMIS_SKILL_PACKS ?? '').split(',')) add(entry);
  try {
    const saved = JSON.parse(await readFile(packSettingsFile(), 'utf8')) as { enabled?: unknown };
    if (Array.isArray(saved.enabled)) saved.enabled.forEach(add);
  } catch {
    // No saved choice.
  }
  return groups;
}

/** Turns a pack or one of its groups on or off in skill-packs.json; returns what is enabled after. */
export async function setPackGroup(entry: string, enabled: boolean): Promise<string[]> {
  const key = entry.trim().toLowerCase().replace(/:/g, '/');
  if (!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/.test(key)) throw new Error(`"${entry}" is not a pack or pack/group name`);
  let saved: string[] = [];
  try {
    const parsed = JSON.parse(await readFile(packSettingsFile(), 'utf8')) as { enabled?: unknown };
    if (Array.isArray(parsed.enabled)) saved = parsed.enabled.map(String);
  } catch {
    // Nothing saved yet.
  }
  const next = new Set(saved);
  if (enabled) next.add(key);
  else {
    next.delete(key);
    // Turning a whole pack off turns its groups off too.
    if (!key.includes('/')) for (const item of [...next]) if (item.startsWith(`${key}/`)) next.delete(item);
  }
  await mkdir(path.dirname(packSettingsFile()), { recursive: true });
  await writeFile(packSettingsFile(), `${JSON.stringify({ enabled: [...next].sort() }, null, 2)}\n`, { mode: 0o600 });
  return [...next].sort();
}

// ── reading skills ──────────────────────────────────────────────────────────

function normalizeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** A YAML block indicator (`>`, `|-`…) instead of a value: the value is the indented lines after it. */
const BLOCK_INDICATOR = /^[>|][+-]?$/;

/** The YAML-ish front matter's `key: value` (quotes dropped; folded and literal blocks joined). */
function frontMatterValue(markdown: string, key: string): string | undefined {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1];
  if (!head) return undefined;
  const lines = head.split(/\r?\n/);
  const at = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (at < 0) return undefined;
  let value = lines[at]!.slice(key.length + 1).trim();
  if (BLOCK_INDICATOR.test(value) || !value) {
    const block: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (line.trim() && !/^\s/.test(line)) break;
      block.push(line.trim());
    }
    value = block.join(' ');
  }
  value = value.replace(/^(['"])(.*)\1$/, '$2').trim();
  return value || undefined;
}

/** The markdown without front matter. */
export function stripFrontMatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function firstBodyLine(markdown: string): string | undefined {
  return stripFrontMatter(markdown)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.startsWith('```') && !line.startsWith('<'));
}

function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The first sentence, clamped: what an index line shows. */
export function summarize(description: string, max = SUMMARY_MAX_CHARS): string {
  const flat = oneLine(description);
  const sentence = /^(.{20,}?[.!?。！？])(?:\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

async function readSkillDir(root: string, dirPath: string, source: LibrarySource, pack?: string): Promise<LibrarySkill | undefined> {
  const mdPath = path.join(dirPath, 'SKILL.md');
  const jsonPath = path.join(dirPath, 'SKILL.json');
  const json = await readFile(jsonPath, 'utf8').catch(() => undefined);
  let meta: Record<string, unknown> = {};
  if (json !== undefined) {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      // A broken SKILL.json: SKILL.md alone still describes it.
    }
  }
  const usable = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && !BLOCK_INDICATOR.test(value.trim());
  // SKILL.md is read only when SKILL.json does not describe the skill (one file per skill, not two).
  const md = usable(meta.description) && usable(meta.name) ? undefined : await readFile(mdPath, 'utf8').catch(() => undefined);
  const hasMd = md !== undefined || existsSync(mdPath);
  if (!hasMd && json === undefined) return undefined;
  const base = path.basename(dirPath);
  const id = normalizeId(typeof meta.id === 'string' && meta.id ? meta.id : base);
  if (!id || id.length > MAX_SKILL_ID_CHARS) return undefined;
  const name = oneLine(usable(meta.name) ? meta.name : (md && frontMatterValue(md, 'name')) || base);
  const description = oneLine(
    (usable(meta.description) && meta.description)
      || (md && (frontMatterValue(md, 'description') || firstBodyLine(md)))
      || '',
  );
  const tags = Array.isArray(meta.tags) ? meta.tags.map((tag) => String(tag)).filter(Boolean).slice(0, 12) : [];
  return {
    id,
    name,
    description,
    summary: summarize(description || name),
    ...(typeof meta.category === 'string' && meta.category ? { category: meta.category.toLowerCase() } : {}),
    tags,
    source,
    ...(pack ? { pack } : {}),
    dirPath,
    root,
    skillPath: hasMd ? mdPath : jsonPath,
    enabled: source !== 'pack',
  };
}

async function readSkillsRoot(root: string, source: LibrarySource, pack?: string): Promise<LibrarySkill[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  // Real folders only: a symlinked skill folder is not followed.
  const found = await Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => readSkillDir(root, path.join(root, entry.name), source, pack)));
  return found.filter((skill): skill is LibrarySkill => Boolean(skill));
}

/** Installed folders do not change while the engine runs: read once per root and modification time. */
const rootCache = new Map<string, { mtimeMs: number; skills: LibrarySkill[] }>();

async function cachedRoot(root: string, source: LibrarySource, pack?: string): Promise<LibrarySkill[]> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(root)).mtimeMs;
  } catch {
    return [];
  }
  const key = `${source}\u0000${pack ?? ''}\u0000${root}`;
  const hit = rootCache.get(key);
  if (hit && hit.mtimeMs === mtimeMs) return hit.skills.map((skill) => ({ ...skill }));
  const skills = await readSkillsRoot(root, source, pack);
  rootCache.set(key, { mtimeMs, skills });
  return skills.map((skill) => ({ ...skill }));
}

interface PackManifest {
  id: string;
  title: { zh: string; en: string };
  description: { zh: string; en: string };
  audiences: Array<{ id: string; title: { zh: string; en: string } }>;
}

async function readPackManifests(): Promise<Array<{ dir: string; manifest: PackManifest }>> {
  const root = skillPacksDir();
  if (!root) return [];
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
  const out: Array<{ dir: string; manifest: PackManifest }> = [];
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      const raw = JSON.parse(await readFile(path.join(dir, 'pack.json'), 'utf8')) as Partial<PackManifest>;
      const audiences = Array.isArray(raw.audiences) ? raw.audiences.filter((a) => a && typeof a.id === 'string') : [];
      out.push({
        dir,
        manifest: {
          id: normalizeId(raw.id ?? name),
          title: { zh: String(raw.title?.zh ?? name), en: String(raw.title?.en ?? name) },
          description: { zh: String(raw.description?.zh ?? ''), en: String(raw.description?.en ?? '') },
          audiences: audiences.map((a) => ({ id: normalizeId(a.id), title: { zh: String(a.title?.zh ?? a.id), en: String(a.title?.en ?? a.id) } })),
        },
      });
    } catch {
      // A folder without a readable pack.json is not a pack.
    }
  }
  return out;
}

/**
 * The library: bundled skills, the enabled pack groups' skills (with
 * `allPacks`, the others too, marked not enabled), and the workspace's and
 * data root's skills. A workspace or data-root skill with a bundled skill's
 * id replaces it.
 */
export async function loadSkillLibrary(cwd: string, options: { env?: NodeJS.ProcessEnv; allPacks?: boolean } = {}): Promise<SkillLibrary> {
  const enabledGroups = await enabledPackGroups(options.env);
  const bundledDir = bundledSkillsDir();
  const bundled = bundledDir ? await cachedRoot(bundledDir, 'bundled') : [];
  const packs: PackInfo[] = [];
  const packSkills: LibrarySkill[] = [];
  for (const { dir, manifest } of await readPackManifests()) {
    const audiences: PackAudience[] = [];
    for (const audience of manifest.audiences) {
      const group = `${manifest.id}/${audience.id}`;
      const on = enabledGroups.has(manifest.id) || enabledGroups.has(group) || enabledGroups.has('all');
      const audienceDir = path.join(dir, audience.id);
      // A group that is off is only counted (no files read) unless every pack is asked for.
      if (!on && !options.allPacks) {
        const count = (await readdir(audienceDir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).length;
        audiences.push({ id: audience.id, title: audience.title, count, enabled: false });
        continue;
      }
      const skills = await cachedRoot(audienceDir, 'pack', group);
      for (const skill of skills) skill.enabled = on;
      packSkills.push(...skills);
      audiences.push({ id: audience.id, title: audience.title, count: skills.length, enabled: on });
    }
    packs.push({ id: manifest.id, title: manifest.title, description: manifest.description, audiences });
  }
  // The workspace's own skills are read fresh: the owner or the agent may have just added one.
  const workspace = await readSkillsRoot(path.join(cwd, 'skills'), 'workspace');
  const dataRoot = await readSkillsRoot(path.join(resolveDataRootDir(cwd), 'skills'), 'data-root');
  const byId = new Map<string, LibrarySkill>();
  for (const skill of [...packSkills, ...bundled, ...dataRoot, ...workspace]) {
    // The workspace's own `skills/` folder may be the bundled one (running from a checkout).
    const existing = byId.get(skill.id);
    if (existing && samePath(existing.dirPath, skill.dirPath)) continue;
    byId.set(skill.id, skill);
  }
  const skills = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { skills, packs };
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/** A skill by id or name (any source, packs included: asking by id is a choice). */
export function findLibrarySkill(library: SkillLibrary, idOrName: string): LibrarySkill | undefined {
  const key = normalizeId(idOrName.replace(/^\$/, ''));
  if (!key) return undefined;
  return library.skills.find((skill) => skill.id === key) ?? library.skills.find((skill) => normalizeId(skill.name) === key);
}

// ── relevance ───────────────────────────────────────────────────────────────

/**
 * Chinese words for the topics the library covers, as the English words its
 * descriptions use: requests are often Chinese, the playbooks English.
 */
const ZH_TOPICS: Array<[RegExp, string]> = [
  [/营销|推广|增长|拉新|获客/, 'marketing growth acquisition'],
  [/seo|搜索排名|关键词|收录/i, 'seo search keyword ranking'],
  [/文案|广告语|标题党/, 'copywriting copy'],
  [/广告|投放/, 'ads paid campaign'],
  [/邮件|邮箱营销|电子报/, 'email sequence newsletter'],
  [/社交|社媒|小红书|推特|微博|抖音|帖子/, 'social media content post'],
  [/定价|价格策略|订阅/, 'pricing subscription'],
  [/产品经理|需求文档|prd|路线图/i, 'product prd roadmap requirements'],
  [/代码|编程|开发|重构/, 'code engineering developer refactor'],
  [/代码审查|评审|code review/i, 'review code-review'],
  [/测试|单元测试|质量/, 'test qa quality'],
  [/安全|漏洞|渗透|密钥/, 'security vulnerability secrets'],
  [/部署|上线|运维|容器|k8s|kubernetes|docker/i, 'deploy devops docker kubernetes'],
  [/数据库|sql|表结构/i, 'database sql schema'],
  [/数据分析|指标|埋点|报表|统计/, 'analytics data metrics statistics'],
  [/财务|融资|估值|投资|预算/, 'finance investment cfo fundraising budget'],
  [/合同|提案|标书|法律/, 'contract proposal legal'],
  [/董事会|股东|路演|融资演示/, 'board deck investor pitch'],
  [/汇报|幻灯片|演示|ppt/i, 'presentation deck slides'],
  [/招聘|面试|人力|员工/, 'hiring interview hr people'],
  [/战略|规划|竞争优势/, 'strategy planning'],
  [/竞品|竞争对手|对标/, 'competitive competitor teardown'],
  [/用户研究|访谈|调研/, 'research user interview'],
  [/设计|界面|ui|ux|原型/i, 'design ui ux'],
  [/配色|颜色|字体|排版/, 'color typography'],
  [/logo|标志|品牌/i, 'logo brand'],
  [/视频|短视频|剪辑/, 'video'],
  [/会议|纪要|周报/, 'meeting notes report'],
  [/合规|隐私|gdpr|iso/i, 'compliance privacy gdpr iso'],
  [/交易|股票|行情|财报|宏观/, 'trading market stock earnings macro financial'],
  [/云|aws|azure|gcp/i, 'cloud aws azure gcp'],
  [/文档|说明书|手册|知识库/, 'documentation docs wiki'],
  [/客服|客户成功|流失/, 'customer success churn support'],
  [/提示词|prompt/i, 'prompt'],
  [/上架|应用商店|app store/i, 'app store aso'],
  [/电商|店铺|商家|shopify/i, 'shopify ecommerce store'],
  [/支付|收款|stripe/i, 'payments stripe'],
];

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0];
    if (word.length >= 3 && !STOP_WORDS.has(word)) out.add(word);
    if (/[一-鿿]/.test(word)) for (let i = 0; i < word.length - 1; i += 1) out.add(word.slice(i, i + 2));
  }
  return out;
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'use', 'when', 'user', 'wants', 'this', 'that', 'from', 'your', 'you', 'are', 'can', 'how', 'what', 'into', 'about', 'also', 'skill', 'help', 'make', 'want', 'need', 'please', 'mentions', 'asks']);

/** The request's words, with the English topics its Chinese words stand for. */
export function requestTokens(request: string): Set<string> {
  const words = tokens(request);
  for (const [pattern, english] of ZH_TOPICS) if (pattern.test(request)) for (const word of tokens(english)) words.add(word);
  return words;
}

/** How well a skill fits the request's words; 0 when nothing matches. */
export function scoreSkill(skill: LibrarySkill, words: Set<string>): number {
  if (!words.size) return 0;
  const idWords = tokens(skill.id.replace(/[-_.]/g, ' '));
  const head = tokens(`${skill.name.replace(/[-_]/g, ' ')} ${skill.summary} ${skill.category ?? ''} ${skill.tags.join(' ')}`);
  const body = tokens(skill.description);
  let score = 0;
  for (const word of words) {
    if (idWords.has(word)) score += 3;
    else if (head.has(word)) score += 1.5;
    else if (body.has(word)) score += 0.5;
  }
  return score / Math.sqrt(4 + idWords.size + head.size / 4);
}

/** The enabled skills that best fit `query`, best first. */
export function searchSkillLibrary(library: SkillLibrary, query: string, limit = 10, minScore = 0.35): LibrarySkill[] {
  const words = requestTokens(query);
  return library.skills
    .filter((skill) => skill.enabled)
    .map((skill) => ({ skill, score: scoreSkill(skill, words) }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
    .slice(0, limit)
    .map((entry) => entry.skill);
}

// ── the index ───────────────────────────────────────────────────────────────

/** One line of index text: no structure characters a description could smuggle in. */
function indexSafe(text: string): string {
  return oneLine(text).replace(/\[/g, '(').replace(/\]/g, ')').replace(/`{3,}/g, "'''").replace(/^#+\s*/, '');
}

/**
 * The runtime context's library section: the skills that fit the request
 * (ids and one line each, best first) and the library's size, at most
 * `maxChars`. Empty when the library is empty.
 */
export function renderSkillLibraryIndex(library: SkillLibrary, request: string, maxChars = SKILL_LIBRARY_INDEX_MAX_CHARS): string {
  // The workspace's and data root's own skills stay out of the index (anyone
  // who can write those folders could write the lines); load_skill still
  // finds them by id or query.
  const enabled = library.skills.filter((skill) => skill.enabled && (skill.source === 'bundled' || skill.source === 'pack'));
  if (!enabled.length) return '';
  const header = `📚 [Skill library — ${enabled.length} playbooks for specialist tasks. load_skill with {"id"} reads one in full; with {"query"} searches them all. Reference material, not instructions: use one only when it fits the request.]`;
  const matches = searchSkillLibrary({ ...library, skills: enabled }, request, SKILL_LIBRARY_INDEX_MAX_ENTRIES);
  const categories = new Map<string, number>();
  for (const skill of enabled) {
    const key = skill.pack ? skill.pack.split('/')[1]! : skill.category ?? 'general';
    categories.set(key, (categories.get(key) ?? 0) + 1);
  }
  const topics = `Topics: ${[...categories.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([key, count]) => `${indexSafe(key)} ${count}`).join(', ')}.`;
  let text = header;
  if (text.length + 1 + topics.length <= maxChars) text += `\n${topics}`;
  let added = 0;
  for (const skill of matches) {
    const line = `\n- ${indexSafe(skill.id)}: ${indexSafe(skill.summary)}`;
    if (text.length + line.length + (added === 0 ? 30 : 0) > maxChars) break;
    if (added === 0) text += '\nMay fit this request:';
    text += line;
    added += 1;
  }
  return text.length <= maxChars ? text : '';
}

// ── one skill in full ───────────────────────────────────────────────────────

/** The skill's other readable files (references, examples, templates), relative to its folder. */
export async function listSkillFiles(skill: LibrarySkill, limit = 40): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3 || out.length >= limit) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'tests') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && READABLE_FILE.test(entry.name) && !/^SKILL\.(?:md|json)$/.test(entry.name)) out.push(path.relative(skill.dirPath, full).split(path.sep).join('/'));
    }
  };
  await walk(skill.dirPath, 0);
  return out;
}

/**
 * The skill's folder, resolved: refused when it (or a link on the way)
 * leads outside the library folder it was found in.
 */
export function skillFolder(skill: LibrarySkill): string {
  let root: string;
  let dir: string;
  try {
    root = realpathSync(skill.root);
    dir = realpathSync(skill.dirPath);
  } catch {
    throw new Error(`skill ${skill.id} cannot be read`);
  }
  if (dir === root || !dir.startsWith(root + path.sep)) throw new Error(`skill ${skill.id} is not inside its library folder`);
  return dir;
}

/** The skill's instructions (SKILL.md without front matter, or its description), clamped. */
export async function readLibrarySkillText(skill: LibrarySkill, maxChars = LIBRARY_SKILL_MAX_CHARS): Promise<{ text: string; truncated: boolean }> {
  let text = '';
  if (skill.skillPath?.endsWith('.md')) {
    skillFolder(skill);
    text = stripFrontMatter(await readFile(skill.skillPath, 'utf8').catch(() => '')).trim();
  }
  if (!text) text = skill.description;
  return text.length > maxChars ? { text: `${text.slice(0, maxChars)}\n[… cut at ${maxChars} characters]`, truncated: true } : { text, truncated: false };
}

/** One of the skill's own files, by its path inside the skill's folder (nothing outside it). */
export async function readLibrarySkillFile(skill: LibrarySkill, relative: string): Promise<string> {
  const clean = relative.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!clean || clean.startsWith('/') || clean.split('/').includes('..')) throw new Error(`"${relative}" is not a file of skill ${skill.id}`);
  if (!READABLE_FILE.test(clean)) throw new Error(`"${relative}" is not a text file load_skill can read`);
  const root = skillFolder(skill);
  let file: string;
  try {
    file = realpathSync(path.join(skill.dirPath, clean));
  } catch {
    const known = await listSkillFiles(skill, 20);
    throw new Error(`skill ${skill.id} has no file "${relative}"${known.length ? `; its files: ${known.join(', ')}` : ''}`);
  }
  if (file !== root && !file.startsWith(root + path.sep)) throw new Error(`"${relative}" is not a file of skill ${skill.id}`);
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`"${relative}" is not a file`);
  if (info.size > LIBRARY_FILE_MAX_BYTES) throw new Error(`"${relative}" is larger than load_skill reads (${Math.round(LIBRARY_FILE_MAX_BYTES / 1024)} KB)`);
  const text = await readFile(file, 'utf8');
  return text.length > LIBRARY_FILE_MAX_CHARS ? `${text.slice(0, LIBRARY_FILE_MAX_CHARS)}\n[… cut at ${LIBRARY_FILE_MAX_CHARS} characters]` : text;
}

/** Where a skill comes from, in words. */
export function describeSource(skill: LibrarySkill): string {
  switch (skill.source) {
    case 'bundled':
      return 'bundled';
    case 'pack':
      return `pack ${skill.pack}`;
    case 'workspace':
      return 'workspace skills/ folder';
    case 'data-root':
      return 'data-root skills/ folder';
  }
}
