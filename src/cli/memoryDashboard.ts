import type { UiLocale } from './locale.js';
import { buildPanel } from './ui.js';
import {
  ensureMemoryMigrated,
  listMemories,
  readMemoryByName,
  saveMemory,
  trashMemory,
  restoreMemory,
  scopesCollide,
  memoryDirForScope,
  slugifyMemoryName,
  type MemoryEntry,
  type MemoryScope,
} from '../storage/memoryFiles.js';

function parseScopeFlag(args: string[]): { scope: MemoryScope | 'all'; rest: string[] } {
  const rest: string[] = [];
  let scope: MemoryScope | 'all' = 'all';
  for (const arg of args) {
    if (arg === '--global' || arg === '-g') scope = 'global';
    else if (arg === '--project' || arg === '-p') scope = 'project';
    else rest.push(arg);
  }
  return { scope, rest };
}

async function gather(cwd: string, scope: MemoryScope | 'all'): Promise<MemoryEntry[]> {
  const collided = scopesCollide(cwd);
  const scopes: MemoryScope[] =
    scope === 'all' ? (collided ? ['global'] : ['global', 'project']) : [scope];
  const out: MemoryEntry[] = [];
  for (const s of scopes) out.push(...await listMemories(cwd, s));
  return out;
}

async function findEntry(cwd: string, name: string): Promise<MemoryEntry | null> {
  const slug = slugifyMemoryName(name);
  return (await readMemoryByName(cwd, 'global', slug))
    ?? (scopesCollide(cwd) ? null : await readMemoryByName(cwd, 'project', slug));
}

export async function runMemoryCommand(options: { cwd: string; locale: UiLocale; args: string[] }): Promise<void> {
  const { cwd, locale } = options;
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const { scope, rest } = parseScopeFlag(options.args.filter(Boolean));
  const sub = rest[0]?.toLowerCase();

  await ensureMemoryMigrated(cwd);

  if (!sub || sub === 'list' || sub === 'ls') {
    const entries = await gather(cwd, scope);
    if (entries.length === 0) {
      console.log();
      console.log(buildPanel(t('长期记忆', 'Long-Term Memory'), [
        t('还没有任何长期记忆。', 'No long-term memories recorded yet.'),
        t(`全局目录：${memoryDirForScope(cwd, 'global')}`, `Global dir: ${memoryDirForScope(cwd, 'global')}`),
      ]));
      console.log();
      return;
    }
    const rows = entries.map((e) => {
      const scopeTag = e.scope === 'global' ? '[G]' : '[P]';
      return `${scopeTag} ${e.name.padEnd(28).slice(0, 28)} ${`[${e.category}]`.padEnd(12)} ${e.description.slice(0, 60)}`;
    });
    console.log();
    console.log(buildPanel(t(`长期记忆（${entries.length} 条）`, `Long-Term Memories (${entries.length})`), rows));
    console.log(t(
      '\n  artemis memory show <name> 看全文 / rm <name> 删除 / restore <name> 恢复',
      '\n  artemis memory show <name> | rm <name> | restore <name>'
    ));
    console.log();
    return;
  }

  if (sub === 'show' || sub === 'cat') {
    const name = rest[1];
    if (!name) { console.log(t('用法：artemis memory show <name>', 'Usage: artemis memory show <name>')); return; }
    const entry = await findEntry(cwd, name);
    if (!entry) { console.log(t(`没找到记忆 "${name}"`, `No memory named "${name}"`)); return; }
    console.log();
    console.log(buildPanel(`${entry.name} · ${entry.scope} · ${entry.category} · ${entry.updatedAt || '?'}`, [
      entry.description,
      '',
      ...entry.content.split('\n'),
    ]));
    console.log();
    return;
  }

  if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
    const name = rest[1];
    if (!name) { console.log(t('用法：artemis memory rm <name>', 'Usage: artemis memory rm <name>')); return; }
    const entry = await findEntry(cwd, name);
    if (!entry) { console.log(t(`没找到记忆 "${name}"`, `No memory named "${name}"`)); return; }
    await trashMemory(cwd, entry.scope, entry.name);
    console.log();
    console.log(buildPanel(t('🗑️ 已移入回收站', '🗑️ Moved to trash'), [
      entry.name,
      t('可用 artemis memory restore <name> 恢复。', 'Recoverable via: artemis memory restore <name>'),
    ]));
    console.log();
    return;
  }

  if (sub === 'restore') {
    const name = rest[1];
    if (!name) { console.log(t('用法：artemis memory restore <name>', 'Usage: artemis memory restore <name>')); return; }
    let restored = await restoreMemory(cwd, 'global', name);
    if (!restored && !scopesCollide(cwd)) restored = await restoreMemory(cwd, 'project', name);
    console.log(restored
      ? t(`已恢复 "${slugifyMemoryName(name)}"`, `Restored "${slugifyMemoryName(name)}"`)
      : t(`回收站里没有 "${name}"`, `Nothing named "${name}" in trash`));
    return;
  }

  if (sub === 'add') {
    const text = rest.slice(1).join(' ').trim();
    if (!text) {
      console.log(t('用法：artemis memory add [--global|--project] <内容>', 'Usage: artemis memory add [--global|--project] <text>'));
      return;
    }
    const targetScope: MemoryScope = scope === 'project' ? 'project' : 'global';
    const result = await saveMemory(cwd, targetScope, {
      name: slugifyMemoryName(text.slice(0, 48)),
      description: text.slice(0, 120),
      category: 'preference',
      content: text,
      source: 'manual',
    });
    console.log(result.ok
      ? t(`已保存（${targetScope}）：${result.name}`, `Saved (${targetScope}): ${result.name}`)
      : t(`保存被拒：${result.reason}`, `Rejected: ${result.reason}`));
    return;
  }

  if (sub === 'doctor') {
    const entries = await gather(cwd, 'all');
    const dupes: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = new Set(entries[i].description.toLowerCase().split(/\s+/));
        const b = new Set(entries[j].description.toLowerCase().split(/\s+/));
        const inter = [...a].filter((w) => b.has(w)).length;
        const union = new Set([...a, ...b]).size;
        if (union > 0 && inter / union > 0.6) {
          dupes.push(`${entries[i].name} ≈ ${entries[j].name}`);
        }
      }
    }
    console.log();
    console.log(buildPanel(t('记忆体检', 'Memory Doctor'), dupes.length
      ? [t('疑似语义重复，建议合并：', 'Possible semantic duplicates, consider merging:'), ...dupes]
      : [t('未发现明显重复。', 'No obvious duplicates found.')]));
    console.log();
    return;
  }

  console.log();
  console.log(buildPanel(t('Memory 命令', 'Memory commands'), [
    '  artemis memory list [--global|--project]',
    '  artemis memory show <name>',
    '  artemis memory add [--global|--project] <text>',
    '  artemis memory rm <name>',
    '  artemis memory restore <name>',
    '  artemis memory doctor',
  ]));
  console.log();
}
