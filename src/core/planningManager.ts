import type { SessionMessage, SessionRecord } from './types.js';
import type { SkillDefinition } from './skillManager.js';
import { SkillManager } from './skillManager.js';
import { AgentManager } from './agentManager.js';
import { QueryEngine } from './queryEngine.js';
import { getSessionManager } from './sessionManager.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * 任务规划接口
 */
export interface TaskPlan {
  id: string;
  title: string;
  description: string;
  steps: TaskStep[];
  dependencies: Array<{ from: string; to: string }>;
  estimatedTime: number; // 估计时间（分钟）
  actualTime?: number; // 实际时间（分钟）
  status: 'planning' | 'in_progress' | 'completed' | 'cancelled' | 'failed';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  assignee?: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, any>;
}

/**
 * 任务步骤接口
 */
export interface TaskStep {
  id: string;
  name: string;
  description: string;
  type: 'simple' | 'parallel' | 'conditional' | 'loop';
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'failed';
  estimatedTime: number; // 估计时间（分钟）
  actualTime?: number; // 实际时间（分钟）
  skills: string[]; // 需要的技能列表
  agents: string[]; // 需要的代理列表
  tools: string[]; // 需要的工具列表
  prerequisites: string[]; // 前置步骤ID
  input?: any;
  output?: any;
  error?: string;
  metadata?: Record<string, any>;
}

/**
 * 工作流程接口
 */
export interface Workflow {
  id: string;
  name: string;
  description: string;
  version: string;
  steps: WorkflowStep[];
  dependencies: Array<{ from: string; to: string }>;
  inputSchema?: any;
  outputSchema?: any;
  category?: string;
  tags?: string[];
  author?: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, any>;
}

/**
 * 工作流程步骤接口
 */
export interface WorkflowStep {
  id: string;
  name: string;
  description: string;
  type: 'simple' | 'parallel' | 'conditional' | 'loop';
  handlerType: 'skill' | 'agent' | 'custom';
  handlerId: string;
  input?: any;
  output?: any;
  prerequisites: string[];
  conditions?: {
    condition: string;
    nextStep?: string;
    alternativeStep?: string;
  };
  loop?: {
    condition: string;
    maxIterations?: number;
  };
}

/**
 * 规划管理器类 - 实现规划能力和工作流程管理
 */
export class PlanningManager {
  private plans: Map<string, TaskPlan>;
  private workflows: Map<string, Workflow>;
  private skillManager: SkillManager;
  private agentManager: AgentManager;
  private queryEngine: QueryEngine;

  constructor(skillManager: SkillManager, agentManager: AgentManager, queryEngine: QueryEngine) {
    this.plans = new Map();
    this.workflows = new Map();
    this.skillManager = skillManager;
    this.agentManager = agentManager;
    this.queryEngine = queryEngine;
  }

  /**
   * 创建任务规划
   */
  createTaskPlan(title: string, description: string, options?: Partial<TaskPlan>): TaskPlan {
    const plan: TaskPlan = {
      id: uuidv4(),
      title,
      description,
      steps: [],
      dependencies: [],
      estimatedTime: 30,
      actualTime: 0,
      status: 'planning',
      priority: 'medium',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...options,
    };
    
    this.plans.set(plan.id, plan);
    return plan;
  }

  /**
   * 获取任务规划
   */
  getTaskPlan(id: string): TaskPlan | undefined {
    return this.plans.get(id);
  }

  /**
   * 更新任务规划
   */
  updateTaskPlan(id: string, updates: Partial<TaskPlan>): TaskPlan | undefined {
    const plan = this.plans.get(id);
    if (!plan) {
      return undefined;
    }
    
    const updatedPlan = {
      ...plan,
      ...updates,
      updatedAt: new Date(),
    };
    
    this.plans.set(id, updatedPlan);
    return updatedPlan;
  }

  /**
   * 删除任务规划
   */
  deleteTaskPlan(id: string): boolean {
    return this.plans.delete(id);
  }

