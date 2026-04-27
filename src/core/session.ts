/**
 * core/session.ts — 会话管理
 *
 * 会话管理功能，用于存储对话历史和上下文信息
 */

import type { SessionMessage, SessionRecord, AgentAction, AssistantEnvelope } from './types.js';

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
   */
  addToolUse(content: string): void {
    this.messages.push({
      id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      role: 'tool',
      content,
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
