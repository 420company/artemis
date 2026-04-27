/**
 * core/index.ts — 核心系统导出
 *
 * 统一导出核心系统模块
 */

import type { SessionMessage, SessionRecord, AgentAction, AssistantEnvelope } from './types.js';
import { buildTool } from './toolDef.js';
import type { ToolDefinition, ToolDefBuilder, ToolKind, ToolPermissionCategory, ToolExecutionMode } from './toolDef.js';
import type { QueryEngineConfig, QueryEngine } from './queryEngine.js';

export type {
  SessionMessage,
  SessionRecord,
  AgentAction,
  AssistantEnvelope,
  ToolDefinition,
  ToolDefBuilder,
  ToolKind,
  ToolPermissionCategory,
  ToolExecutionMode,
  QueryEngineConfig,
  QueryEngine
};

export {
  buildTool
};

// 其他核心功能导出将在后续实现