  /**
   * 列出所有任务规划
   */
  listTaskPlans(): TaskPlan[] {
    return Array.from(this.plans.values()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * 添加步骤到任务规划
   */
  addStepToPlan(planId: string, step: Omit<TaskStep, 'id' | 'status'>): TaskStep {
    const plan = this.plans.get(planId);
    if (!plan) {
      throw new Error(`Plan not found: ${planId}`);
    }
    
    const newStep: TaskStep = {
      ...step,
      id: uuidv4(),
      status: 'pending',
    };
    
    plan.steps.push(newStep);
    plan.updatedAt = new Date();
    
    return newStep;
  }

  /**
   * 更新任务步骤
   */
  updateStepInPlan(planId: string, stepId: string, updates: Partial<TaskStep>): TaskStep | undefined {
    const plan = this.plans.get(planId);
    if (!plan) {
      return undefined;
    }
    
    const step = plan.steps.find(s => s.id === stepId);
    if (!step) {
      return undefined;
    }
    
    const updatedStep = {
      ...step,
      ...updates,
    };
    
    const stepIndex = plan.steps.findIndex(s => s.id === stepId);
    plan.steps[stepIndex] = updatedStep;
    plan.updatedAt = new Date();
    
    return updatedStep;
  }

  /**
   * 删除任务步骤
   */
  deleteStepFromPlan(planId: string, stepId: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan) {
      return false;
    }
    
    const initialLength = plan.steps.length;
    plan.steps = plan.steps.filter(step => step.id !== stepId);
    plan.updatedAt = new Date();
    
    return plan.steps.length < initialLength;
  }

  /**
   * 自动生成任务规划
   */
  async autoGeneratePlan(query: string): Promise<TaskPlan> {
    const plan = this.createTaskPlan(
      `Auto-generated plan for: ${query}`,
      `Plan automatically generated for query: ${query}`,
      {
        estimatedTime: 60,
        priority: 'medium',
      }
    )

    try {
      // 1. 分析查询 - 模拟实现
      const analysis = {
        intent: 'code_generation',
        complexity: 'medium',
        domain: 'web_development'
      };
      
      // 2. 分解任务 - 模拟实现
      const decomposed = ['Analyze requirements', 'Implement solution', 'Test and debug'];
      
      // 3. 匹配技能 - 模拟实现
      const matchedSkills = [{ id: 'code-generation', name: '代码生成' }];
      
      // 4. 匹配工具 - 模拟实现
      const availableTools = [{ type: 'file-edit', name: '文件编辑' }];
      
      // 5. 创建步骤
      for (let i = 0; i < decomposed.length; i++) {
        const subTask = decomposed[i];
        
        // 为每个子任务创建步骤
        this.addStepToPlan(plan.id, {
          name: `Step ${i + 1}: ${subTask}`,
          description: `Execute sub-task: ${subTask}`,
          type: 'simple',
          estimatedTime: 15,
          skills: matchedSkills.map((skill: any) => skill.id),
          agents: this.agentManager.findAgentsByCapability(subTask).map(agent => agent.id),
          tools: availableTools.map((tool: any) => tool.type),
          prerequisites: i > 0 ? [plan.steps[i - 1].id] : [],
          metadata: {
            subTask,
            analysis,
          },
        });
      }
      
      plan.estimatedTime = plan.steps.reduce((sum, step) => sum + step.estimatedTime, 0);
      
      return plan;
      
    } catch (error) {
      // 如果自动生成失败，创建默认计划
      this.addStepToPlan(plan.id, {
        name: 'Default step',
        description: 'Execute query directly',
        type: 'simple',
        estimatedTime: 30,
        skills: ['general'],
        agents: ['general'],
        tools: [],
        prerequisites: [],
        metadata: { error: error instanceof Error ? error.message : String(error) },
      });
      
      plan.estimatedTime = 30;
      
      return plan;
    }
  }

  /**
   * 执行任务规划
   */
  async executePlan(planId: string, sessionId?: string): Promise<TaskPlan> {
    const plan = this.plans.get(planId);
    if (!plan) {
      throw new Error(`Plan not found: ${planId}`);
    }

    plan.status = 'in_progress';
    plan.updatedAt = new Date();

    const startTime = Date.now();

    try {
      for (const step of plan.steps) {
        step.status = 'in_progress';
        const stepStartTime = Date.now();

        try {
          // 检查前置条件
          const prerequisitesMet = await this.checkPrerequisites(plan, step);
          if (!prerequisitesMet) {
            throw new Error('Prerequisites not met');
          }

          // 执行步骤
          const stepResult = await this.executeStep(step, sessionId);
          step.output = stepResult;
          step.status = 'completed';
          step.actualTime = Math.round((Date.now() - stepStartTime) / 60000); // 转换为分钟
        } catch (error) {
          step.status = 'failed';
          step.error = error instanceof Error ? error.message : String(error);
          plan.status = 'failed';
          break;
        }
      }

      if (plan.status === 'in_progress') {
        plan.status = 'completed';
        plan.completedAt = new Date();
      }

      plan.actualTime = Math.round((Date.now() - startTime) / 60000); // 转换为分钟

      return plan;

    } catch (error) {
      plan.status = 'failed';
      plan.actualTime = Math.round((Date.now() - startTime) / 60000); // 转换为分钟
      
      return plan;
    }
  }

  /**
   * 执行单个任务步骤
   */
  private async executeStep(step: TaskStep, sessionId?: string): Promise<any> {
    // 根据步骤类型执行
    switch (step.type) {
      case 'simple':
        return await this.executeSimpleStep(step, sessionId);
      case 'parallel':
        return await this.executeParallelStep(step, sessionId);
      case 'conditional':
        return await this.executeConditionalStep(step, sessionId);
      case 'loop':
        return await this.executeLoopStep(step, sessionId);
      default:
        throw new Error(`Unsupported step type: ${step.type}`);
    }
  }

  /**
   * 执行简单步骤
   */
  private async executeSimpleStep(step: TaskStep, sessionId?: string): Promise<any> {
    // 优先使用技能
    if (step.skills.length > 0) {
      const context = this.createExecutionContext(sessionId);
      const skill = this.skillManager.getSkillDefinition(step.skills[0]);
      if (skill) {
        const result = await this.skillManager.executeSkill(
          step.skills[0],
          step.input || { step: step },
          context
        );
        
        if (result.success) {
          return result.output;
        }
      }
    }

    // 然后使用代理
    if (step.agents.length > 0) {
      const agentId = step.agents[0];
      const result = await this.agentManager.executeTaskWithAgent(
        step.description,
        agentId
      );
      
      if (result.success) {
        return result.output;
      }
    }

    // 最后使用默认方法
    return this.executeDefaultStep(step);
  }

  /**
   * 执行并行步骤
   */
  private async executeParallelStep(step: TaskStep, sessionId?: string): Promise<any> {
    const promises: Promise<any>[] = [];
    
    for (const skillId of step.skills) {
      const promise = this.skillManager.executeSkill(
        skillId,
        step.input || { step: step },
        this.createExecutionContext(sessionId)
      );
      promises.push(promise);
    }
    
    return await Promise.all(promises);
  }

  /**
   * 执行条件步骤
   */
  private async executeConditionalStep(step: TaskStep, sessionId?: string): Promise<any> {
    // 简单的条件判断（这里可以扩展为更复杂的逻辑）
    const condition = step.metadata?.condition;
    const conditionMet = condition ? this.evaluateCondition(condition, step.input) : true;
    
    if (conditionMet) {
      return await this.executeSimpleStep(step, sessionId);
    } else {
      return null;
    }
  }

  /**
   * 执行循环步骤
   */
  private async executeLoopStep(step: TaskStep, sessionId?: string): Promise<any> {
    const results: any[] = [];
    const maxIterations = step.metadata?.maxIterations || 5;
    
    for (let i = 0; i < maxIterations; i++) {
      const loopResult = await this.executeSimpleStep(step, sessionId);
      results.push(loopResult);
      
      // 简单的循环终止条件
      if (step.metadata?.loopCondition) {
        const shouldContinue = this.evaluateCondition(
          step.metadata.loopCondition,
          { ...step.input, loopIndex: i, result: loopResult }
        );
        
        if (!shouldContinue) {
          break;
        }
      }
    }
    
    return results;
  }

  /**
   * 执行默认步骤
   */
  private executeDefaultStep(step: TaskStep): any {
    return {
      message: 'Default step executed',
      step,
    };
  }

  /**
   * 检查前置条件
   */
  private async checkPrerequisites(plan: TaskPlan, step: TaskStep): Promise<boolean> {
    for (const prerequisiteId of step.prerequisites) {
      const prerequisiteStep = plan.steps.find(s => s.id === prerequisiteId);
      if (!prerequisiteStep || prerequisiteStep.status !== 'completed') {
        return false;
      }
    }
    
    return true;
  }

  /**
   * 评估条件
   */
  private evaluateCondition(condition: string, context: any): boolean {
    // 简单的条件评估（可以扩展为复杂的表达式解析）
    try {
      // 支持简单的属性访问
      return condition === 'true' || Boolean(context[condition]);
    } catch (error) {
      console.error('Condition evaluation error:', error);
      return false;
    }
  }

  /**
   * 创建执行上下文
   */
  private createExecutionContext(sessionId?: string): any {
    return {
      cwd: process.cwd(),
      workingDirectory: process.cwd(),
      environmentVariables: process.env,
      tools: [],
      logger: console,
      sessionId,
      metadata: {
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * 保存工作流程
   */
  saveWorkflow(workflow: Workflow): void {
    this.workflows.set(workflow.id, workflow);
  }

  /**
   * 加载工作流程
   */
  loadWorkflow(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  /**
   * 删除工作流程
   */
  deleteWorkflow(id: string): boolean {
    return this.workflows.delete(id);
  }

  /**
   * 创建工作流程
   */
  createWorkflow(name: string, description: string, steps: WorkflowStep[]): Workflow {
    const workflow: Workflow = {
      id: uuidv4(),
      name,
      description,
      version: '1.0.0',
      steps,
      dependencies: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    
    this.saveWorkflow(workflow);
    return workflow;
  }

  /**
   * 执行工作流程
   */
  async executeWorkflow(workflowId: string, input: any, sessionId?: string): Promise<any> {
    const workflow = this.loadWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const results: Record<string, any> = {
      input,
      steps: {},
    };

    for (const step of workflow.steps) {
      // 检查步骤前置条件
      const prerequisitesMet = await this.checkWorkflowStepPrerequisites(workflow, step, results);
      if (!prerequisitesMet) {
        continue;
      }

      // 执行步骤
      const stepResult = await this.executeWorkflowStep(step, results, sessionId);
      results.steps[step.id] = stepResult;

      // 处理输出
      if (step.output) {
        for (const [key, value] of Object.entries(step.output)) {
          results[key] = value;
        }
      }
    }

    return results;
  }

  /**
   * 执行工作流程步骤
   */
  private async executeWorkflowStep(step: WorkflowStep, context: any, sessionId?: string): Promise<any> {
    switch (step.handlerType) {
      case 'skill':
        return await this.skillManager.executeSkill(
          step.handlerId,
          context,
          this.createExecutionContext(sessionId)
        );
      
      case 'agent':
        return await this.agentManager.executeTaskWithAgent(
          step.description,
          step.handlerId
        );
      
      case 'custom':
        return await this.executeCustomHandler(step.handlerId, context, sessionId);
      
      default:
        throw new Error(`Unsupported handler type: ${step.handlerType}`);
    }
  }

  /**
   * 执行自定义处理器
   */
  private async executeCustomHandler(handlerId: string, context: any, sessionId?: string): Promise<any> {
    // 这里可以添加自定义处理器的实现
    return {
      message: 'Custom handler not implemented',
      handlerId,
      context,
    };
  }

  /**
   * 检查工作流程步骤前置条件
   */
  private async checkWorkflowStepPrerequisites(
    workflow: Workflow,
    step: WorkflowStep,
    context: any
  ): Promise<boolean> {
    for (const prerequisiteId of step.prerequisites) {
      if (!context.steps[prerequisiteId]) {
        return false;
      }
    }
    
    return true;
  }
}

/**
 * 创建默认工作流程
 */
export function createDefaultWorkflows(): Workflow[] {
  return [
    {
      id: 'default',
      name: 'Default Workflow',
      description: '默认工作流程，用于处理通用任务',
      version: '1.0.0',
      steps: [
        {
          id: '1',
          name: 'Task Analysis',
          description: '分析任务需求',
          type: 'simple',
          handlerType: 'skill',
          handlerId: 'analyze-task',
          prerequisites: [],
        },
        {
          id: '2',
          name: 'Plan Generation',
          description: '生成执行计划',
          type: 'simple',
          handlerType: 'skill',
          handlerId: 'generate-plan',
          prerequisites: ['1'],
        },
        {
          id: '3',
          name: 'Task Execution',
          description: '执行任务',
          type: 'simple',
          handlerType: 'skill',
          handlerId: 'execute-task',
          prerequisites: ['2'],
        },
        {
          id: '4',
          name: 'Result Verification',
          description: '验证结果',
          type: 'simple',
          handlerType: 'skill',
          handlerId: 'verify-result',
          prerequisites: ['3'],
        },
      ],
      dependencies: [
        { from: '1', to: '2' },
        { from: '2', to: '3' },
        { from: '3', to: '4' },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
      category: 'general',
      tags: ['default', 'workflow'],
    },
  ];
}

/**
 * 规划管理器单例
 */
let planningManagerInstance: PlanningManager | null = null;

export function getPlanningManager(
  skillManager?: SkillManager,
  agentManager?: AgentManager,
  queryEngine?: QueryEngine
): PlanningManager {
  if (!planningManagerInstance && skillManager && agentManager && queryEngine) {
    planningManagerInstance = new PlanningManager(skillManager, agentManager, queryEngine);
    // 加载默认工作流程
    createDefaultWorkflows().forEach(workflow => {
      planningManagerInstance!.saveWorkflow(workflow);
    });
  }
  return planningManagerInstance!;
}
