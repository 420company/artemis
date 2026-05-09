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

  const providerChoice = await chooseInteractiveOption<'byteplus' | 'openai' | 'google' | 'mistral' | 'local'>({
    title: t('选择记忆增强方案'),
    hint: t('↑↓ 移动  Enter 确认'),
    choices: [
      { 
        label: t('BytePlus 云嵌入'), 
        value: 'byteplus', 
        description: t('Skylark Embedding Vision，高质量中英文+视觉，需 BytePlus API Key')
      },
      { 
        label: t('OpenAI 云嵌入'), 
        value: 'openai', 
        description: t('text-embedding-3-small/large，成熟稳定，需 OpenAI API Key')
      },
      { 
        label: t('Google Gemini 云嵌入'), 
        value: 'google', 
        description: t('gemini-embedding-2-preview，多模态嵌入，需 Google API Key')
      },
      { 
        label: t('Mistral 云嵌入'), 
        value: 'mistral', 
        description: t('mistral-embed，轻量高效，需 Mistral API Key')
      },
      { 
        label: t('本地方案'), 
        value: 'local', 
        description: t('本地算法，无需联网，适合离线使用')
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
      model: 'skylark-embedding-vision-251215'
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
      
      const modelChoice = await chooseInteractiveOption<'skylark-embedding-vision-251215' | 'skylark-embedding-vision-250615' | 'skylark-embedding-vision-250328' | 'custom'>({
        title: t('选择 BytePlus 嵌入模型'),
        hint: t('↑↓ 移动  Enter 确认'),
        choices: [
          { 
            label: t('Skylark Embedding Vision (251215)'), 
            value: 'skylark-embedding-vision-251215', 
            description: t('最新版本，高质量中英文+视觉嵌入（推荐）')
          },
          { 
            label: t('Skylark Embedding Vision (250615)'), 
            value: 'skylark-embedding-vision-250615', 
            description: t('中期版本')
          },
          { 
            label: t('Skylark Embedding Vision (250328)'), 
            value: 'skylark-embedding-vision-250328', 
            description: t('早期版本')
          },
          { 
            label: t('自定义模型'), 
            value: 'custom', 
            description: t('使用其他 BytePlus 嵌入模型或自定义端点 ID')
          }
        ]
      });
      
      if (modelChoice === 'custom') {
        const customModel = await askForInput(t('自定义模型名称'));
        if (customModel) {
          config.config!.model = customModel;
        }
      } else {
        config.config!.model = modelChoice;
      }

      const baseUrlChoice = await chooseInteractiveOption<'default' | 'custom'>({
        title: t('选择 API 地址'),
        hint: t('↑↓ 移动  Enter 确认'),
        choices: [
          {
            label: t('使用默认地址（推荐）'),
            value: 'default',
            description: config.config!.baseUrl!
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
  } else if (providerChoice === 'google') {
    config.config = {
      apiKey: '',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-embedding-2-preview'
    };

    console.log('\n' + t('Google Gemini 配置'));
    console.log(t('请配置 Google API Key 以使用记忆增强功能'));
    
    const apiKey = await askForInput(t('API Key'), true);
    
    if (!apiKey) {
      console.log(t('API Key 不能为空，将使用本地方案'));
      config.provider = 'local';
      config.config = {
        model: 'local-embedding'
      };
    } else {
      config.config!.apiKey = apiKey;
    }
  } else if (providerChoice === 'mistral') {
    config.config = {
      apiKey: '',
      baseUrl: 'https://api.mistral.ai/v1',
      model: 'mistral-embed'
    };

    console.log('\n' + t('Mistral 配置'));
    console.log(t('请配置 Mistral API Key 以使用记忆增强功能'));
    
    const apiKey = await askForInput(t('API Key'), true);
    
    if (!apiKey) {
      console.log(t('API Key 不能为空，将使用本地方案'));
      config.provider = 'local';
      config.config = {
        model: 'local-embedding'
      };
    } else {
      config.config!.apiKey = apiKey;
    }
  } else if (providerChoice === 'openai') {
    config.config = {
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'text-embedding-3-small'
    };

    console.log('\n' + t('OpenAI 配置'));
    console.log(t('请配置 OpenAI API Key 以使用记忆增强功能'));
    
    const apiKey = await askForInput(t('API Key'), true);
    
    if (!apiKey) {
      console.log(t('API Key 不能为空，将使用本地方案'));
      config.provider = 'local';
      config.config = {
        model: 'local-embedding'
      };
    } else {
      config.config!.apiKey = apiKey;
      
      const modelChoice = await chooseInteractiveOption<'text-embedding-3-small' | 'text-embedding-3-large' | 'custom'>({
        title: t('选择 OpenAI 嵌入模型'),
        hint: t('↑↓ 移动  Enter 确认'),
        choices: [
          { 
            label: t('text-embedding-3-small'), 
            value: 'text-embedding-3-small', 
            description: t('性价比最高，1536 维，$0.02/1M tokens（推荐）')
          },
          { 
            label: t('text-embedding-3-large'), 
            value: 'text-embedding-3-large', 
            description: t('最高质量，3072 维，$0.13/1M tokens')
          },
          { 
            label: t('自定义模型'), 
            value: 'custom', 
            description: t('使用其他 OpenAI 嵌入模型')
          }
        ]
      });
      
      if (modelChoice === 'custom') {
        const customModel = await askForInput(t('自定义模型名称'));
        if (customModel) {
          config.config!.model = customModel;
        }
      } else {
        config.config!.model = modelChoice;
      }

      const baseUrlChoice = await chooseInteractiveOption<'default' | 'custom'>({
        title: t('选择 API 地址'),
        hint: t('↑↓ 移动  Enter 确认'),
        choices: [
          {
            label: t('使用默认地址（推荐）'),
            value: 'default',
            description: config.config!.baseUrl!
          },
          {
            label: t('自定义 API 地址'),
            value: 'custom',
            description: t('如果你使用 Azure OpenAI 或其他兼容端点，选这个')
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

  console.log('');
  const providerLabel: Record<string, string> = {
    byteplus: 'BytePlus 云嵌入',
    openai: 'OpenAI 云嵌入',
    google: 'Google Gemini 云嵌入',
    mistral: 'Mistral 云嵌入',
    local: '本地嵌入',
  };
  console.log('  ' + t('─── 记忆增强已就绪 ───'));
  console.log('');
  console.log('  ✓ ' + t('方案：') + t(providerLabel[config.provider] ?? config.provider));

  if (config.config) {
    if (config.provider === 'byteplus') {
      console.log('  ✓ ' + t('模型：') + config.config.model);
      console.log('  ✓ ' + t('API 地址：') + config.config.baseUrl);
    } else {
      console.log('  ✓ ' + t('离线运行，无需联网'));
    }
  }

  console.log('');
  console.log('  ' + t('使用说明'));
  console.log('    • ' + t('全自动运行 —— 进入主界面即生效，无需手动启动'));
  console.log('    • ' + t('每次会话结束时，系统会自动从对话中提炼"长期偏好"和"项目事实"，写入增强记忆'));
  console.log('    • ' + t('下次提出相关问题时，对应记忆会自动检索并注入到上下文里'));
  console.log('    • ' + t('重新配置：') + 'artemis setup memory');
  console.log('    • ' + t('数据位置：') + '.artemis/enhanced-memory.json');
  console.log('');

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
    
    const isCloud = config.provider === 'byteplus' || config.provider === 'openai' || config.provider === 'google' || config.provider === 'mistral';
    if (isCloud && config.config) {
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
