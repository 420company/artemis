/* eslint-disable @typescript-eslint/no-unused-vars */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ProviderStore } from '../providers/store.js';
import type { MemoryEnhancementConfig } from '../providers/types.js';
import { ensureDir, resolveDataRootDir } from '../utils/fs.js';

// 默认配置
const DEFAULT_MEMORY_CONFIG: MemoryEnhancementConfig = {
  enabled: false,
  provider: 'none'
};

// BytePlus 记忆增强默认配置
const DEFAULT_BYTEPLUS_CONFIG = {
  apiKey: '',
  baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/coding/v3',
  model: 'skylark-embedding-vision'
};

// 本地记忆增强默认配置
const DEFAULT_LOCAL_CONFIG = {
  model: 'local-embedding'
};

// 记忆结果类型
export interface MemoryResult {
  id: string;
  text: string;
  similarity: number;
  metadata?: any;
  timestamp: number;
}

type StoredMemory = {
  id: string;
  text: string;
  embedding: number[];
  metadata?: any;
  timestamp: number;
  provider: 'byteplus' | 'local';
  model?: string;
};

// 记忆增强系统接口
export interface MemoryEnhancementSystem {
  initialize(): Promise<void>;
  addMemory(text: string, metadata?: any): Promise<string>;
  searchMemories(query: string, limit?: number): Promise<MemoryResult[]>;
  clearMemories(): Promise<void>;
}

class PersistentMemoryIndex {
  private readonly filePath: string;

  constructor(cwd: string) {
    this.filePath = join(resolveDataRootDir(cwd), 'enhanced-memory.json');
  }

  async load(): Promise<StoredMemory[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoredMemory[];
      return Array.isArray(parsed)
        ? parsed.filter((entry) => Array.isArray(entry.embedding) && typeof entry.text === 'string')
        : [];
    } catch {
      return [];
    }
  }

  async save(entries: StoredMemory[]): Promise<void> {
    await ensureDir(dirname(this.filePath));
    await writeFile(this.filePath, JSON.stringify(entries, null, 2), 'utf8');
  }

  async add(entry: StoredMemory): Promise<void> {
    const existing = await this.load();
    const normalized = entry.text.trim().toLowerCase();
    const deduped = existing.filter((item) => item.text.trim().toLowerCase() !== normalized);
    await this.save([entry, ...deduped].slice(0, 500));
  }

  async clear(): Promise<void> {
    await this.save([]);
  }
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl || DEFAULT_BYTEPLUS_CONFIG.baseUrl).replace(/\/+$/, '');
}

