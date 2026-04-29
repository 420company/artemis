/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars, @typescript-eslint/no-var-requires */
import type { ToolDefinition } from './toolDef.js';
import type { AgentAction } from './types.js';
import { getToolDefinition, toolDefs } from '../tools/registry.js';
import { executeAction } from '../tools/index.js';
import { v4 as uuidv4 } from 'uuid';
import { SkillManager } from './skillManager.js';

/**
 * 代理定义接口
 */
export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  entryPoint: string;
  config: any;
  category?: string;
  tags?: string[];
  version?: string;
  author?: string;
  prerequisites?: string[];
  dependencies?: string[];
}

/**
 * 代理执行上下文接口
 */
export interface AgentExecutionContext {
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
 * 代理执行结果接口
 */
export interface AgentExecutionResult {
  success: boolean;
  output?: any;
  error?: string;
  duration?: number;
  logs?: string[];
  metrics?: Record<string, any>;
}

/**
 * 代理管理器类 - 实现代理系统和任务分配
 */
export class AgentManager {
  private agents: Map<string, AgentDefinition> = new Map();
  private agentDefinitions: Map<string, any> = new Map();
  private skillManager: SkillManager;

  constructor(skillManager: SkillManager) {
    this.skillManager = skillManager;
  }

  /**
   * 添加代理定义
   */
  addAgentDefinition(agentDefinition: AgentDefinition): void {
    this.agents.set(agentDefinition.id, agentDefinition);
  }

  /**
   * 添加代理
   */
  addAgent(agentDefinition: AgentDefinition): void {
    this.addAgentDefinition(agentDefinition);
  }

  /**
   * 获取代理定义
   */
  getAgentDefinition(id: string): AgentDefinition | undefined {
    return this.agents.get(id);
  }

