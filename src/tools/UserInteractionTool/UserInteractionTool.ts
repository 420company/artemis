import type { ToolDefinition } from "../../core/toolDef.js";
import type { ToolExecutionContext } from "../types.js";

// 用户交互工具
export class UserInteractionTool {
  static create(): ToolDefinition {
    return {
      type: "user_interaction",
      description: "允许 AI 主动向用户提问，获取反馈或确认",
      kind: "function",
      permissionCategory: "read",
      executionMode: "blocking",
      parallelSafe: false,
      tags: ["user", "interaction", "prompt"],
      validate: (action: any) => {
        const errors: string[] = [];
        if (!action.question || typeof action.question !== 'string') {
          errors.push("问题不能为空且必须是字符串类型");
        }
        if (action.choices && !Array.isArray(action.choices)) {
          errors.push("选项必须是数组类型");
        }
        if (action.choices && Array.isArray(action.choices) && action.choices.some((choice: any) => typeof choice !== 'string')) {
          errors.push("所有选项必须是字符串类型");
        }
        if (action.default_answer && typeof action.default_answer !== 'string') {
          errors.push("默认答案必须是字符串类型");
        }
        if (action.timeout && (typeof action.timeout !== 'number' || action.timeout <= 0)) {
          errors.push("超时时间必须是正整数");
        }
        return errors;
      },
      execute: async (args: any, context: ToolExecutionContext) => {
        try {
          console.log(`\n=== 用户交互 ===\n`);
          console.log(args.question);
          
          if (args.choices && args.choices.length > 0) {
            console.log("\n选项:");
            args.choices.forEach((choice: string, index: number) => {
              console.log(`${index + 1}. ${choice}`);
            });
          }
          
          if (args.default_answer) {
            console.log(`\n默认答案: ${args.default_answer}`);
          }
          
          if (args.timeout) {
            console.log(`\n超时时间: ${args.timeout}秒`);
          }
          
          console.log(`\n================\n`);

          // 使用简单的同步输入来获取用户响应
          const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
          });

          const userResponse = await new Promise<string>((resolve) => {
            readline.question('你的回答: ', (answer: string) => {
              readline.close();
              resolve(answer.trim() || (args.default_answer || ''));
            });
          });

          return {
            success: true,
            data: {
              question: args.question,
              user_response: userResponse,
              choices: args.choices,
              default_answer: args.default_answer
            },
            summary: `用户响应: ${userResponse}`
          };
        } catch (error: any) {
          return {
            success: false,
            data: null,
            summary: `用户交互失败: ${error.message}`
          };
        }
      }
    };
  }
}

// 确认工具（简化版交互）
export class ConfirmTool {
  static create(): ToolDefinition {
    return {
      type: "confirm",
      description: "获取用户对某个问题的简单确认（是/否）",
      kind: "function",
      permissionCategory: "read",
      executionMode: "blocking",
      parallelSafe: false,
      tags: ["user", "interaction", "confirm"],
      validate: (action: any) => {
        const errors: string[] = [];
        if (!action.question || typeof action.question !== 'string') {
          errors.push("问题不能为空且必须是字符串类型");
        }
        if (action.default_answer && typeof action.default_answer !== 'boolean') {
          errors.push("默认答案必须是布尔值类型");
        }
        return errors;
      },
      execute: async (args: any, context: ToolExecutionContext) => {
        try {
          const defaultText = args.default_answer ? "（默认: 是）" : "（默认: 否）";
          
          console.log(`\n=== 确认 ===\n`);
          console.log(`${args.question} ${defaultText}`);
          console.log(`输入 'y' 或 'n'（或按回车使用默认值）`);
          console.log(`============\n`);

          const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
          });

          const userResponse = await new Promise<string>((resolve) => {
            readline.question('确认: ', (answer: string) => {
              readline.close();
              resolve(answer.trim().toLowerCase());
            });
          });

          let confirmed: boolean;
          if (!userResponse) {
            confirmed = args.default_answer || false;
          } else if (['y', 'yes', '是', '确定'].includes(userResponse)) {
            confirmed = true;
          } else if (['n', 'no', '否', '取消'].includes(userResponse)) {
            confirmed = false;
          } else {
            confirmed = args.default_answer || false;
          }

          return {
            success: true,
            data: {
              question: args.question,
              confirmed: confirmed,
              user_response: userResponse
            },
            summary: `用户${confirmed ? "确认" : "拒绝"}了`
          };
        } catch (error: any) {
          return {
            success: false,
            data: null,
            summary: `确认失败: ${error.message}`
          };
        }
      }
    };
  }
}