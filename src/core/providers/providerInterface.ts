/**
 * 模型提供者接口定义
 */

import { ToolDefinition } from '../toolDef.js';

// 配置接口
export interface ProviderConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  [key: string]: any;
}

// 请求接口
export interface LlmRequest {
  prompt: string;
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  [key: string]: any;
}

// 响应接口
export interface LlmResponse {
  content: string;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  [key: string]: any;
}

// 模型提供者接口
export interface ProviderInterface {
  complete(request: LlmRequest): Promise<string>;
  completeWithTools(request: LlmRequest): Promise<string>;
  streamComplete(request: LlmRequest, callback: (chunk: string) => void): Promise<string>;
  embed(text: string): Promise<number[]>;
  generateImage(prompt: string, options?: any): Promise<string>;
  transcribe(audioData: Buffer): Promise<string>;
  translate(text: string, targetLanguage: string): Promise<string>;
  createCompletionStream(request: LlmRequest): Promise<ReadableStream<string>>;
  
  getConfig(): ProviderConfig;
  updateConfig(config: Partial<ProviderConfig>): void;
  isHealthy(): boolean;
  getUsage(): Promise<{ [key: string]: number }>;
  getMetrics(): { [key: string]: number };
  testConnection(): Promise<boolean>;
  listModels(): Promise<string[]>;
  getModelInfo(modelId: string): Promise<any>;
}

// 提供者工厂接口
export interface ProviderFactory {
  createProvider(config: ProviderConfig): ProviderInterface;
  listSupportedProviders(): string[];
  getProviderInfo(name: string): any;
}
