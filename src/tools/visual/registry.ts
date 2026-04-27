// ─── FREYA VISUAL ASSET TYPES ───────────────────────────────────────────────

import { toolLog } from '../../utils/log.js'

export type FreyaAssetType = 'image' | 'video' | 'icon'

export interface FreyaAssetRequest {
  assetType: FreyaAssetType
  contextDescription: string
  preferredStyle?: string
}

export interface FreyaAssetResponse {
  status: 'INTERRUPT_REQUIRED' | 'COMPLETED' | 'CANCELLED'
  intent?: 'VISUAL_GENERATION'
  assetPath?: string
}

// ─── FREYA TOOL SCHEMA ──────────────────────────────────────────────────────

export const FREYA_VISUAL_ASSET_SCHEMA = {
  type: 'object' as const,
  properties: {
    assetType: {
      type: 'string' as const,
      enum: ['image', 'video', 'icon'],
      description: 'Type of visual asset to generate',
    },
    contextDescription: {
      type: 'string' as const,
      description: 'Detailed description of the UI/Component context requiring the asset',
    },
    preferredStyle: {
      type: 'string' as const,
      description: 'Preferred visual style for the asset',
    },
  },
  required: ['assetType', 'contextDescription'],
}

// ─── FREYA TOOL INTERFACE ───────────────────────────────────────────────────

export interface FreyaVisualTool {
  name: string
  description: string
  input_schema: typeof FREYA_VISUAL_ASSET_SCHEMA
  execute: (params: FreyaAssetRequest) => Promise<FreyaAssetResponse>
}

// ─── FREYA TOOL IMPLEMENTATION ──────────────────────────────────────────────

export const requestFreyaVisualAsset: FreyaVisualTool = {
  name: 'request_freya_visual_asset',
  description: 'Request a visual asset from Freya Visual Pipeline',
  input_schema: FREYA_VISUAL_ASSET_SCHEMA,
  
  async execute(params: FreyaAssetRequest): Promise<FreyaAssetResponse> {
    // This tool never blocks - it always returns INTERRUPT_REQUIRED to halt the main agent loop
    toolLog('⚡ Freya Visual Pipeline triggered for asset type:', params.assetType)
    
    return {
      status: 'INTERRUPT_REQUIRED',
      intent: 'VISUAL_GENERATION'
    }
  }
}

// ─── FREYA TOOL REGISTRY ────────────────────────────────────────────────────

export const FREYA_VISUAL_TOOLS = {
  [requestFreyaVisualAsset.name]: requestFreyaVisualAsset
}

export type FreyaToolName = keyof typeof FREYA_VISUAL_TOOLS

// ─── EXPORT ─────────────────────────────────────────────────────────────────

export { requestFreyaVisualAsset as default }