function createMemoryId(): string {
  return `memory-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i += 1) {
    const a = vecA[i] ?? 0;
    const b = vecB[i] ?? 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tokenizeForLocalEmbedding(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = lower.match(/[\p{Script=Han}]|[\p{L}\p{N}_]+/gu) ?? [];
  if (tokens.length > 0) return tokens;
  return lower.split(/\s+/).filter(Boolean);
}

function generateLocalEmbedding(text: string): number[] {
  const dimensions = 512;
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = tokenizeForLocalEmbedding(text);
  for (const token of tokens) {
    const index = hashString(token) % dimensions;
    const sign = hashString(`sign:${token}`) % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

function rankMemories(entries: StoredMemory[], queryEmbedding: number[], limit: number): MemoryResult[] {
  return entries
    .filter((memory) => memory.embedding.length === queryEmbedding.length)
    .map((memory) => ({
      id: memory.id,
      text: memory.text,
      similarity: cosineSimilarity(queryEmbedding, memory.embedding),
      metadata: memory.metadata,
      timestamp: memory.timestamp,
    }))
    .filter((result) => result.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity || b.timestamp - a.timestamp)
    .slice(0, limit);
}

// BytePlus 记忆增强实现
export class BytePlusMemoryEnhancement implements MemoryEnhancementSystem {
  private config: MemoryEnhancementConfig;
  private index: PersistentMemoryIndex;
  
  constructor(config: MemoryEnhancementConfig, cwd: string) {
    this.config = config;
    this.index = new PersistentMemoryIndex(cwd);
  }
  
  async initialize(): Promise<void> {
    // 验证配置
    if (!this.config.enabled || this.config.provider !== 'byteplus') {
      throw new Error('BytePlus memory enhancement is not enabled or incorrectly configured');
    }
    
    if (!this.config.config?.apiKey) {
      throw new Error('BytePlus API key is required');
    }
  }
  
  async addMemory(text: string, metadata?: any): Promise<string> {
    const id = createMemoryId();
    const embedding = await this.generateEmbedding(text);
    await this.index.add({
      id,
      text,
      embedding,
      metadata,
      timestamp: Date.now(),
      provider: 'byteplus',
      model: this.config.config?.model ?? DEFAULT_BYTEPLUS_CONFIG.model,
    });
    
    return id;
  }
  
  async searchMemories(query: string, limit = 5): Promise<MemoryResult[]> {
    const queryEmbedding = await this.generateEmbedding(query);
    return rankMemories(await this.index.load(), queryEmbedding, limit);
  }
  
  async clearMemories(): Promise<void> {
    await this.index.clear();
  }
  
  private async generateEmbedding(text: string): Promise<number[]> {
    const response = await fetch(`${normalizeBaseUrl(this.config.config?.baseUrl)}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.config?.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.config?.model,
        input: text
      })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to generate embedding: ${response.statusText}`);
    }
    
    const data = await response.json() as { data?: Array<{ embedding?: unknown }> };
    const embedding = data.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === 'number')) {
      throw new Error('BytePlus embedding response did not include a numeric embedding vector');
    }
    return embedding;
  }
}

// 本地记忆增强实现
export class LocalMemoryEnhancement implements MemoryEnhancementSystem {
  private config: MemoryEnhancementConfig;
  private index: PersistentMemoryIndex;
  
  constructor(config: MemoryEnhancementConfig, cwd: string) {
    this.config = config;
    this.index = new PersistentMemoryIndex(cwd);
  }
  
  async initialize(): Promise<void> {
    if (!this.config.enabled || this.config.provider !== 'local') {
      throw new Error('Local memory enhancement is not enabled or incorrectly configured');
    }
    await this.index.load();
  }
  
  async addMemory(text: string, metadata?: any): Promise<string> {
    const id = createMemoryId();
    await this.index.add({
      id,
      text,
      embedding: generateLocalEmbedding(text),
      metadata,
      timestamp: Date.now(),
      provider: 'local',
      model: this.config.config?.model ?? DEFAULT_LOCAL_CONFIG.model,
    });
    
    return id;
  }
  
  async searchMemories(query: string, limit = 5): Promise<MemoryResult[]> {
    return rankMemories(await this.index.load(), generateLocalEmbedding(query), limit);
  }
  
  async clearMemories(): Promise<void> {
    await this.index.clear();
  }
}

// 记忆增强系统工厂
export class MemoryEnhancementFactory {
  static async create(config: MemoryEnhancementConfig, cwd = process.cwd()): Promise<MemoryEnhancementSystem> {
    if (!config.enabled || config.provider === 'none') {
      return new NullMemoryEnhancement();
    }
    
    switch (config.provider) {
      case 'byteplus':
        return new BytePlusMemoryEnhancement(config, cwd);
      case 'local':
        return new LocalMemoryEnhancement(config, cwd);
      default:
        return new NullMemoryEnhancement();
    }
  }
}

// 空实现（禁用时使用）
class NullMemoryEnhancement implements MemoryEnhancementSystem {
  async initialize(): Promise<void> {}
  
  async addMemory(text: string, metadata?: any): Promise<string> {
    return Promise.resolve('null');
  }
  
  async searchMemories(query: string, limit?: number): Promise<MemoryResult[]> {
    return Promise.resolve([]);
  }
  
  async clearMemories(): Promise<void> {}
}

// 配置管理
export async function getMemoryProfile(cwd: string): Promise<MemoryEnhancementConfig> {
  const store = new ProviderStore(cwd);
  const data = await store.load();
  if (data.memoryProfile) {
    return data.memoryProfile;
  }
  
  return DEFAULT_MEMORY_CONFIG;
}

export async function saveMemoryProfile(cwd: string, config: MemoryEnhancementConfig): Promise<void> {
  const store = new ProviderStore(cwd);
  const data = await store.load();
  data.memoryProfile = config;
  if (data.setup) {
    data.setup.tools.enabled.memory = config.enabled;
  }
  await store.save(data);
}
