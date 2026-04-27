import { choosePromptOption } from '../cli/prompt.js'
import { pickLocale, type UiLocale } from '../cli/locale.js'
import type { PromptIO } from '../providers/types.js'

import { FreyaAssetType, FreyaAssetRequest, FreyaAssetResponse } from '../tools/visual/registry.js'
import { FreyaStateManager } from '../core/freyaState.js'

// ─── FREYA CLI INTERRUPTION MENU ─────────────────────────────────────────────

export async function showFreyaMenu(
  request: FreyaAssetRequest,
  promptIO: PromptIO | undefined,
  locale: UiLocale,
  context: { messages: any[]; astState: any; taskContext: any }
): Promise<FreyaAssetResponse> {
  const result = await choosePromptOption(promptIO, {
    title: pickLocale(locale, { zh: '🎨 Freya 视觉管道', en: '🎨 Freya Visual Pipeline' }),
    initialIndex: 0,
    escapeValue: 'cancel',
    choices: [
      {
        label: pickLocale(locale, { zh: '配置视觉模型', en: 'Configure Visual Model' }),
        value: 'configure',
        description: pickLocale(locale, { 
          zh: '只编辑视觉生成配置，不改主模型/副模型', 
          en: 'Edit visual generation only without touching main/secondary models' 
        }),
      },
      {
        label: pickLocale(locale, { zh: '深度搜索 SERP API', en: 'Deep Search via SERP API' }),
        value: 'search',
        description: pickLocale(locale, { 
          zh: '在网上查找符合要求的真实图片', 
          en: 'Find real images online matching your requirements' 
        }),
      },
      {
        label: pickLocale(locale, { zh: '生成 SVG 占位符', en: 'Generate SVG Placeholder' }),
        value: 'generate',
        description: pickLocale(locale, { 
          zh: '为您的 UI 创建美观的 SVG 占位符', 
          en: 'Create a beautiful SVG placeholder for your UI' 
        }),
      },
      {
        label: pickLocale(locale, { zh: '取消/返回', en: 'Cancel/Return' }),
        value: 'cancel',
        description: pickLocale(locale, { 
          zh: '继续主对话而不生成视觉资源', 
          en: 'Resume main conversation without visual asset' 
        }),
      },
    ],
  })

  switch (result) {
    case 'configure':
      // 
      await FreyaStateManager.suspendSession({
        messages: context.messages,
        astState: context.astState,
        taskContext: context.taskContext,
        assetRequest: request
      })
      
      return {
        status: 'INTERRUPT_REQUIRED',
        intent: 'VISUAL_GENERATION',
        assetPath: 'configure'
      }
    
    case 'search':
      return {
        status: 'INTERRUPT_REQUIRED',
        intent: 'VISUAL_GENERATION',
        assetPath: 'search'
      }
    
    case 'generate':
      return {
        status: 'INTERRUPT_REQUIRED',
        intent: 'VISUAL_GENERATION',
        assetPath: 'generate'
      }
    
    case 'cancel':
    default:
      return {
        status: 'CANCELLED'
      }
  }
}

// ─── FREYA MENU HELPERS ─────────────────────────────────────────────────────

export async function confirmFreyaAction(
  action: string,
  promptIO: PromptIO | undefined,
  locale: UiLocale
): Promise<boolean> {
  const result = await choosePromptOption(promptIO, {
    title: pickLocale(locale, { zh: '确认操作', en: 'Confirm Action' }),
    initialIndex: 1,
    escapeValue: false,
    choices: [
      { 
        label: pickLocale(locale, { zh: '是，继续', en: 'Yes, proceed' }), 
        value: true 
      },
      { 
        label: pickLocale(locale, { zh: '否，取消', en: 'No, cancel' }), 
        value: false 
      },
    ],
  })

  return Boolean(result)
}

export async function showFreyaStatus(
  message: string,
  promptIO: PromptIO | undefined
): Promise<void> {
  promptIO?.write(`✨ Freya: ${message}`)
}

export async function showFreyaError(
  error: string,
  promptIO: PromptIO | undefined
): Promise<void> {
  promptIO?.write(`⚠️ Freya: ${error}`)
}
