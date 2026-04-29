/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars, @typescript-eslint/no-var-requires */
import type { ToolDefinition } from './toolDef.js';
import type { AgentAction } from './types.js';
import { getToolDefinition, toolDefs } from '../tools/registry.js';
import { executeAction } from '../tools/index.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillAdapterManager } from './externalSkillAdapter.js';

/**
 * Per-skill cache entry. Keyed by absolute skill directory path.
 * mtimeMs is the modification time of the primary skill file (SKILL.json
 * preferred, falling back to SKILL.md). On startup, if mtime matches the
 * cache, we skip reading + parsing the file entirely — a massive win when
 * loading 999 skills.
 */
interface SkillCacheEntry {
  mtimeMs: number;
  source: 'json' | 'md' | 'adapter';
  def: any;
}

const SKILL_CACHE_FILE = path.join(os.homedir(), '.artemis', 'skills.cache.json');

async function loadSkillCache(): Promise<Record<string, SkillCacheEntry>> {
  try {
    const content = await fsp.readFile(SKILL_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(content) as Record<string, SkillCacheEntry>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveSkillCache(cache: Record<string, SkillCacheEntry>): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(SKILL_CACHE_FILE), { recursive: true });
    await fsp.writeFile(SKILL_CACHE_FILE, JSON.stringify(cache), 'utf8');
  } catch {
    /* non-fatal — cache is optimization */
  }
}

/**
 * 技能定义接口 - 增强版本
 */
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  tags?: string[];
  entryPoint: string;
  prerequisites?: string[];
  inputs?: Array<{
    name: string;
    type: string;
    description: string;
    required?: boolean;
    default?: any;
    enum?: any[];
    schema?: any;
  }>;
  outputs?: Array<{
    name: string;
    type: string;
    description: string;
    schema?: any;
  }>;
  dependencies?: string[];
  createdAt: string;
  updatedAt: string;
  category?: string;
  difficulty?: 'beginner' | 'intermediate' | 'advanced';
  examples?: Array<{
    input: any;
    output: any;
    description: string;
  }>;
}

/**
 * 技能执行上下文 - 增强版本
 */
export interface SkillExecutionContext {
  cwd: string;
  workingDirectory: string;
  environmentVariables: Record<string, string>;
  tools: ToolDefinition[];
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
    debug: (message: string) => void;
  };
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, any>;
}

/**
 * 技能执行结果 - 增强版本
 */
export interface SkillExecutionResult {
  success: boolean;
  output?: any;
  error?: string;
  duration?: number;
  logs?: string[];
  metrics?: Record<string, any>;
}

/**
 * 技能管理器类 - 实现完整的技能管理
 */
export class SkillManager {
  private skills: Map<string, SkillDefinition> = new Map();
  private skillDefinitions: Map<string, any> = new Map();
  private _readyPromise: Promise<void>;

  /**
   * 构造函数 - 自动加载技能
   * Async initialization runs in the background. Call `ready()` to await it
   * before reading skills (avoids races when querying right after construction).
   */
  constructor() {
    this._readyPromise = this.loadSkills().catch((error) => {
      console.error('Failed to initialize SkillManager:', error);
    });
  }

  /** Resolves when initial skill loading is complete. */
  async ready(): Promise<void> {
    return this._readyPromise;
  }
  
  /**
   * Load all skill definitions from the skills directory.
   *
   * Performance: with 999+ skills, the previous synchronous-sequential loader
   * blocked CLI startup for several seconds. This implementation:
   *   1. Reads dirents asynchronously
   *   2. Loads each skill in parallel via Promise.all
   *   3. Uses an mtime cache (~/.artemis/skills.cache.json) so unchanged
   *      skills skip the parse entirely on subsequent startups
   *
   * Cache invalidation: each skill dir's primary file (SKILL.json or
   * SKILL.md) mtime is the cache key. If mtime matches, we use the cached
   * SkillDefinition without re-reading or parsing.
   */
  private async loadSkills(): Promise<void> {
    // Locate skills directory (package install location, then cwd fallback)
    let skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills');
    if (!fs.existsSync(skillsDir)) {
      skillsDir = path.resolve(process.cwd(), 'skills');
    }
    if (!fs.existsSync(skillsDir)) {
      console.warn(`Skills directory not found: ${skillsDir}`);
      return;
    }

    const cache = await loadSkillCache();
    const newCache: Record<string, SkillCacheEntry> = {};

    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(skillsDir, { withFileTypes: true });
    } catch (error) {
      console.warn(`Failed to read skills directory: ${skillsDir}`, error);
      return;
    }

