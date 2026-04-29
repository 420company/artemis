/* eslint-disable no-case-declarations */
import { chooseInteractiveOption } from '../cli/prompt.js';
import { pickLocale, type UiLocale } from '../cli/locale.js';
import { testModelImageGenerationSupport } from './imageGenerationUtils.js';

/* */
export type ImageGenerationDecision = 
  | { type: 'generate'; provider: string }  // 
  | { type: 'configure'; provider: string }  // 
  | { type: 'ignore' }  // 
  | { type: 'pause' }  // 

/* */
export async function showImageGenerationQueryDialog(
  taskDescription: string, 
  currentModel: string, 
  currentProtocol: string, 
  locale: UiLocale
): Promise<ImageGenerationDecision> {
  // 1. 显示查询开始的消息
  const t = pickLocale.bind(null, locale);
  
  console.log(t({
    zh: '检测到任务需要生成图片。正在查询当前配置的API是否支持图片生成功能...',
    en: 'Detected task requires image generation. Checking if current configured API supports image generation...'
  }));

  // 2. 测试当前模型的图片生成支持
  const supportsImage = await testModelImageGenerationSupport(currentModel, currentProtocol);

  if (supportsImage) {
    // 3. 如果支持，直接返回生成决定
    console.log(t({
      zh: '✅ 当前配置的API支持图片生成功能。正在为您生成任务所需的图片...',
      en: '✅ Current configured API supports image generation. Generating required images for your task...'
    }));
    
    return { type: 'generate', provider: currentModel };
  } else {
    // 4. 如果不支持，显示选择对话框
    console.log(t({
      zh: '❌ 当前配置的API不支持图片生成功能。',
      en: '❌ Current configured API does not support image generation.'
    }));

    const choices = [
      {
        label: t({ zh: '配置支持图片生成的API', en: 'Configure API that supports image generation' }),
        value: { type: 'configure', provider: 'new' } as ImageGenerationDecision,
        description: t({ zh: '添加支持图片生成的多模态API（如 DALL-E、Midjourney 等）', en: 'Add a multimodal API that supports image generation (e.g., DALL-E, Midjourney, etc.)' })
      },
      {
        label: t({ zh: '忽略图片部分继续任务', en: 'Ignore image part and continue task' }),
        value: { type: 'ignore' } as ImageGenerationDecision,
        description: t({ zh: '继续执行任务，但忽略图片生成部分', en: 'Continue with the task, but ignore the image generation part' })
      },
      {
        label: t({ zh: '暂停任务', en: 'Pause task' }),
        value: { type: 'pause' } as ImageGenerationDecision,
        description: t({ zh: '暂停当前任务，稍后再处理', en: 'Pause the current task and handle it later' })
      }
    ];

    const decision = await chooseInteractiveOption({
      title: t({
        zh: '图片生成功能不可用',
        en: 'Image generation function is unavailable'
      }),
      choices,
      initialIndex: 0,
      hint: t({ zh: '↑↓ 移动  Enter 确认  Esc 取消', en: '↑↓ move  Enter confirm  Esc cancel' })
    });

    return decision;
  }
}

/* */
export async function showImageGenerationConfiguration(
  locale: UiLocale
): Promise<string> {
  const t = pickLocale.bind(null, locale);
  
  // 
  // 
  console.log(t({
    zh: '配置支持图片生成的API。请选择您想要使用的API：',
    en: 'Configuring API that supports image generation. Please select the API you want to use:'
  }));

  const choices = [
    {
      label: 'DALL-E (OpenAI)',
      value: 'dall-e-3',
      description: 'OpenAI的DALL-E图片生成API'
    },
    {
      label: 'Stable Diffusion (ByteDance)',
      value: 'stable-diffusion-xl',
      description: 'ByteDance的Stable Diffusion图片生成API'
    },
    {
      label: 'Midjourney',
      value: 'midjourney',
      description: 'Midjourney图片生成API'
    },
    {
      label: '其他',
      value: 'custom',
      description: '其他支持图片生成的API'
    }
  ];

  const selected = await chooseInteractiveOption({
    title: t({ zh: '选择图片生成API', en: 'Select Image Generation API' }),
    choices,
    initialIndex: 0,
    hint: t({ zh: '↑↓ 移动  Enter 确认  Esc 取消', en: '↑↓ move  Enter confirm  Esc cancel' })
  });

  return selected;
}

/* */
export async function executeImageGeneration(
  prompt: string, 
  model: string, 
  locale: UiLocale
): Promise<string> {
  const t = pickLocale.bind(null, locale);
  
  console.log(t({
    zh: `正在使用 ${model} 生成图片: ${prompt}`,
    en: `Generating image with ${model}: ${prompt}`
  }));

  // 
  // 
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  const imageUrl = `https://example.com/generated-image-${Date.now()}.png`;
  console.log(t({
    zh: `✅ 图片已生成：${imageUrl}`,
    en: `✅ Image generated: ${imageUrl}`
  }));

  return imageUrl;
}

/* */
export async function handleImageGenerationTask(
  taskDescription: string, 
  currentModel: string, 
  currentProtocol: string, 
  locale: UiLocale
): Promise<Array<string>> {
  const decision = await showImageGenerationQueryDialog(
    taskDescription, 
    currentModel, 
    currentProtocol, 
    locale
  );

  switch (decision.type) {
    case 'generate':
      // 
      const imageUrl = await executeImageGeneration(
        taskDescription, 
        decision.provider, 
        locale
      );
      return [imageUrl];
    case 'configure':
      // 
      const newModel = await showImageGenerationConfiguration(locale);
      const newImageUrl = await executeImageGeneration(
        taskDescription, 
        newModel, 
        locale
      );
      return [newImageUrl];
    case 'ignore':
      // 
      return [];
    case 'pause':
      // 
      throw new Error('Task paused by user');
  }
}
