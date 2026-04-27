/**
 * Artemis - AI Coding Assistant
 * 
 * 库入口文件，提供核心类型和功能的导出
 */

// 导出核心类型和功能
export type {
  SessionMessage,
  SessionRecord,
  AgentAction,
  AssistantEnvelope
} from './core/types.js';

export type {
  ToolDefinition,
  ToolDefBuilder,
  ToolKind,
  ToolPermissionCategory,
  ToolExecutionMode
} from './core/toolDef.js';

export type {
  QueryEngineConfig
} from './core/queryEngine.js';

export {
  buildTool
} from './core/toolDef.js';

export {
  QueryEngine
} from './core/queryEngine.js';

export {
  SkillManager
} from './core/skillManager.js';

export {
  AgentManager
} from './core/agentManager.js';

export {
  SessionManager
} from './core/sessionManager.js';

export {
  SecurityAuditSystem
} from './core/securityAuditSystem.js';

// 导出工具系统
export {
  executeAction,
  getToolManifest,
  getDetailedToolManifest
} from './tools/index.js';

export {
  getToolDefinition,
  renderToolManifest,
  renderDetailedToolManifest,
  validateToolAction,
  validateToolRegistryIntegrity,
  getToolDefinitionByPermissionCategory
} from './tools/registry.js';
