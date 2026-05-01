import type { MemoryEnhancementConfig } from '../providers/types.js';
import { promptMemoryEnhancementConfig } from './memoryOnboarding.js';
import { getMemoryProfile, saveMemoryProfile, MemoryEnhancementFactory } from '../core/memoryEnhancement.js';
import type { UiLocale } from './locale.js';
import { pickLocale } from './locale.js';
import { chooseInteractiveOption } from './prompt.js';

async function validateMemoryProfile(cwd: string, profile: MemoryEnhancementConfig): Promise<{ ok: boolean; error?: string }> {
  if (!profile.enabled || profile.provider === 'none') {
    return { ok: true };
  }

  try {
    const memory = await MemoryEnhancementFactory.create(profile, cwd);
    await memory.initialize();
    await memory.searchMemories('artemis memory setup connectivity probe', 1);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runMemoryEnhancementSetup(localeHint: UiLocale, cwd?: string): Promise<{ configured: boolean; changed: boolean; memoryProfile: MemoryEnhancementConfig }> {
  const t = (key: string) => pickLocale(localeHint, {
    zh: key,
    en: key // 暂时使用相同的字符串，后续可以添加英文翻译
  });
  const zh = localeHint === 'zh-CN';
  
  console.log(`  ─── ${t('记忆增强系统配置')} ───\n`);
  
  const currentProfile = await getMemoryProfile(cwd || process.cwd());
  
  if (currentProfile.enabled) {
    console.log(t('当前记忆增强配置已启用') + '\n');
    // 显示当前配置详情
  } else {
    console.log(t('记忆增强系统尚未配置') + '\n');
  }
  
  let newProfile = await promptMemoryEnhancementConfig(t, zh);
  
  if (!newProfile) {
    console.log(t('未修改记忆增强配置') + '\n');
    return {
      configured: currentProfile.enabled,
      changed: false,
      memoryProfile: currentProfile
    };
  }

  if (newProfile.enabled) {
    console.log(t('正在验证记忆增强是否真实可用...') + '\n');
    const validation = await validateMemoryProfile(cwd || process.cwd(), newProfile);
    if (!validation.ok) {
      console.log(t(`记忆增强连接测试失败：${validation.error ?? '未知错误'}`) + '\n');
      const fallback = await chooseInteractiveOption<'local' | 'disabled' | 'save'>({
        title: t('如何处理当前记忆增强配置？'),
        initialIndex: 0,
        choices: [
          {
            label: t('改用本地记忆增强（推荐）'),
            value: 'local',
            description: t('不需要 API key，会立即可用，但语义检索质量弱于 BytePlus embedding。'),
          },
          {
            label: t('先关闭记忆增强'),
            value: 'disabled',
            description: t('保存为关闭状态，之后可重新运行 artemis setup memory。'),
          },
          {
            label: t('仍然保存当前配置'),
            value: 'save',
            description: t('只适合你确认当前网络或配额稍后会恢复的情况。'),
          },
        ],
      });

      if (fallback === 'local') {
        newProfile = {
          enabled: true,
          provider: 'local',
          config: { model: 'local-embedding' },
        };
      } else if (fallback === 'disabled') {
        newProfile = {
          enabled: false,
          provider: 'none',
        };
      }
    } else {
      console.log(t('记忆增强连接测试通过') + '\n');
    }
  }
  
  await saveMemoryProfile(cwd || process.cwd(), newProfile);
  
  console.log('  ✓ ' + t('记忆增强配置已保存') + '\n');
  if (newProfile.enabled) {
    console.log('  ' + t('使用说明'));
    console.log('    • ' + t('会话结束时自动提炼长期偏好与项目事实，写入增强记忆'));
    console.log('    • ' + t('下次提出相关问题时，对应记忆会自动检索并注入上下文'));
    console.log('    • ' + t('数据位置：') + '.artemis/enhanced-memory.json');
    console.log('    • ' + t('重新配置：') + 'artemis setup memory');
    console.log('');
  }
  
  return {
    configured: newProfile.enabled,
    changed: true,
    memoryProfile: newProfile
  };
}
