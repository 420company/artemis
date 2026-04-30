/* eslint-disable @typescript-eslint/no-unused-vars */
import { getMemoryProfile, saveMemoryProfile, MemoryEnhancementFactory } from '../core/memoryEnhancement.js';
import type { MemoryEnhancementConfig } from '../providers/types.js';
import { chooseInteractiveOption, createInteractivePromptIO } from './prompt.js';
import { formatProviderProtocolLabel } from '../providers/factory.js';

export async function promptMemoryEnhancementConfig(t: (key: string) => string, zh: boolean): Promise<MemoryEnhancementConfig | undefined> {
  console.log(t('记忆增强配置向导') + '\n');
  console.log(t('记忆增强系统可以提升AI的上下文理解和长期记忆能力。'));
  console.log(t('通过将对话、文档和任务信息转换为语义向量，实现更准确的记忆检索。') + '\n');

  const enabledChoice = await chooseInteractiveOption<'enable' | 'disable'>({
    title: t('启用记忆增强'),
    hint: t('↑↓ 移动  Enter 确认'),
    choices: [
      { 
        label: t('启用'), 
        value: 'enable', 
        description: t('开启记忆增强功能，提升AI的记忆和上下文理解能力')
      },
      { 
        label: t('禁用'), 
        value: 'disable', 
        description: t('禁用记忆增强功能，使用默认的上下文处理方式')
      }
    ]
  });

  if (enabledChoice === 'disable') {
    return {
      enabled: false,
      provider: 'none'
    };
  }

  const providerChoice = await chooseInteractiveOption<'byteplus' | 'local'>({
    title: t('选择记忆增强方案'),
    hint: t('↑↓ 移动  Enter 确认'),
    choices: [
      { 
        label: t('智能云方案'), 
        value: 'byteplus', 
        description: t('使用 BytePlus 专业嵌入模型，提供高质量语义检索，需配置 API Key')
      },
      { 
        label: t('本地方案'), 
        value: 'local', 
        description: t('使用本地算法实现基础记忆功能，无需额外配置，适合离线使用')
      }
    ]
  });

  const config: MemoryEnhancementConfig = {
    enabled: true,
    provider: providerChoice
  };

  if (providerChoice === 'byteplus') {
    config.config = {
      apiKey: '',
      baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/coding/v3',
      model: 'skylark-embedding-vision'
    };

    console.log('\n' + t('BytePlus 配置'));
    console.log(t('请配置 BytePlus API Key 以使用记忆增强功能'));
    
    const apiKey = await askForInput(t('API Key'), true);
    
    if (!apiKey) {
      console.log(t('API Key 不能为空，将使用本地方案'));
      config.provider = 'local';
      config.config = {
        model: 'local-embedding'
      };
    } else {
      config.config!.apiKey = apiKey;
      
      const modelChoice = await chooseInteractiveOption<'skylark-embedding-vision' | 'custom'>({
        title: t('选择嵌入模型'),
        hint: t('↑↓ 移动  Enter 确认'),
        choices: [
          { 
            label: t('Skylark Embedding Vision'), 
            value: 'skylark-embedding-vision', 
            description: t('支持视觉内容的高质量嵌入模型（推荐）')
          },
          { 
            label: t('自定义模型'), 
            value: 'custom', 
            description: t('使用其他 BytePlus 嵌入模型')
          }
        ]
      });
      
      if (modelChoice === 'custom') {
        const customModel = await askForInput(t('自定义模型名称'));
        if (customModel) {
          config.config!.model = customModel;
        }
      }

      // API URL: present the default and let user keep it or override.
      // Avoids forcing every user to type the full BytePlus endpoint when
      // they're using the default skylark-embedding-vision model anyway.
      const baseUrlChoice = await chooseInteractiveOption<'default' | 'custom'>({
        title: t('选择 API 地址'),
        hint: t('↑↓ 移动  Enter 确认'),
        choices: [
          {
            label: t('使用默认地址（推荐）'),
            value: 'default',
            description: config.config!.baseUrl
          },
          {
            label: t('自定义 API 地址'),
            value: 'custom',
            description: t('如果你部署了 BytePlus 私有网关或使用代理，选这个')
          }
        ]
      });
      if (baseUrlChoice === 'custom') {
        const customBaseUrl = await askForInput(t('自定义 API 地址'), false);
        if (customBaseUrl) {
          config.config!.baseUrl = customBaseUrl;
        }
      }
    }
  } else {
    config.config = {
      model: 'local-embedding'
    };
  }

  console.log('\n' + t('记忆增强配置完成') + '\n');
  console.log(t('已启用记忆增强功能，使用方案：') + t(config.provider === 'byteplus' ? '智能云' : '本地'));
  
  if (config.config) {
    if (config.provider === 'byteplus') {
      console.log(t('模型：') + config.config.model);
      console.log(t('API 地址：') + config.config.baseUrl);
    } else {
      console.log(t('使用本地嵌入算法，无需网络连接'));
    }
  }

  return config;
}

function maskApiKey(apiKey: string): string {
  return apiKey.length <= 8 
    ? `${apiKey.slice(0, 2)}****`
    : `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`;
}

async function askForInput(prompt: string, masked = false): Promise<string> {
  const io = createInteractivePromptIO();
  if (io.available) {
    return (await io.ask(prompt + ': ', masked)).trim();
  }

  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(prompt + ': ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function buildMemoryProfileSummaryLines(config: MemoryEnhancementConfig, t: (key: string) => string): string[] {
  const lines: string[] = [];
  
  if (config.enabled) {
    lines.push(t('记忆增强：已启用'));
    lines.push(t('方案：') + t(config.provider === 'byteplus' ? '智能云' : '本地'));
    
    if (config.provider === 'byteplus' && config.config) {
      lines.push(t('模型：') + config.config.model);
      lines.push(t('API 地址：') + config.config.baseUrl);
      if (config.config.apiKey) {
        lines.push(t('API Key：') + maskApiKey(config.config.apiKey));
      }
    }
  } else {
    lines.push(t('记忆增强：未启用'));
  }
  
  return lines;
}
