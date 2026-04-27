import type { ToolExecutionContext } from "../types.js";
import type { ToolDefinition } from "../../core/toolDef.js";
import type { ToolKind, ToolPermissionCategory, ToolExecutionMode } from "../../core/toolDef.js";
import type { AgentAction } from "../../core/types.js";
import { z } from "zod";
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

// 代理执行工具
export class AgentExecutionTool {
  private static agentsDir = path.join(process.cwd(), '.artemis', 'agents');

  static create(): ToolDefinition {
    return {
      type: "agent",
      description: "代理执行工具，允许创建和管理独立的代理任务，支持并行执行和状态管理",
      kind: "agent" as ToolKind,
      permissionCategory: "agent" as ToolPermissionCategory,
      executionMode: "blocking" as ToolExecutionMode,
      parallelSafe: true,
      tags: ["agent", "execution", "parallel", "subtask"],
      validate: (action: AgentAction) => {
        // 类型守卫：确保我们只在处理 'agent' 类型的 AgentAction
        if (action.type !== 'agent') {
          return ["不支持的操作类型"];
        }
        
        // 简单的验证逻辑
        const errors: string[] = [];
        if (!action.action) {
          errors.push("action is required");
        }
        return errors;
      },
      execute: async (action: AgentAction, context: ToolExecutionContext) => {
        // 类型守卫：确保我们只在处理 'agent' 类型的 AgentAction
        if (action.type !== 'agent') {
          return {
            success: false,
            data: null,
            summary: "不支持的操作类型"
          };
        }
        
        try {
          // 确保目录存在
          await fs.mkdir(AgentExecutionTool.agentsDir, { recursive: true });

          // 读取现有代理任务
          const agentsDir = AgentExecutionTool.agentsDir;
          const files = await fs.readdir(agentsDir);
          const agents = [];

          for (const file of files) {
            if (file.endsWith('.json')) {
              const data = await fs.readFile(path.join(agentsDir, file), 'utf-8');
              agents.push(JSON.parse(data));
            }
          }

          let result;

          switch (action.action) {
            case 'create':
              if (!action.name || !action.task) {
                return {
                  success: false,
                  data: null,
                  summary: "代理任务名称和任务内容不能为空"
                };
              }

              const newAgent = {
                id: Date.now().toString(),
                name: action.name,
                description: action.description,
                task: action.task,
                context: action.context || {},
                toolsets: action.toolsets || [],
                timeout: action.timeout,
                maxIterations: action.maxIterations,
                priority: action.priority || 'medium',
                status: 'pending',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                startedAt: null,
                completedAt: null,
                result: null,
                log: []
              };

              // 保存代理任务
              const agentFile = path.join(agentsDir, `${newAgent.id}.json`);
              await fs.writeFile(agentFile, JSON.stringify(newAgent, null, 2));

              result = {
                success: true,
                data: {
                  agent: newAgent
                },
                summary: `代理任务创建成功（ID: ${newAgent.id}）`
              };
              break;

            case 'list':
              let filteredAgents = agents;
              if (action.name && action.name.trim()) {
                filteredAgents = agents.filter(agent => 
                  agent.name?.toLowerCase().includes(action.name?.toLowerCase() ?? '')
                );
              }

              result = {
                success: true,
                data: {
                  agents: filteredAgents,
                  count: filteredAgents.length
                },
                summary: `找到 ${filteredAgents.length} 个代理任务`
              };
              break;

            case 'run':
              if (!action.id) {
                return {
                  success: false,
                  data: null,
                  summary: "代理任务 ID 不能为空"
                };
              }

              const agentIndex = agents.findIndex(agent => agent.id === action.id);
              if (agentIndex === -1) {
                return {
                  success: false,
                  data: null,
                  summary: "代理任务未找到"
                };
              }

              const agentToRun = agents[agentIndex];
              if (agentToRun.status === 'running') {
                return {
                  success: false,
                  data: null,
                  summary: "代理任务正在运行中"
                };
              }

              // 更新任务状态为运行中
              agentToRun.status = 'running';
              agentToRun.startedAt = new Date().toISOString();
              await fs.writeFile(
                path.join(agentsDir, `${agentToRun.id}.json`),
                JSON.stringify(agentToRun, null, 2)
              );

              // 模拟代理执行（实际实现会调用真实的代理执行逻辑）
              result = {
                success: true,
                data: {
                  agent: agentToRun,
                  message: "代理任务已启动（模拟执行）"
                },
                summary: `代理任务已启动（ID: ${agentToRun.id}）`
              };
              break;

            case 'stop':
              if (!action.id) {
                return {
                  success: false,
                  data: null,
                  summary: "代理任务 ID 不能为空"
                };
              }

              const stopIndex = agents.findIndex(agent => agent.id === action.id);
              if (stopIndex === -1) {
                return {
                  success: false,
                  data: null,
                  summary: "代理任务未找到"
                };
              }

              const agentToStop = agents[stopIndex];
              if (agentToStop.status !== 'running') {
                return {
                  success: false,
                  data: null,
                  summary: "代理任务未在运行中"
                };
              }

              // 更新任务状态为已停止
              agentToStop.status = 'cancelled';
              agentToStop.completedAt = new Date().toISOString();
              await fs.writeFile(
                path.join(agentsDir, `${agentToStop.id}.json`),
                JSON.stringify(agentToStop, null, 2)
              );

              result = {
                success: true,
                data: {
                  agent: agentToStop
                },
                summary: `代理任务已停止（ID: ${agentToStop.id}）`
              };
              break;

            case 'status':
              if (!action.id) {
                return {
                  success: false,
                  data: null,
                  summary: "代理任务 ID 不能为空"
                };
              }

              const statusIndex = agents.findIndex(agent => agent.id === action.id);
              if (statusIndex === -1) {
                return {
                  success: false,
                  data: null,
                  summary: "代理任务未找到"
                };
              }

              const agentStatus = agents[statusIndex];

              result = {
                success: true,
                data: {
                  agent: agentStatus
                },
                summary: `代理任务状态：${agentStatus.status}`
              };
              break;

            case 'result':
              if (!action.id) {
                return {
                  success: false,
                  data: null,
                  summary: "代理任务 ID 不能为空"
                };
              }

              const resultIndex = agents.findIndex(agent => agent.id === action.id);
              if (resultIndex === -1) {
                return {
                  success: false,
                  data: null,
                  summary: "代理任务未找到"
                };
              }

              const agentResult = agents[resultIndex];
              
              if (agentResult.status !== 'completed') {
                return {
                  success: false,
                  data: null,
                  summary: "代理任务尚未完成"
                };
              }

              result = {
                success: true,
                data: {
                  agent: agentResult
                },
                summary: `代理任务结果已获取（ID: ${agentResult.id}）`
              };
              break;

            default:
              return {
                success: false,
                data: null,
                summary: `未知操作：${action.action}`
              };
          }

          return result;
        } catch (error: any) {
          return {
            success: false,
            data: null,
            summary: `操作失败: ${error.message}`
          };
        }
      }
    };
  }
}