    const skillDirs = entries
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => path.join(skillsDir, dirent.name));

    // Parallel load — 999 skills * ~3ms each in parallel ≈ 50-100ms total
    const loaded = await Promise.all(
      skillDirs.map((skillDir) => this.loadOneSkill(skillDir, cache)),
    );

    let validCount = 0;
    let invalidCount = 0;
    for (const result of loaded) {
      if (!result) continue;
      const def = result.def;
      if (def && def.id && def.name && def.description && def.version) {
        this.addSkillDefinition(def);
        this.skillDefinitions.set(def.id, def);
        newCache[result.skillDir] = {
          mtimeMs: result.mtimeMs,
          source: result.source,
          def,
        };
        validCount += 1;
      } else {
        invalidCount += 1;
      }
    }

    // Persist updated cache (best-effort)
    await saveSkillCache(newCache);

    if (invalidCount > 0) {
      console.warn(`SkillManager: loaded ${validCount} skills, ${invalidCount} invalid definitions skipped`);
    }
  }

  /**
   * Load a single skill directory. Tries (in order):
   *   1. mtime cache hit → return cached def
   *   2. SKILL.json
   *   3. SKILL.md (with basic markdown parser)
   *   4. SkillAdapterManager (external formats)
   */
  private async loadOneSkill(
    skillDir: string,
    cache: Record<string, SkillCacheEntry>,
  ): Promise<{ skillDir: string; mtimeMs: number; source: 'json' | 'md' | 'adapter'; def: any } | null> {
    // ── Try SKILL.json ─────────────────────────────────────────────────────
    const jsonFile = path.join(skillDir, 'SKILL.json');
    try {
      const stat = await fsp.stat(jsonFile);
      const mtimeMs = stat.mtimeMs;
      const cached = cache[skillDir];
      if (cached && cached.source === 'json' && cached.mtimeMs === mtimeMs && cached.def) {
        return { skillDir, mtimeMs, source: 'json', def: cached.def };
      }
      const content = await fsp.readFile(jsonFile, 'utf8');
      try {
        const def = JSON.parse(content);
        return { skillDir, mtimeMs, source: 'json', def };
      } catch (error) {
        console.warn(`Failed to parse skill JSON: ${jsonFile}`, error);
        // fall through to .md fallback
      }
    } catch {
      /* SKILL.json absent — try .md */
    }

    // ── Try SKILL.md ───────────────────────────────────────────────────────
    const mdFile = path.join(skillDir, 'SKILL.md');
    try {
      const stat = await fsp.stat(mdFile);
      const mtimeMs = stat.mtimeMs;
      const cached = cache[skillDir];
      if (cached && cached.source === 'md' && cached.mtimeMs === mtimeMs && cached.def) {
        return { skillDir, mtimeMs, source: 'md', def: cached.def };
      }
      const mdContent = await fsp.readFile(mdFile, 'utf8');
      const def = this.parseSkillFromMarkdown(mdContent, path.basename(skillDir));
      if (def) return { skillDir, mtimeMs, source: 'md', def };
    } catch {
      /* SKILL.md absent — try adapter */
    }

    // ── Try external adapter (rare path; not cached because mtime is hard
    // to attribute to a single file) ──────────────────────────────────────
    try {
      const adapterManager = new SkillAdapterManager();
      const def = await adapterManager.loadExternalSkill(skillDir);
      if (def) return { skillDir, mtimeMs: 0, source: 'adapter', def };
    } catch {
      /* not adaptable */
    }

    return null;
  }
  
  /**
   * 从 Markdown 文件中解析技能定义
   */
  private parseSkillFromMarkdown(mdContent: string, defaultId: string): SkillDefinition | null {
    // 提取技能名称和描述（简单的解析逻辑）
    const nameMatch = mdContent.match(/^#\s*(.*)$/m);
    const descriptionMatch = mdContent.match(/^Artemis.*?skill\.?(.*)$/);
    
    const name = nameMatch ? nameMatch[1].trim() : defaultId;
    let description = descriptionMatch ? descriptionMatch[1].trim().replace(/\n\s*/g, ' ') : 'No description available';
    
    // 移除可能的换行符和多余的空格
    description = description.replace(/\s+/g, ' ').trim();
    
    return {
      id: defaultId,
      name: name,
      description: description,
      version: '1.0.0',
      author: 'Artemis',
      tags: [],
      entryPoint: 'tool_chain', // 默认入口点
      prerequisites: [],
      inputs: [],
      outputs: [],
      dependencies: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      category: 'design',
      difficulty: 'intermediate',
      examples: []
    };
  }

  /**
   * 添加技能定义
   */
  addSkillDefinition(skillDefinition: SkillDefinition): void {
    this.skills.set(skillDefinition.id, skillDefinition);
  }

  /**
   * 添加技能
   */
  addSkill(skillDefinition: SkillDefinition): void {
    this.addSkillDefinition(skillDefinition);
  }

  /**
   * 获取技能定义
   */
  getSkillDefinition(id: string): SkillDefinition | undefined {
    return this.skills.get(id);
  }

  /**
   * 获取所有技能定义
   */
  getAllSkillDefinitions(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /**
   * 获取所有技能
   */
  getSkills(): SkillDefinition[] {
    return this.getAllSkillDefinitions();
  }

  /**
   * 查找技能
   */
  findSkill(id: string): SkillDefinition | undefined {
    return this.getSkillDefinition(id);
  }

  /**
   * 搜索技能
   */
  searchSkills(keyword: string): SkillDefinition[] {
    const searchLower = keyword.toLowerCase();
    return this.getAllSkillDefinitions().filter(skill => 
      skill.name.toLowerCase().includes(searchLower) ||
      skill.description.toLowerCase().includes(searchLower) ||
      (skill.tags && skill.tags.some(tag => tag.toLowerCase().includes(searchLower)))
    );
  }

  /**
   * 查找技能
   */
  findSkillsByTag(tag: string): SkillDefinition[] {
    return Array.from(this.skills.values()).filter(
      (skill) => skill.tags && skill.tags.includes(tag)
    );
  }

  /**
   * 查找技能
   */
  findSkillsByName(name: string): SkillDefinition[] {
    const searchTerm = name.toLowerCase();
    return Array.from(this.skills.values()).filter(
      (skill) => 
        skill.name.toLowerCase().includes(searchTerm) || 
        skill.description.toLowerCase().includes(searchTerm)
    );
  }

  /**
   * 查找技能
   */
  findSkillsByCategory(category: string): SkillDefinition[] {
    return Array.from(this.skills.values()).filter(
      (skill) => skill.category === category
    );
  }

  /**
   * 验证技能依赖
   */
  validateDependencies(skillId: string): string[] {
    const skill = this.getSkillDefinition(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    const missingDependencies: string[] = [];
    
    if (skill.dependencies) {
      for (const dep of skill.dependencies) {
        if (!this.skills.has(dep)) {
          missingDependencies.push(dep);
        }
      }
    }

    if (skill.prerequisites) {
      for (const prereq of skill.prerequisites) {
        // 检查前置工具是否可用
        const tool = getToolDefinition(prereq);
        if (!tool) {
          missingDependencies.push(prereq);
        }
      }
    }

    return missingDependencies;
  }

  /**
   * 执行技能
   */
  async executeSkill(
    skillId: string,
    inputs: any,
    context: SkillExecutionContext
  ): Promise<SkillExecutionResult> {
    const startTime = Date.now();

    try {
      // 验证技能依赖
      const missingDependencies = this.validateDependencies(skillId);
      if (missingDependencies.length > 0) {
        throw new Error(`Missing dependencies: ${missingDependencies.join(', ')}`);
      }

      const skill = this.getSkillDefinition(skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${skillId}`);
      }

      if (context && context.logger && context.logger.info) {
        context.logger.info(`Executing skill: ${skill.name} (${skill.version})`);
      }

      // 验证输入
      if (skill.inputs) {
        for (const input of skill.inputs) {
          if (input.required && !(input.name in inputs)) {
            throw new Error(`Missing required input: ${input.name}`);
          }
        }
      }

      // 执行技能
      const result = await this.executeSkillImplementation(skillId, inputs, context);

      const duration = Date.now() - startTime;
      if (context && context.logger && context.logger.info) {
        context.logger.info(`Skill completed in ${duration}ms`);
      }

      return {
        success: true,
        output: result,
        duration,
        logs: [
          `Skill ${skill.name} executed successfully`,
          `Duration: ${duration}ms`,
        ],
        metrics: {
          duration,
          inputs: Object.keys(inputs).length,
          skillId,
          skillName: skill.name,
        },
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (context && context.logger && context.logger.error) {
        context.logger.error(`Skill execution failed: ${errorMessage}`);
      }

      return {
        success: false,
        error: errorMessage,
        duration,
        logs: [
          `Skill execution failed: ${errorMessage}`,
          `Duration: ${duration}ms`,
        ],
        metrics: {
          duration,
          skillId,
          error: errorMessage,
        },
      };
    }
  }

  /**
   * 技能实现执行
   */
  private async executeSkillImplementation(
    skillId: string,
    inputs: any,
    context: SkillExecutionContext
  ): Promise<any> {
    const skill = this.getSkillDefinition(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    // 根据入口点类型执行技能
    switch (skill.entryPoint) {
      case 'tool_chain':
        return await this.executeToolChain(skillId, inputs, context);
      
      case 'javascript':
        return await this.executeJavaScriptSkill(skillId, inputs, context);
      
      case 'shell':
        return await this.executeShellSkill(skillId, inputs, context);
      
      default:
        throw new Error(`Unsupported entry point type: ${skill.entryPoint}`);
    }
  }

  /**
   * 执行工具链技能
   */
  private async executeToolChain(
    skillId: string,
    inputs: any,
    context: SkillExecutionContext
  ): Promise<any> {
    // 从技能定义中获取工具链配置
    const skillConfig = this.skillDefinitions.get(skillId);
    if (!skillConfig || !skillConfig.toolChain) {
      throw new Error(`Tool chain configuration not found for skill: ${skillId}`);
    }

    const toolChain = skillConfig.toolChain;
    let result = inputs;

    // 执行工具链
    for (const step of toolChain) {
      const tool = getToolDefinition(step.tool);
      if (!tool) {
        throw new Error(`Tool not found: ${step.tool}`);
      }

      if (context && context.logger && context.logger.debug) {
        context.logger.debug(`Executing tool: ${step.tool}`);
      }

      // 准备工具输入
      const toolInput = this.resolveInput(step.input, result, inputs);
      
      // 执行工具
      const action: AgentAction = {
        type: step.tool,
        ...toolInput,
      };

      const toolResult = await executeAction(action, context);

      if (!toolResult.ok) {
        throw new Error(`Tool execution failed: ${toolResult.output}`);
      }

      // 处理工具输出
      if (step.output) {
        result = this.resolveOutput(step.output, toolResult, result);
      } else {
        result = toolResult;
      }
    }

    return result;
  }

  /**
   * 执行 JavaScript 技能
   */
  private async executeJavaScriptSkill(
    skillId: string,
    inputs: any,
    context: SkillExecutionContext
  ): Promise<any> {
    const skillConfig = this.skillDefinitions.get(skillId);
    if (!skillConfig || !skillConfig.code) {
      throw new Error(`JavaScript code not found for skill: ${skillId}`);
    }

    // 在安全的上下文中执行 JavaScript 代码
    try {
      // 创建沙箱环境
      const sandbox = {
        inputs,
        context,
        executeAction,
        getToolDefinition,
        console: context.logger,
      };

      // 编译并执行代码
      const codeFunction = new Function('sandbox', `
        with(sandbox) {
          ${skillConfig.code}
        }
      `);

      return await codeFunction(sandbox);
    } catch (error) {
      throw new Error(`JavaScript execution failed: ${(error as Error).message}`);
    }
  }

  /**
   * 执行 Shell 技能
   */
  private async executeShellSkill(
    skillId: string,
    inputs: any,
    context: SkillExecutionContext
  ): Promise<any> {
    const skillConfig = this.skillDefinitions.get(skillId);
    if (!skillConfig || !skillConfig.script) {
      throw new Error(`Shell script not found for skill: ${skillId}`);
    }

    // 准备并执行 Shell 脚本
    const scriptPath = this.resolveScriptPath(skillId);
    if (!scriptPath) {
      throw new Error(`Script path not found for skill: ${skillId}`);
    }

    // 这里应该调用系统命令执行脚本
    // 为了安全，我们需要限制脚本执行的范围
    throw new Error('Shell script execution not implemented yet');
  }

  /**
   * 解析输入值
   */
  private resolveInput(
    inputConfig: any,
    previousResult: any,
    initialInputs: any
  ): any {
    if (typeof inputConfig === 'string') {
      // 支持简单的模板解析
      return inputConfig
        .replace(/\${(.*?)}/g, (_, key) => {
          const [source, property] = key.split('.');
          let value: any;
          
          if (source === 'inputs') {
            value = initialInputs;
          } else if (source === 'result') {
            value = previousResult;
          } else {
            return `\${${key}}`;
          }

          if (property) {
            value = value[property];
          }
          
          return String(value || '');
        });
    }
    
    return inputConfig;
  }

  /**
   * 解析输出值
   */
  private resolveOutput(
    outputConfig: any,
    toolResult: any,
    previousResult: any
  ): any {
    if (typeof outputConfig === 'string') {
      // 支持简单的模板解析
      return outputConfig
        .replace(/\${(.*?)}/g, (_, key) => {
          const [source, property] = key.split('.');
          let value: any;
          
          if (source === 'tool') {
            value = toolResult;
          } else if (source === 'result') {
            value = previousResult;
          } else {
            return `\${${key}}`;
          }

          if (property) {
            value = value[property];
          }
          
          return String(value || '');
        });
    }
    
    return outputConfig;
  }

  /**
   * 解析脚本路径
   */
  private resolveScriptPath(skillId: string): string | null {
    // 从技能定义中获取脚本路径
    const skill = this.getSkillDefinition(skillId);
    if (!skill) {
      return null;
    }

    // 这里应该从配置文件或数据库中获取脚本路径
    const skillConfig = this.skillDefinitions.get(skillId);
    if (skillConfig && skillConfig.scriptPath) {
      return skillConfig.scriptPath;
    }

    // 尝试从标准位置查找
    const possiblePaths = [
      `./skills/${skillId}/main.sh`,
      `./skills/${skillId}.sh`,
      `/usr/local/bin/artemis-skills/${skillId}.sh`,
    ];

    for (const path of possiblePaths) {
      if (this.fileExists(path)) {
        return path;
      }
    }

    return null;
  }

  /**
   * 检查文件是否存在
   */
  private fileExists(path: string): boolean {
    try {
      const fs = require('fs');
      return fs.existsSync(path);
    } catch (error) {
      return false;
    }
  }

  /**
   * 加载技能配置
   */
  async loadSkillConfig(skillId?: string, config?: any): Promise<void> {
    // 如果提供了配置，直接使用
    if (skillId && config) {
      this.skillDefinitions.set(skillId, config);
      this.addSkillDefinition(config);
      return;
    }
    
    // 从文件系统加载技能配置
    const fs = require('fs');
    const path = require('path');
    
    const skillsDir = path.join(process.cwd(), 'skills');
    if (fs.existsSync(skillsDir)) {
      const skillFiles = fs.readdirSync(skillsDir);
      
      for (const file of skillFiles) {
        if (file.endsWith('.json')) {
          const skillPath = path.join(skillsDir, file);
          const skillConfig = JSON.parse(fs.readFileSync(skillPath, 'utf8'));
          
          this.skillDefinitions.set(skillConfig.id, skillConfig);
          this.addSkillDefinition(skillConfig);
        }
      }
    }
  }

  /**
   * 保存技能配置
   */
  async saveSkillConfig(): Promise<void> {
    const fs = require('fs');
    const path = require('path');
    
    const skillsDir = path.join(process.cwd(), 'skills');
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }
    
    for (const [skillId, skillConfig] of Array.from(this.skillDefinitions.entries())) {
      const skillPath = path.join(skillsDir, `${skillId}.json`);
      fs.writeFileSync(skillPath, JSON.stringify(skillConfig, null, 2));
    }
  }

  /**
   * 导出技能配置
   */
  async exportSkillConfig(): Promise<string> {
    return JSON.stringify(Object.fromEntries(this.skillDefinitions.entries()), null, 2);
  }

  /**
   * 导入技能配置
   */
  async importSkillConfig(config: string): Promise<void> {
    const skillConfigs = JSON.parse(config);
    
    for (const [skillId, skillConfig] of Object.entries(skillConfigs)) {
      const typedConfig = skillConfig as SkillDefinition;
      this.skillDefinitions.set(skillId, typedConfig);
      this.addSkillDefinition(typedConfig);
    }
  }
}