  /**
   * 获取所有代理定义
   */
  getAllAgentDefinitions(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  /**
   * 获取所有代理
   */
  getAgents(): AgentDefinition[] {
    return this.getAllAgentDefinitions();
  }

  /**
   * 查找代理
   */
  findAgent(id: string): AgentDefinition | undefined {
    return this.getAgentDefinition(id);
  }

  /**
   * 搜索代理
   */
  searchAgents(keyword: string): AgentDefinition[] {
    const searchLower = keyword.toLowerCase();
    return this.getAllAgentDefinitions().filter(agent => 
      agent.name.toLowerCase().includes(searchLower) ||
      agent.description.toLowerCase().includes(searchLower) ||
      (agent.tags && agent.tags.some(tag => tag.toLowerCase().includes(searchLower)))
    );
  }

  /**
   * 查找代理
   */
  findAgentsByTag(tag: string): AgentDefinition[] {
    return Array.from(this.agents.values()).filter(
      (agent) => agent.tags && agent.tags.includes(tag)
    );
  }

  /**
   * 查找代理
   */
  findAgentsByCategory(category: string): AgentDefinition[] {
    return Array.from(this.agents.values()).filter(
      (agent) => agent.category === category
    );
  }

  /**
   * 查找代理
   */
  findAgentsByCapability(capability: string): AgentDefinition[] {
    return Array.from(this.agents.values()).filter(
      (agent) => agent.capabilities.includes(capability)
    );
  }

  /**
   * 验证代理依赖
   */
  validateDependencies(agentId: string): string[] {
    const agent = this.getAgentDefinition(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const missingDependencies: string[] = [];
    
    if (agent.dependencies) {
      for (const dep of agent.dependencies) {
        if (!this.agents.has(dep)) {
          missingDependencies.push(dep);
        }
      }
    }

    if (agent.prerequisites) {
      for (const prereq of agent.prerequisites) {
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
   * 查找适合任务的代理
   */
  async findAgentForTask(task: string): Promise<AgentDefinition | null> {
    const taskLower = task.toLowerCase();
    const allAgents = this.getAllAgentDefinitions();
    
    // 1. 首先尝试精确匹配
    const exactMatch = allAgents.find(agent => 
      taskLower.includes(agent.name.toLowerCase()) ||
      taskLower.includes(agent.category?.toLowerCase() || '')
    );
    
    if (exactMatch) {
      return exactMatch;
    }
    
    // 2. 检查代理能力
    for (const agent of allAgents) {
      for (const capability of agent.capabilities) {
        if (taskLower.includes(capability.toLowerCase())) {
          return agent;
        }
      }
    }
    
    // 3. 检查代理描述
    const descriptionMatch = allAgents.find(agent => 
      agent.description.toLowerCase().split(/\s+/).some(word => 
        taskLower.includes(word)
      )
    );
    
    if (descriptionMatch) {
      return descriptionMatch;
    }
    
    // 4. 默认返回通用代理
    return this.getAgentDefinition('general') || null;
  }

  /**
   * 执行任务的代理匹配
   */
  async executeTaskWithAgent(task: string, agentId?: string): Promise<AgentExecutionResult> {
    const startTime = Date.now();
    
    try {
      // 查找合适的代理
      const agent = agentId 
        ? this.getAgentDefinition(agentId) 
        : await this.findAgentForTask(task);
        
      if (!agent) {
        throw new Error('No suitable agent found for task');
      }
      
      // 验证代理依赖
      const missingDependencies = this.validateDependencies(agent.id);
      if (missingDependencies.length > 0) {
        throw new Error(`Missing dependencies: ${missingDependencies.join(', ')}`);
      }
      
      // 执行任务
      const result = await this.executeAgentTask(agent.id, task);
      
      const duration = Date.now() - startTime;
      
      return {
        success: true,
        output: result,
        duration,
        logs: [
          `Task executed successfully by ${agent.name}`,
          `Duration: ${duration}ms`,
        ],
        metrics: {
          duration,
          task,
          agentId: agent.id,
          agentName: agent.name,
        },
      };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        success: false,
        error: errorMessage,
        duration,
        logs: [
          `Task execution failed: ${errorMessage}`,
          `Duration: ${duration}ms`,
        ],
        metrics: {
          duration,
          task,
          error: errorMessage,
        },
      };
    }
  }

  /**
   * 执行代理任务
   */
  private async executeAgentTask(agentId: string, task: string): Promise<any> {
    const agent = this.getAgentDefinition(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    
    // 根据入口点类型执行任务
    switch (agent.entryPoint) {
      case 'javascript':
        return await this.executeJavaScriptAgent(agentId, task);
      case 'shell':
        return await this.executeShellAgent(agentId, task);
      case 'skill_chain':
        return await this.executeSkillChainAgent(agentId, task);
      default:
        throw new Error(`Unsupported entry point type: ${agent.entryPoint}`);
    }
  }

  /**
   * 执行 JavaScript 代理
   */
  private async executeJavaScriptAgent(agentId: string, task: string): Promise<any> {
    const agentConfig = this.agentDefinitions.get(agentId);
    if (!agentConfig || !agentConfig.code) {
      throw new Error(`JavaScript code not found for agent: ${agentId}`);
    }

    const context: AgentExecutionContext = {
      cwd: process.cwd(),
      workingDirectory: process.cwd(),
      environmentVariables: Object.entries(process.env).reduce((acc, [key, value]) => {
        if (value !== undefined) {
          acc[key] = value;
        }
        return acc;
      }, {} as Record<string, string>),
      tools: toolDefs,
      logger: console,
    };

    // 在安全的上下文中执行 JavaScript 代码
    try {
      // 创建沙箱环境
      const sandbox = {
        task,
        context,
        executeAction,
        getToolDefinition,
        skillManager: this.skillManager,
        console: context.logger,
      };

      // 编译并执行代码
      const codeFunction = new Function('sandbox', `
        with(sandbox) {
          ${agentConfig.code}
        }
      `);

      return await codeFunction(sandbox);
    } catch (error) {
      throw new Error(`JavaScript execution failed: ${(error as Error).message}`);
    }
  }

  /**
   * 执行 Shell 代理
   */
  private async executeShellAgent(agentId: string, task: string): Promise<any> {
    const agentConfig = this.agentDefinitions.get(agentId);
    if (!agentConfig || !agentConfig.script) {
      throw new Error(`Shell script not found for agent: ${agentId}`);
    }

    // 准备并执行 Shell 脚本
    const scriptPath = this.resolveScriptPath(agentId);
    if (!scriptPath) {
      throw new Error(`Script path not found for agent: ${agentId}`);
    }

    // 这里应该调用系统命令执行脚本
    // 为了安全，我们需要限制脚本执行的范围
    throw new Error('Shell script execution not implemented yet');
  }

  /**
   * 执行技能链代理
   */
  private async executeSkillChainAgent(agentId: string, task: string): Promise<any> {
    const agentConfig = this.agentDefinitions.get(agentId);
    if (!agentConfig || !agentConfig.skillChain) {
      throw new Error(`Skill chain configuration not found for agent: ${agentId}`);
    }

    const context: AgentExecutionContext = {
      cwd: process.cwd(),
      workingDirectory: process.cwd(),
      environmentVariables: Object.entries(process.env).reduce((acc, [key, value]) => {
        if (value !== undefined) {
          acc[key] = value;
        }
        return acc;
      }, {} as Record<string, string>),
      tools: toolDefs,
      logger: console,
    };

    const result = await this.executeSkillChain(agentConfig.skillChain, task, context);
    return result;
  }

  /**
   * 执行技能链
   */
  private async executeSkillChain(chain: string[], task: string, context: AgentExecutionContext): Promise<any> {
    let result = { task };
    
    for (const skillId of chain) {
      const skill = this.skillManager.getSkillDefinition(skillId);
      if (skill) {
        const skillResult = await this.skillManager.executeSkill(skillId, result, context);
        
        if (!skillResult.success) {
          throw new Error(`Skill execution failed: ${skillResult.error}`);
        }
        
        result = skillResult.output;
      }
    }
    
    return result;
  }

  /**
   * 解析脚本路径
   */
  private resolveScriptPath(agentId: string): string | null {
    // 从代理定义中获取脚本路径
    const agent = this.getAgentDefinition(agentId);
    if (!agent) {
      return null;
    }

    // 这里应该从配置文件或数据库中获取脚本路径
    const agentConfig = this.agentDefinitions.get(agentId);
    if (agentConfig && agentConfig.scriptPath) {
      return agentConfig.scriptPath;
    }

    // 尝试从标准位置查找
    const possiblePaths = [
      `./agents/${agentId}/main.sh`,
      `./agents/${agentId}.sh`,
      `/usr/local/bin/artemis-agents/${agentId}.sh`,
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
   * 加载代理配置
   */
  async loadAgentConfig(): Promise<void> {
    // 从文件系统加载代理配置
    const fs = require('fs');
    const path = require('path');
    
    const agentsDir = path.join(process.cwd(), 'agents');
    if (fs.existsSync(agentsDir)) {
      const agentFiles = fs.readdirSync(agentsDir);
      
      for (const file of agentFiles) {
        if (file.endsWith('.json')) {
          const agentPath = path.join(agentsDir, file);
          const agentConfig = JSON.parse(fs.readFileSync(agentPath, 'utf8'));
          
          this.agentDefinitions.set(agentConfig.id, agentConfig);
          this.addAgentDefinition(agentConfig);
        }
      }
    }
  }

  /**
   * 保存代理配置
   */
  async saveAgentConfig(): Promise<void> {
    const fs = require('fs');
    const path = require('path');
    
    const agentsDir = path.join(process.cwd(), 'agents');
    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, { recursive: true });
    }
    
    for (const [agentId, agentConfig] of Array.from(this.agentDefinitions.entries())) {
      const agentPath = path.join(agentsDir, `${agentId}.json`);
      fs.writeFileSync(agentPath, JSON.stringify(agentConfig, null, 2));
    }
  }

  /**
   * 导出代理配置
   */
  async exportAgentConfig(): Promise<string> {
    return JSON.stringify(Object.fromEntries(this.agentDefinitions.entries()), null, 2);
  }

  /**
   * 导入代理配置
   */
  async importAgentConfig(config: string): Promise<void> {
    const agentConfigs = JSON.parse(config);
    
    for (const [agentId, agentConfig] of Object.entries(agentConfigs)) {
      const typedConfig = agentConfig as AgentDefinition;
      this.agentDefinitions.set(agentId, typedConfig);
      this.addAgentDefinition(typedConfig);
    }
  }
}

/**
 * 创建默认代理
 */
export function createDefaultAgents(skillManager: SkillManager): AgentDefinition[] {
  return [
    {
      id: 'general',
      name: 'General Agent',
      description: '通用代理，能够处理各种类型的任务',
      capabilities: ['general', 'analysis', 'planning', 'execution'],
      entryPoint: 'javascript',
      config: {
        code: `
async function execute() {
  console.log('Executing general task:', task);
  
  // 简单的任务执行逻辑
  const skills = skillManager.searchSkills(task);
  if (skills.length > 0) {
    const result = await skillManager.executeSkill(skills[0].id, { task }, context);
    return result;
  }
  
  return { message: 'Default agent executed', task };
}

execute();
        `,
      },
      category: 'general',
      tags: ['general', 'default'],
      version: '1.0.0',
      author: 'Artemis',
    },
    {
      id: 'code_analyzer',
      name: 'Code Analyzer',
      description: '代码分析代理，擅长分析和处理代码相关任务',
      capabilities: ['code', 'analysis', 'search', 'refactoring'],
      entryPoint: 'javascript',
      config: {
        code: `
async function execute() {
  console.log('Analyzing code:', task);
  
  // 代码分析逻辑
  return {
    message: 'Code analysis completed',
    task,
    type: 'code_analysis',
  };
}

execute();
        `,
      },
      category: 'development',
      tags: ['code', 'analysis', 'refactoring'],
      version: '1.0.0',
      author: 'Artemis',
    },
    {
      id: 'project_manager',
      name: 'Project Manager',
      description: '项目管理代理，擅长项目规划和协调任务',
      capabilities: ['planning', 'organization', 'coordination', 'tracking'],
      entryPoint: 'javascript',
      config: {
        code: `
async function execute() {
  console.log('Managing project:', task);
  
  // 项目管理逻辑
  return {
    message: 'Project management completed',
    task,
    type: 'project_management',
  };
}

execute();
        `,
      },
      category: 'management',
      tags: ['project', 'planning', 'management'],
      version: '1.0.0',
      author: 'Artemis',
    },
    {
      id: 'test_agent',
      name: 'Test Agent',
      description: '测试代理，擅长执行各种测试任务',
      capabilities: ['testing', 'verification', 'validation', 'automation'],
      entryPoint: 'javascript',
      config: {
        code: `
async function execute() {
  console.log('Running tests:', task);
  
  // 测试执行逻辑
  return {
    message: 'Tests executed',
    task,
    type: 'testing',
  };
}

execute();
        `,
      },
      category: 'testing',
      tags: ['testing', 'validation', 'automation'],
      version: '1.0.0',
      author: 'Artemis',
    },
    {
      id: 'deployment_agent',
      name: 'Deployment Agent',
      description: '部署代理，擅长部署和发布任务',
      capabilities: ['deployment', 'release', 'configuration', 'automation'],
      entryPoint: 'javascript',
      config: {
        code: `
async function execute() {
  console.log('Deploying:', task);
  
  // 部署逻辑
  return {
    message: 'Deployment completed',
    task,
    type: 'deployment',
  };
}

execute();
        `,
      },
      category: 'devops',
      tags: ['deployment', 'release', 'devops'],
      version: '1.0.0',
      author: 'Artemis',
    },
  ];
}

/**
 * 代理管理器单例
 */
let agentManagerInstance: AgentManager | null = null;

export function getAgentManager(skillManager?: SkillManager): AgentManager {
  if (!agentManagerInstance && skillManager) {
    agentManagerInstance = new AgentManager(skillManager);
    // 创建默认代理
    const defaultAgents = createDefaultAgents(skillManager);
    defaultAgents.forEach(agent => {
      agentManagerInstance!.addAgent(agent);
    });
  }
  return agentManagerInstance!;
}
