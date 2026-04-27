import { formatProviderProtocolLabel } from '../providers/factory.js';
import { ProviderStore } from '../providers/store.js';
import type { MemoryEnhancementConfig } from '../providers/types.js';
import { promptMemoryEnhancementConfig } from './memoryOnboarding.js';
import { getMemoryProfile, saveMemoryProfile, MemoryEnhancementFactory } from '../core/memoryEnhancement.js';
import type { UiLocale } from './locale.js';
import { pickLocale } from './locale.js';

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
  
  const newProfile = await promptMemoryEnhancementConfig(t, zh);
  
  if (!newProfile) {
    console.log(t('未修改记忆增强配置') + '\n');
    return {
      configured: currentProfile.enabled,
      changed: false,
      memoryProfile: currentProfile
    };
  }
  
  await saveMemoryProfile(cwd || process.cwd(), newProfile);
  
  console.log(t('记忆增强配置已保存') + '\n');
  
  return {
    configured: newProfile.enabled,
    changed: true,
    memoryProfile: newProfile
  };
}