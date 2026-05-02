/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * core/session.ts — 会话管理
 *
 * 会话管理功能，用于存储对话历史和上下文信息
 */

import type { SessionMessage, SessionRecord, AgentAction, AssistantEnvelope } from './types.js';

const TOOL_OUTPUT_INTAKE_BYTES_BUDGET = 6_000;
const TOOL_OUTPUT_HEAD_LINES = 20;
const TOOL_OUTPUT_TAIL_LINES = 20;

/**
 * Smart-truncate a verbose tool result before it enters conversation history.
 * Most tool wrappers emit a JSON envelope { action, ok, output: "..." }; we
 * truncate ONLY the .output field when present, leaving structural metadata
 * (action type, ok flag, error code) intact so the model can still reason
 * about success/failure and arguments. Falls back to plain-text truncation
 * for tool wrappers that emit raw strings.
 */
export function smartTruncateToolContent(raw: string): string {
  if (!raw || raw.length <= TOOL_OUTPUT_INTAKE_BYTES_BUDGET) return raw;

  // Try the JSON-envelope path first.
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.output === 'string') {
      const before = parsed.output.length;
      const truncated = headTailTruncate(parsed.output);
      if (truncated.length < before) {
        parsed.output = truncated;
        return JSON.stringify(parsed);
      }
    }
  } catch {
    /* not JSON — fall through to raw truncation */
  }

  return headTailTruncate(raw);
}

function headTailTruncate(text: string): string {
  if (text.length <= TOOL_OUTPUT_INTAKE_BYTES_BUDGET) return text;
  const lines = text.split('\n');
  if (lines.length <= TOOL_OUTPUT_HEAD_LINES + TOOL_OUTPUT_TAIL_LINES + 4) {
    // Few lines but each is huge (e.g. one giant JSON blob). Slice by chars.
    const head = text.slice(0, Math.floor(TOOL_OUTPUT_INTAKE_BYTES_BUDGET * 0.6));
    const tail = text.slice(-Math.floor(TOOL_OUTPUT_INTAKE_BYTES_BUDGET * 0.3));
    const dropped = text.length - head.length - tail.length;
    return `${head}\n\n[…truncated ${dropped.toLocaleString()} chars at intake — original kept on disk if it was a file…]\n\n${tail}`;
  }
  const head = lines.slice(0, TOOL_OUTPUT_HEAD_LINES).join('\n');
  const tail = lines.slice(-TOOL_OUTPUT_TAIL_LINES).join('\n');
  const droppedLines = lines.length - TOOL_OUTPUT_HEAD_LINES - TOOL_OUTPUT_TAIL_LINES;
  const droppedChars = text.length - head.length - tail.length;
  return `${head}\n\n[…truncated ${droppedLines} lines / ~${droppedChars.toLocaleString()} chars at intake — re-run with a narrower scope or read the file directly if you need the middle section…]\n\n${tail}`;
}

export class Session {
  private messages: SessionMessage[] = [];
  private context: any = {};
  
  constructor(private systemPrompt: string, private workingDirectory: string) {
    // 初始化会话
  }
  
  /**
   * 添加用户消息
   */
  addUser(content: string): void {
    this.messages.push({
      id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    });
  }
  
  /**
   * 添加助手消息
   */
  addAssistant(content: string): void {
    this.messages.push({
      id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      role: 'assistant',
      content,
      createdAt: new Date().toISOString(),
    });
  }
  
  /**
   * 添加工具使用消息
   *
   * Truncates verbose tool outputs at intake so they don't bloat conversation
   * history. Long outputs (npm test/build, find, grep, large file reads) are
   * collapsed to head + tail with a "[truncated N chars]" marker. The first
   * 20 lines and last 20 lines almost always carry the actionable bits (test
   * pass/fail, error line, summary), and this prevents 100-line outputs from
   * compounding across multi-turn sessions.
   *
   * Threshold (~6 KB / ~120 lines) is generous enough to keep small outputs
   * intact and only kicks in on the verbose ones that historically blew up
   * input-token usage to 150K+ per session.
   */
  addToolUse(content: string): void {
    this.messages.push({
      id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      role: 'tool',
      content: smartTruncateToolContent(content),
      createdAt: new Date().toISOString(),
    });
  }
  
  /**
   * 获取会话历史
   */
  getMessages(): SessionMessage[] {
    return [...this.messages];
  }
  
  /**
   * 获取系统提示
   */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /**
   * 更新系统提示而不清除对话历史。
   * 用于工作区切换、ARTEMIS.md 重新加载等场景——只更新指令，
   * 不丢弃已有的对话上下文。
   */
  updateSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }
  
  /**
   * 获取工作目录
   */
  getWorkingDirectory(): string {
    return this.workingDirectory;
  }
  
  /**
   * 设置上下文
   */
  setContext(key: string, value: any): void {
    this.context[key] = value;
  }
  
  /**
   * 获取上下文
   */
  getContext(key: string): any {
    return this.context[key];
  }
  
  /**
   * 清除会话历史
   */
  clear(): void {
    this.messages = [];
    this.context = {};
  }
  
  /**
   * 恢复会话状态
   */
  restore(state: any): void {
    // 如果传入的是消息数组，直接恢复消息
    if (Array.isArray(state)) {
      this.messages = state;
    } else {
      // 否则，恢复完整的会话状态
      if (state.messages) {
        this.messages = state.messages;
      }
      if (state.context) {
        this.context = state.context;
      }
    }
  }
  
  /**
   * 获取会话状态
   */
  getState(): any {
    return {
      systemPrompt: this.systemPrompt,
      workingDirectory: this.workingDirectory,
      messages: this.messages,
      context: this.context,
    };
  }
}
