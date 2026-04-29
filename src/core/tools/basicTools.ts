/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * 基础工具实现 - 提供常用工具的具体实现
 */

import { buildTool, ToolDefBuilder, ToolKind, ToolPermissionCategory, ToolExecutionMode } from '../toolDef.js';

// 文件系统工具
export const FileSystemTool = buildTool({
  name: 'file_system',
  description: '文件系统操作工具，支持读写文件',
  kind: 'write' as ToolKind,
  permissionCategory: 'write' as ToolPermissionCategory,
  executionMode: 'blocking' as ToolExecutionMode,
  parallelSafe: false,
  tags: ['file', 'system']
});

// 网络请求工具
export const WebTool = buildTool({
  name: 'web_request',
  description: '网络请求工具，支持 HTTP 请求',
  kind: 'read' as ToolKind,
  permissionCategory: 'read' as ToolPermissionCategory,
  executionMode: 'blocking' as ToolExecutionMode,
  parallelSafe: true,
  tags: ['web', 'network']
});

// 命令执行工具
export const CommandTool = buildTool({
  name: 'command_execution',
  description: '命令执行工具，支持执行系统命令',
  kind: 'execute' as ToolKind,
  permissionCategory: 'execute' as ToolPermissionCategory,
  executionMode: 'blocking' as ToolExecutionMode,
  parallelSafe: false,
  tags: ['command', 'system']
});

// 代码执行工具
export const CodeExecutionTool = buildTool({
  name: 'code_execution',
  description: '代码执行工具，支持执行 JavaScript/TypeScript 代码',
  kind: 'execute' as ToolKind,
  permissionCategory: 'execute' as ToolPermissionCategory,
  executionMode: 'blocking' as ToolExecutionMode,
  parallelSafe: false,
  tags: ['code', 'execution']
});

// 数据查询工具
export const DatabaseTool = buildTool({
  name: 'database_query',
  description: '数据库查询工具，支持 SQL 查询',
  kind: 'read' as ToolKind,
  permissionCategory: 'read' as ToolPermissionCategory,
  executionMode: 'blocking' as ToolExecutionMode,
  parallelSafe: true,
  tags: ['database', 'sql']
});

// 图像处理工具
export const ImageTool = buildTool({
  name: 'image_processing',
  description: '图像处理工具，支持图像操作',
  kind: 'function' as ToolKind,
  permissionCategory: 'execute' as ToolPermissionCategory,
  executionMode: 'blocking' as ToolExecutionMode,
  parallelSafe: true,
  tags: ['image', 'processing']
});

// 音频处理工具
export const AudioTool = buildTool({
  name: 'audio_processing',
  description: '音频处理工具，支持音频操作',
  kind: 'function' as ToolKind,
  permissionCategory: 'execute' as ToolPermissionCategory,
  executionMode: 'blocking' as ToolExecutionMode,
  parallelSafe: true,
  tags: ['audio', 'processing']
});

// 文本分析工具
export const TextAnalysisTool = buildTool({
  name: 'text_analysis',
  description: '文本分析工具，支持文本处理和分析',
  kind: 'function' as ToolKind,
  permissionCategory: 'read' as ToolPermissionCategory,
  executionMode: 'blocking' as ToolExecutionMode,
  parallelSafe: true,
  tags: ['text', 'analysis']
});

// 数学计算工具
export const MathTool = buildTool({
  name: 'math_calculation',
  description: '数学计算工具，支持各种数学运算',
  kind: 'function' as ToolKind,
  permissionCategory: 'read' as ToolPermissionCategory,
  executionMode: 'blocking' as ToolExecutionMode,
  parallelSafe: true,
  tags: ['math', 'calculation']
});

// 日期处理工具
export const DateTool = buildTool({
  name: 'date_processing',
  description: '日期处理工具，支持日期和时间操作',
  kind: 'function' as ToolKind,
  permissionCategory: 'read' as ToolPermissionCategory,
  executionMode: 'blocking' as ToolExecutionMode,
  parallelSafe: true,
  tags: ['date', 'time']
});

// 数据转换工具
export const DataConversionTool = buildTool({
  name: 'data_conversion',
  description: '数据转换工具，支持各种数据格式转换',
  kind: 'function' as ToolKind,
  permissionCategory: 'read' as ToolPermissionCategory,
  executionMode: 'blocking' as ToolExecutionMode,
  parallelSafe: true,
  tags: ['data', 'conversion']
});
