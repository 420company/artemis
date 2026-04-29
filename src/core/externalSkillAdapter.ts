/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars, @typescript-eslint/no-var-requires, prefer-const */
import { readdir, readFile } from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathExists } from '../utils/fs.js';

// 外部技能定义接口
export interface ExternalSkill {
  id: string;
  name: string;
  title: string;
  description?: string;
  source: string;
  dirPath: string;
  skillPath: string;
  format: 'claude' | 'openclaw' | 'custom';
  version?: string;
}

// 验证结果接口
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

// 技能适配器接口
export interface SkillAdapter {
  format: 'claude' | 'openclaw' | 'custom';
  supportsDirectory(directory: string): Promise<boolean>;
  discoverSkills(directory: string): Promise<ExternalSkill[]>;
  validate(skill: ExternalSkill): Promise<ValidationResult>;
  convert(skill: ExternalSkill): Promise<any>;
}

// 技能适配器基类
export abstract class BaseSkillAdapter implements SkillAdapter {
  abstract format: 'claude' | 'openclaw' | 'custom';
  
  async supportsDirectory(directory: string): Promise<boolean> {
    const hasSkillFile = await this.hasSkillFile(directory);
    const hasRequiredFiles = await this.hasRequiredFiles(directory);
    return hasSkillFile && hasRequiredFiles;
  }
  
  async discoverSkills(directory: string): Promise<ExternalSkill[]> {
    const skills: ExternalSkill[] = [];
    
    if (await this.supportsDirectory(directory)) {
      const skillName = path.basename(directory);
      const skill = await this.loadSkill(directory, skillName);
      skills.push(skill);
    } else {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDirPath = path.join(directory, entry.name);
          if (await this.supportsDirectory(subDirPath)) {
            const skill = await this.loadSkill(subDirPath, entry.name);
            skills.push(skill);
          }
        }
      }
    }
    
    return skills;
  }
  
  abstract hasSkillFile(directory: string): Promise<boolean>;
  abstract hasRequiredFiles(directory: string): Promise<boolean>;
  abstract loadSkill(directory: string, name: string): Promise<ExternalSkill>;
  abstract validate(skill: ExternalSkill): Promise<ValidationResult>;
  abstract convert(skill: ExternalSkill): Promise<any>;
}

// Claude Code 技能适配器
export class ClaudeCodeSkillAdapter extends BaseSkillAdapter {
  format = 'claude' as const;
  
  async hasSkillFile(directory: string): Promise<boolean> {
    // Claude 官方技能通常包含 SKILL.md 文件
    return await pathExists(path.join(directory, 'SKILL.md'));
  }
  
  async hasRequiredFiles(directory: string): Promise<boolean> {
    // Claude 官方技能至少需要包含 SKILL.md 文件
    return await this.hasSkillFile(directory);
  }
  
