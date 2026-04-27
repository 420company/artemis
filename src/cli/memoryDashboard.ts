import { MemoryStore } from '../storage/memoryStore.js';
import type { UiLocale } from './locale.js';
import { buildPanel } from './ui.js';

export async function runMemoryCommand(options: { cwd: string; locale: UiLocale; args: string[] }): Promise<void> {
  const { cwd, locale, args } = options;
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const sub = args[0]?.toLowerCase();

  const store = new MemoryStore(cwd);
  const insights = await store.load();

  if (!sub || sub === 'list' || sub === 'ls') {
    if (insights.length === 0) {
      console.log();
      console.log(buildPanel(t('Mnemosyne 长期学习认知', 'Mnemosyne Long-Term Insights'), [
        t('AI 目前没有记录任何关于您的长期认知。', 'The AI has not recorded any long-term insights about you yet.'),
      ]));
      console.log();
      return;
    }

    const rows = insights.map((insight, idx) => {
      const displayId = String(idx + 1).padStart(2, '0');
      const cat = `[${insight.category}]`.padEnd(14, ' ');
      return `${displayId}. ${cat} ${insight.content.slice(0, 60)}`;
    });

    console.log();
    console.log(buildPanel(t(`认知库已收录条目 (${insights.length}/30)`, `Global Knowledge Entries (${insights.length}/30)`), rows));
    console.log(t(
      '\n  要想删除某条错误认知，使用：artemis memory remove <序号>',
      '\n  To delete a bad insight, use: artemis memory remove <number>'
    ));
    console.log();
    return;
  }

  if (sub === 'remove' || sub === 'rm') {
    const rawIndex = parseInt(args[1], 10);
    if (isNaN(rawIndex) || rawIndex < 1 || rawIndex > insights.length) {
      console.log();
      console.log(t(`错误：请提供有效的认知序号 (1 到 ${insights.length})`, `Error: Please provide a valid index (1 to ${insights.length})`));
      console.log();
      return;
    }

    const arrayIndex = rawIndex - 1;
    const removedName = insights[arrayIndex].content;
    const nextInsights = [...insights];
    nextInsights.splice(arrayIndex, 1);
    await store.save(nextInsights);

    console.log();
    console.log(buildPanel(t('🗑️ 认知已抹除', '🗑️ Insight Erased'), [
      `"${removedName}"`,
      t('已永远从 AI 的潜意识中删去。', 'Has been permanently wiped from the AI subconscious.')
    ]));
    console.log();
    return;
  }

  // default: show help
  console.log();
  console.log(buildPanel(t('Memory 命令', 'Memory commands'), [
    '  artemis memory list              ' + t('列出所有潜意识认知', 'List all insights'),
    '  artemis memory remove <序号>      ' + t('抹除某条错误认知', 'Delete an insight by index'),
  ]));
  console.log();
}
