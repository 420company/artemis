import type { ToolDefinition } from "../../core/toolDef.js";
import type { ToolExecutionContext } from "../types.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";

interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  priority?: 'low' | 'medium' | 'high';
  dueDate?: string;
}

// 待办事项工具
export class TodoTool {
  private static todoFile = path.join(process.cwd(), '.artemis', 'todos.json');

  static create(): ToolDefinition {
    return {
      type: "todo",
      description: "管理待办事项列表，支持创建、查看、更新和删除任务",
      kind: "function",
      permissionCategory: "read",
      executionMode: "blocking",
      parallelSafe: true,
      tags: ["todo", "task", "management"],
      validate: (action: any) => {
        const errors: string[] = [];
        if (!action.action || !["add", "list", "update", "delete", "toggle"].includes(action.action)) {
          errors.push("无效的操作类型");
        }
        if (["add"].includes(action.action)) {
          if (!action.content) errors.push("任务内容不能为空");
        }
        if (["update", "delete", "toggle"].includes(action.action)) {
          if (!action.id) errors.push("任务ID不能为空");
        }
        if (action.status && !["pending", "in_progress", "completed", "cancelled"].includes(action.status)) {
          errors.push("无效的状态值");
        }
        if (action.priority && !["low", "medium", "high"].includes(action.priority)) {
          errors.push("无效的优先级值");
        }
        if (action.filter && !["all", "pending", "in_progress", "completed", "cancelled"].includes(action.filter)) {
          errors.push("无效的筛选条件");
        }
        return errors;
      },
      execute: async (args: any, context: ToolExecutionContext) => {
        try {
          // 确保目录存在
          const dir = path.dirname(TodoTool.todoFile);
          await fs.mkdir(dir, { recursive: true });

          // 读取现有待办事项
          let todos: TodoItem[] = [];
          try {
            const data = await fs.readFile(TodoTool.todoFile, 'utf-8');
            todos = JSON.parse(data);
          } catch (error: any) {
            if (error.code !== 'ENOENT') {
              throw error;
            }
          }

          let result;

          switch (args.action) {
            case 'add':
              if (!args.content) {
                return {
                  success: false,
                  data: null,
                  summary: "任务内容不能为空"
                };
              }
              
              const newTodo: TodoItem = {
                id: Date.now().toString(),
                content: args.content,
                status: args.status || 'pending',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                tags: args.tags,
                priority: args.priority,
                dueDate: args.dueDate
              };
              
              todos.push(newTodo);
              await fs.writeFile(TodoTool.todoFile, JSON.stringify(todos, null, 2));
              
              result = {
                success: true,
                data: {
                  todo: newTodo,
                  total: todos.length
                },
                summary: `任务添加成功（ID: ${newTodo.id}）`
              };
              break;

            case 'list':
              let filteredTodos = todos;
              if (args.filter && args.filter !== 'all') {
                filteredTodos = todos.filter(todo => todo.status === args.filter);
              }

              result = {
                success: true,
                data: {
                  todos: filteredTodos,
                  total: filteredTodos.length,
                  filter: args.filter || 'all'
                },
                summary: `找到 ${filteredTodos.length} 个任务`
              };
              break;

            case 'update':
              if (!args.id) {
                return {
                  success: false,
                  data: null,
                  summary: "任务ID不能为空"
                };
              }

              const todoIndex = todos.findIndex(todo => todo.id === args.id);
              if (todoIndex === -1) {
                return {
                  success: false,
                  data: null,
                  summary: "任务未找到"
                };
              }

              const updatedTodo = {
                ...todos[todoIndex],
                ...(args.content && { content: args.content }),
                ...(args.status && { status: args.status }),
                ...(args.tags && { tags: args.tags }),
                ...(args.priority && { priority: args.priority }),
                ...(args.dueDate && { dueDate: args.dueDate }),
                updatedAt: new Date().toISOString()
              };

              todos[todoIndex] = updatedTodo;
              await fs.writeFile(TodoTool.todoFile, JSON.stringify(todos, null, 2));

              result = {
                success: true,
                data: {
                  todo: updatedTodo
                },
                summary: `任务更新成功（ID: ${args.id}）`
              };
              break;

            case 'delete':
              if (!args.id) {
                return {
                  success: false,
                  data: null,
                  summary: "任务ID不能为空"
                };
              }

              const deletedTodo = todos.find(todo => todo.id === args.id);
              if (!deletedTodo) {
                return {
                  success: false,
                  data: null,
                  summary: "任务未找到"
                };
              }

              todos = todos.filter(todo => todo.id !== args.id);
              await fs.writeFile(TodoTool.todoFile, JSON.stringify(todos, null, 2));

              result = {
                success: true,
                data: {
                  todo: deletedTodo,
                  total: todos.length
                },
                summary: `任务删除成功（ID: ${args.id}）`
              };
              break;

            case 'toggle':
              if (!args.id) {
                return {
                  success: false,
                  data: null,
                  summary: "任务ID不能为空"
                };
              }

              const toggleIndex = todos.findIndex(todo => todo.id === args.id);
              if (toggleIndex === -1) {
                return {
                  success: false,
                  data: null,
                  summary: "任务未找到"
                };
              }

              const currentStatus = todos[toggleIndex].status;
              const newStatus = currentStatus === 'completed' ? 'pending' : 'completed';

              todos[toggleIndex] = {
                ...todos[toggleIndex],
                status: newStatus,
                updatedAt: new Date().toISOString()
              };

              await fs.writeFile(TodoTool.todoFile, JSON.stringify(todos, null, 2));

              result = {
                success: true,
                data: {
                  todo: todos[toggleIndex]
                },
                summary: `任务状态已${newStatus === 'completed' ? '完成' : '未完成'}（ID: ${args.id}）`
              };
              break;

            default:
              return {
                success: false,
                data: null,
                summary: `未知操作：${args.action}`
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