  async loadSkill(directory: string, name: string): Promise<ExternalSkill> {
    let skillData: any = {
      id: name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'),
      name,
      title: name,
      description: 'Claude Code 技能',
      source: directory,
      dirPath: directory,
      skillPath: path.join(directory, 'SKILL.md'),
      format: 'claude' as const,
      version: '1.0.0'
    };
    
    // 尝试从 SKILL.md 中提取技能信息
    const mdPath = path.join(directory, 'SKILL.md');
    if (fs.existsSync(mdPath)) {
      try {
        const content = fs.readFileSync(mdPath, 'utf8');
        // 尝试从 YAML 前导内容中提取描述
        const yamlMatch = content.match(/---\s*([\s\S]*?)\s*---/);
        if (yamlMatch) {
          try {
            // 使用简单的字符串解析 YAML
            const frontmatter = yamlMatch[1];
            const nameMatch = frontmatter.match(/name:\s*(.*)/);
            const descriptionMatch = frontmatter.match(/description:\s*(.*)/);
            const versionMatch = frontmatter.match(/version:\s*(.*)/);
            
            if (nameMatch) {
              const extractedName = nameMatch[1].trim().replace(/^['"](.*)['"]$/, '$1');
              skillData.id = extractedName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
              skillData.name = extractedName;
              skillData.title = extractedName;
            }
            
            if (descriptionMatch) {
              skillData.description = descriptionMatch[1].trim().replace(/^['"](.*)['"]$/, '$1');
            }
            
            if (versionMatch) {
              skillData.version = versionMatch[1].trim().replace(/^['"](.*)['"]$/, '$1');
            }
          } catch (yamlError) {
            console.debug('Failed to parse YAML frontmatter:', yamlError);
          }
        }
      } catch (error) {
        console.warn(`Failed to read SKILL.md: ${error}`);
      }
    }
    
    // 尝试从 package.json 或其他配置文件中提取信息
    const packageJsonPath = path.join(directory, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageContent = fs.readFileSync(packageJsonPath, 'utf8');
        const packageData = JSON.parse(packageContent);
        if (packageData.name && !skillData.name) {
          skillData.name = packageData.name;
          skillData.title = packageData.name;
          skillData.id = packageData.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
        }
        if (packageData.description && !skillData.description) {
          skillData.description = packageData.description;
        }
        if (packageData.version && !skillData.version) {
          skillData.version = packageData.version;
        }
      } catch (error) {
        console.debug('Failed to parse package.json:', error);
      }
    }
    
    return skillData;
  }
  
  async validate(skill: ExternalSkill): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // 验证技能基本信息
    if (!skill.id) errors.push('缺少技能ID');
    if (!skill.name) errors.push('缺少技能名称');
    if (!skill.title) warnings.push('缺少技能标题');
    if (!skill.description) warnings.push('缺少技能描述');
    
    // 验证 SKILL.md
    const mdPath = path.join(skill.dirPath, 'SKILL.md');
    if (fs.existsSync(mdPath)) {
      try {
        const content = fs.readFileSync(mdPath, 'utf8');
        if (content.length === 0) warnings.push('SKILL.md 文件为空');
      } catch (error) {
        warnings.push(`SKILL.md 无法读取: ${error}`);
      }
    } else {
      errors.push('SKILL.md 文件不存在');
    }
    
    // 验证技能目录结构
    const requiredResources = ['scripts', 'templates', 'examples', 'references'];
    for (const resource of requiredResources) {
      const resourcePath = path.join(skill.dirPath, resource);
      if (fs.existsSync(resourcePath)) {
        if (!fs.statSync(resourcePath).isDirectory()) {
          warnings.push(`${resource} 应该是一个目录`);
        }
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }
  
  async convert(skill: ExternalSkill): Promise<any> {
    // 解析 SKILL.md 描述
    let description = skill.description;
    const mdPath = path.join(skill.dirPath, 'SKILL.md');
    if (fs.existsSync(mdPath)) {
      try {
        const content = fs.readFileSync(mdPath, 'utf8');
        // 尝试从 YAML 前导内容中提取描述
        const yamlMatch = content.match(/---\s*([\s\S]*?)\s*---/);
        if (yamlMatch) {
          try {
            const frontmatter = yamlMatch[1];
            const descriptionMatch = frontmatter.match(/description:\s*(.*)/);
            if (descriptionMatch) {
              description = descriptionMatch[1].trim().replace(/^['"](.*)['"]$/, '$1');
            }
          } catch (yamlError) {
            console.debug('Failed to parse YAML frontmatter:', yamlError);
          }
        }
      } catch (error) {
        console.warn(`Failed to read SKILL.md: ${error}`);
      }
    }
    
    // 分析技能内容以识别工具链需求
    const toolChain = this.analyzeToolRequirements(skill.dirPath);
    
    // 识别输入输出参数
    const inputs = this.identifyInputs(skill.dirPath);
    const outputs = this.identifyOutputs(skill.dirPath);
    
    // 提取技能触发词和关键词
    const keywords = this.extractKeywords(skill.dirPath);
    
    // 构建内部技能格式
    const internalSkill = {
      id: skill.id,
      name: skill.name,
      version: skill.version || '1.0.0',
      description: description,
      inputs: inputs,
      outputs: outputs,
      entryPoint: 'tool_chain',
      toolChain: toolChain,
      resources: this.getResourceList(skill.dirPath),
      keywords: keywords,
      category: this.identifyCategory(skill.dirPath),
      language: this.identifyLanguage(skill.dirPath),
      dependencies: this.identifyDependencies(skill.dirPath)
    };
    
    return internalSkill;
  }
  
  private extractKeywords(directory: string): string[] {
    const keywords = [];
    const directoryName = path.basename(directory).toLowerCase();
    
    // 从目录名提取关键词
    const dirKeywords = directoryName.split(/[-_]/);
    keywords.push(...dirKeywords);
    
    // 从 SKILL.md 提取关键词
    const mdPath = path.join(directory, 'SKILL.md');
    if (fs.existsSync(mdPath)) {
      try {
        const content = fs.readFileSync(mdPath, 'utf8');
        // 查找关键词部分（通常在 SKILL.md 中有 Keywords 部分）
        const keywordsMatch = content.match(/\*\*Keywords\*\*:\s*(.*?)(\n\n|$)/);
        if (keywordsMatch) {
          const extractedKeywords = keywordsMatch[1]
            .split(/[,;]/)
            .map(k => k.trim())
            .filter(k => k.length > 0);
          keywords.push(...extractedKeywords);
        }
      } catch (error) {
        console.debug('Failed to extract keywords:', error);
      }
    }
    
    // 去除重复
    return Array.from(new Set(keywords)).filter(k => k.length > 0);
  }
  
  private identifyCategory(directory: string): string {
    const directoryName = path.basename(directory).toLowerCase();
    
    if (directoryName.includes('api') || directoryName.includes('code')) {
      return 'development';
    } else if (directoryName.includes('art') || directoryName.includes('design') || 
               directoryName.includes('canvas') || directoryName.includes('theme')) {
      return 'design';
    } else if (directoryName.includes('docx') || directoryName.includes('pdf') || 
               directoryName.includes('pptx') || directoryName.includes('xlsx')) {
      return 'documents';
    } else if (directoryName.includes('frontend') || directoryName.includes('web')) {
      return 'web';
    } else if (directoryName.includes('slack') || directoryName.includes('comms')) {
      return 'communication';
    } else {
      return 'general';
    }
  }
  
  private identifyLanguage(directory: string): string {
    // 检查技能主要使用的编程语言
    const pythonFiles = this.findFilesByExtension(directory, '.py');
    const jsFiles = this.findFilesByExtension(directory, '.js');
    const tsFiles = this.findFilesByExtension(directory, '.ts');
    const javaFiles = this.findFilesByExtension(directory, '.java');
    const goFiles = this.findFilesByExtension(directory, '.go');
    const rubyFiles = this.findFilesByExtension(directory, '.rb');
    const phpFiles = this.findFilesByExtension(directory, '.php');
    const csFiles = this.findFilesByExtension(directory, '.cs');
    
    if (pythonFiles.length > 0) return 'python';
    if (jsFiles.length > 0 || tsFiles.length > 0) return 'javascript';
    if (javaFiles.length > 0) return 'java';
    if (goFiles.length > 0) return 'go';
    if (rubyFiles.length > 0) return 'ruby';
    if (phpFiles.length > 0) return 'php';
    if (csFiles.length > 0) return 'csharp';
    
    return 'mixed';
  }
  
  private identifyDependencies(directory: string): string[] {
    const dependencies = [];
    
    // 检查 requirements.txt
    const requirementsPath = path.join(directory, 'requirements.txt');
    if (fs.existsSync(requirementsPath)) {
      try {
        const content = fs.readFileSync(requirementsPath, 'utf8');
        const lines = content.split('\n');
        lines.forEach(line => {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            dependencies.push(trimmed.split('==')[0]);
          }
        });
      } catch (error) {
        console.debug('Failed to read requirements.txt:', error);
      }
    }
    
    // 检查 package.json
    const packageJsonPath = path.join(directory, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageContent = fs.readFileSync(packageJsonPath, 'utf8');
        const packageData = JSON.parse(packageContent);
        if (packageData.dependencies) {
          dependencies.push(...Object.keys(packageData.dependencies));
        }
        if (packageData.devDependencies) {
          dependencies.push(...Object.keys(packageData.devDependencies));
        }
      } catch (error) {
        console.debug('Failed to parse package.json:', error);
      }
    }
    
    // 检查 Gemfile（Ruby）
    const gemfilePath = path.join(directory, 'Gemfile');
    if (fs.existsSync(gemfilePath)) {
      try {
        const content = fs.readFileSync(gemfilePath, 'utf8');
        const lines = content.split('\n');
        lines.forEach(line => {
          const match = line.match(/gem\s+['"]([^'"]+)['"]/);
          if (match) {
            dependencies.push(match[1]);
          }
        });
      } catch (error) {
        console.debug('Failed to read Gemfile:', error);
      }
    }
    
    return Array.from(new Set(dependencies));
  }
  
  private analyzeToolRequirements(directory: string): any[] {
    // 分析技能内容以识别潜在的工具需求
    const toolChain = [];
    
    // 检查是否有 Python 脚本
    const pythonFiles = this.findFilesByExtension(directory, '.py');
    if (pythonFiles.length > 0) {
      toolChain.push({
        tool: 'run_command',
        input: {
          command: 'python',
          args: ['-m', 'scripts.main'],
          cwd: directory
        }
      });
    }
    
    // 检查是否有 Node.js 脚本
    const jsFiles = this.findFilesByExtension(directory, '.js');
    const tsFiles = this.findFilesByExtension(directory, '.ts');
    if (jsFiles.length > 0 || tsFiles.length > 0) {
      toolChain.push({
        tool: 'run_command',
        input: {
          command: 'node',
          args: ['index.js'],
          cwd: directory
        }
      });
    }
    
    // 检查是否有 shell 脚本
    const shFiles = this.findFilesByExtension(directory, '.sh');
    if (shFiles.length > 0) {
      toolChain.push({
        tool: 'run_command',
        input: {
          command: 'bash',
          args: ['run.sh'],
          cwd: directory
        }
      });
    }
    
    return toolChain;
  }
  
  private identifyInputs(directory: string): any[] {
    // 识别技能输入参数
    const inputs = [];
    
    // 检查是否有配置文件或模板
    const configFiles = this.findFilesByExtension(directory, '.json');
    const yamlFiles = this.findFilesByExtension(directory, '.yaml');
    const ymlFiles = this.findFilesByExtension(directory, '.yml');
    
    if (configFiles.length + yamlFiles.length + ymlFiles.length > 0) {
      inputs.push({
        name: 'config',
        type: 'string',
        description: '技能配置选项'
      });
    }
    
    // 检查是否有输入模板
    const templateFiles = this.findFilesByExtension(directory, '.template');
    const tmplFiles = this.findFilesByExtension(directory, '.tmpl');
    
    if (templateFiles.length + tmplFiles.length > 0) {
      inputs.push({
        name: 'template',
        type: 'string',
        description: '模板选择'
      });
    }
    
    return inputs;
  }
  
  private identifyOutputs(directory: string): any[] {
    // 识别技能输出
    const outputs = [];
    
    // 检查技能类型以确定可能的输出
    const directoryName = path.basename(directory);
    
    if (directoryName.includes('docx') || directoryName.includes('pdf') || 
        directoryName.includes('pptx') || directoryName.includes('xlsx')) {
      outputs.push({
        name: 'document',
        type: 'string',
        description: '生成的文档文件'
      });
    }
    
    if (directoryName.includes('api')) {
      outputs.push({
        name: 'api_code',
        type: 'string',
        description: 'API 代码实现'
      });
    }
    
    if (directoryName.includes('art') || directoryName.includes('design') || 
        directoryName.includes('canvas')) {
      outputs.push({
        name: 'image',
        type: 'string',
        description: '生成的图像文件'
      });
    }
    
    outputs.push({
      name: 'result',
      type: 'string',
      description: '技能执行结果'
    });
    
    return outputs;
  }
  
  private getResourceList(directory: string): string[] {
    // 获取技能资源列表
    const resources = [];
    
    const entries = fs.readdirSync(directory);
    for (const entry of entries) {
      const entryPath = path.join(directory, entry);
      if (fs.statSync(entryPath).isDirectory() && !entry.startsWith('.')) {
        resources.push(entry);
      }
    }
    
    return resources;
  }
  
  private findFilesByExtension(directory: string, extension: string): string[] {
    // 查找指定扩展名的文件
    const files: string[] = [];
    
    const find = (currentDir: string) => {
      const entries = fs.readdirSync(currentDir);
      for (const entry of entries) {
        const entryPath = path.join(currentDir, entry);
        const stats = fs.statSync(entryPath);
        
        if (stats.isDirectory() && !entry.startsWith('.')) {
          find(entryPath);
        } else if (entryPath.toLowerCase().endsWith(extension)) {
          files.push(entryPath);
        }
      }
    };
    
    find(directory);
    return files;
  }
}

// OpenClaw 技能适配器
export class OpenClawSkillAdapter extends BaseSkillAdapter {
  format = 'openclaw' as const;
  
  async hasSkillFile(directory: string): Promise<boolean> {
    // 真实的 OpenClaw 技能包含以下文件中的任意一个
    const hasConfig = await pathExists(path.join(directory, 'config.json'));
    const hasSkillMd = await pathExists(path.join(directory, 'SKILL.md'));
    const hasMeta = await pathExists(path.join(directory, '_meta.json'));
    
    return hasConfig || hasSkillMd || hasMeta;
  }
  
  async hasRequiredFiles(directory: string): Promise<boolean> {
    // OpenClaw 技能需要包含至少一个配置文件或技能文档
    return await this.hasSkillFile(directory);
  }
  
  async loadSkill(directory: string, name: string): Promise<ExternalSkill> {
    // 从 config.json 和 _meta.json 中提取技能信息
    let skillData: any = {
      id: name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'),
      name,
      title: name,
      description: 'OpenClaw 技能',
      source: directory,
      dirPath: directory,
      skillPath: path.join(directory, 'config.json'),
      format: 'openclaw' as const,
      version: '1.0.0'
    };
    
    // 尝试从 config.json 中读取技能信息
    const configPath = path.join(directory, 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        const configContent = fs.readFileSync(configPath, 'utf8');
        const configData = JSON.parse(configContent);
        if (configData.name) {
          skillData.id = configData.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
          skillData.name = configData.name;
          skillData.title = configData.name;
        }
        if (configData.description) {
          skillData.description = configData.description;
        }
      } catch (error) {
        console.warn(`Failed to read config.json: ${error}`);
      }
    }
    
    // 尝试从 _meta.json 中读取版本信息
    const metaPath = path.join(directory, '_meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        const metaContent = fs.readFileSync(metaPath, 'utf8');
        const metaData = JSON.parse(metaContent);
        if (metaData.version) {
          skillData.version = metaData.version;
        }
        if (metaData.slug && !skillData.name) {
          skillData.name = metaData.slug;
          skillData.title = metaData.slug;
        }
      } catch (error) {
        console.warn(`Failed to read _meta.json: ${error}`);
      }
    }
    
    return skillData;
  }
  
  async validate(skill: ExternalSkill): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // 验证技能基本信息
    if (!skill.id) errors.push('缺少技能ID');
    if (!skill.name) errors.push('缺少技能名称');
    if (!skill.title) warnings.push('缺少技能标题');
    if (!skill.description) warnings.push('缺少技能描述');
    
    // 验证配置文件
    const configPath = path.join(skill.dirPath, 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        const configContent = fs.readFileSync(configPath, 'utf8');
        JSON.parse(configContent);
      } catch (error) {
        errors.push(`config.json 格式错误: ${error}`);
      }
    } else {
      warnings.push('缺少 config.json 配置文件');
    }
    
    // 验证 SKILL.md
    const mdPath = path.join(skill.dirPath, 'SKILL.md');
    if (fs.existsSync(mdPath)) {
      try {
        const content = fs.readFileSync(mdPath, 'utf8');
        if (content.length === 0) warnings.push('SKILL.md 文件为空');
      } catch (error) {
        warnings.push(`SKILL.md 无法读取: ${error}`);
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }
  
  async convert(skill: ExternalSkill): Promise<any> {
    // 解析 config.json 内容
    let configData = {};
    const configPath = path.join(skill.dirPath, 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        const configContent = fs.readFileSync(configPath, 'utf8');
        configData = JSON.parse(configContent);
      } catch (error) {
        console.warn(`Failed to parse config.json: ${error}`);
      }
    }
    
    // 解析 SKILL.md 描述
    let description = skill.description;
    const mdPath = path.join(skill.dirPath, 'SKILL.md');
    if (fs.existsSync(mdPath)) {
      try {
        const content = fs.readFileSync(mdPath, 'utf8');
        // 尝试从 YAML 前导内容中提取描述
        const yamlMatch = content.match(/---\s*([\s\S]*?)\s*---/);
        if (yamlMatch) {
          try {
            const yaml = require('js-yaml');
            const frontmatter = yaml.load(yamlMatch[1]);
            if (frontmatter.description) {
              description = frontmatter.description;
            }
          } catch (yamlError) {
            console.debug('Failed to parse YAML frontmatter:', yamlError);
          }
        }
      } catch (error) {
        console.warn(`Failed to read SKILL.md: ${error}`);
      }
    }
    
    // 构建内部技能格式
    return {
      id: skill.id,
      name: skill.name,
      version: skill.version || '1.0.0',
      description: description,
      inputs: [],
      entryPoint: 'tool_chain',
      toolChain: (configData as any).engines || [] // 使用 config.json 中的 engines 作为工具链
    };
  }
}

// 技能适配器管理器
export class SkillAdapterManager {
  private adapters: SkillAdapter[];
  
  constructor() {
    this.adapters = [
      new ClaudeCodeSkillAdapter(),
      new OpenClawSkillAdapter()
    ];
  }
  
  async findAdapterForDirectory(directory: string): Promise<SkillAdapter | null> {
    for (const adapter of this.adapters) {
      if (await adapter.supportsDirectory(directory)) {
        return adapter;
      }
    }
    return null;
  }
  
  async loadExternalSkill(directory: string): Promise<any> {
    const adapter = await this.findAdapterForDirectory(directory);
    
    if (!adapter) {
      throw new Error(`No compatible adapter found for directory: ${directory}`);
    }
    
    const skills = await adapter.discoverSkills(directory);
    if (skills.length === 0) {
      throw new Error(`No valid skills found in directory: ${directory}`);
    }
    
    const skill = skills[0];
    const validation = await adapter.validate(skill);
    
    if (!validation.isValid) {
      throw new Error(`Invalid external skill: ${validation.errors.join(', ')}`);
    }
    
    return await adapter.convert(skill);
  }
}
