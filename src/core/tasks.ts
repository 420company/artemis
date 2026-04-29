/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars, @typescript-eslint/no-var-requires */
import type { SessionRecord, TaskItem, TaskStatus } from './types.js';

const VERIFICATION_TASK_PATTERN =
  /\b(verif(?:y|ication)?|test(?:s|ing)?|lint|typecheck|smoke|check)\b/i;
const TASK_BOARD_USAGE_LINES = [
  'Usage:',
  'tasks',
  'tasks add <content>',
  'tasks start <id>',
  'tasks done <id>',
  'tasks block <id>',
  'tasks pending <id>',
  'tasks remove <id>',
  'tasks clear',
];

export type TaskBoardCommand =
  | { type: 'show' }
  | { type: 'help' }
  | { type: 'add'; content: string }
  | { type: 'status'; id: string; status: TaskStatus }
  | { type: 'remove'; id: string }
  | { type: 'clear' }
  | { type: 'invalid'; reason: string };

export type TaskBoardCommandResult = {
  ok: boolean;
  changed: boolean;
  showBoard: boolean;
  tasks: TaskItem[];
  message: string;
};

export function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    value === 'pending' ||
    value === 'in_progress' ||
    value === 'completed' ||
    value === 'blocked'
  );
}

export function normalizeTasks(input: unknown): TaskItem[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const item = entry as Partial<TaskItem>;
      
      if (!item.id || typeof item.id !== 'string') {
        item.id = `task-${index}`;
      }
      
      if (!isTaskStatus(item.status)) {
        item.status = 'pending';
      }
      
      if (!item.content || typeof item.content !== 'string') {
        item.content = 'Untitled task';
      }
      
      return item as TaskItem;
    })
    .filter(Boolean) as TaskItem[];
}

export function buildTaskVerificationNudge(tasks: TaskItem[]): string | null {
  const hasUnverifiedTasks = tasks.some(task => 
    task.status === 'in_progress' && VERIFICATION_TASK_PATTERN.test(task.content)
  );
  
  if (!hasUnverifiedTasks) {
    return null;
  }
  
  return 'Some verification tasks are in progress. Would you like to mark them as completed?';
}

export function didTaskBoardJustCloseWithoutVerification(previousTasks: TaskItem[], nextTasks: TaskItem[]): boolean {
  const previousInProgressVerificationTasks = previousTasks.filter(task => 
    task.status === 'in_progress' && VERIFICATION_TASK_PATTERN.test(task.content)
  );
  
  const nextInProgressVerificationTasks = nextTasks.filter(task => 
    task.status === 'in_progress' && VERIFICATION_TASK_PATTERN.test(task.content)
  );
  
  return previousInProgressVerificationTasks.length > 0 && nextInProgressVerificationTasks.length === 0;
}

import type { Task, TaskType } from './Task.js'
import { DreamTask } from './Task.js'
import { LocalAgentTask } from './Task.js'
import { LocalShellTask } from './Task.js'
import { RemoteAgentTask } from './Task.js'

/**
 * Get all tasks.
 * Mirrors the pattern from tools.ts
 * Note: Returns array inline to avoid circular dependency issues with top-level const
 */
export function getAllTasks(): Task[] {
  const tasks: Task[] = [
    new LocalShellTask(),
    new LocalAgentTask(),
    new RemoteAgentTask(),
    new DreamTask(),
  ]
  
  // Feature flag for additional tasks
  const isWorkflowEnabled = true // This could be a config option
  const isMonitorEnabled = true  // This could be a config option
  
  if (isWorkflowEnabled) {
    const { LocalWorkflowTask } = require('./Task.js')
    tasks.push(new LocalWorkflowTask())
  }
  
  if (isMonitorEnabled) {
    const { MonitorMcpTask } = require('./Task.js')
    tasks.push(new MonitorMcpTask())
  }
  
  // Add additional tasks if features are enabled
  const additionalTasks = [
    { flag: 'IN_PROCESS_TEAMMATE', name: 'InProcessTeammateTask' },
    { flag: 'LOCAL_MAIN_SESSION', name: 'LocalMainSessionTask' }
  ]
  
  additionalTasks.forEach(({ flag, name }) => {
    const isEnabled = true // This could be a feature flag check
    if (isEnabled) {
      const { [name]: TaskClass } = require('./Task.js')
      tasks.push(new TaskClass())
    }
  })
  
  return tasks
}

/**
 * Get a task by its type.
 */
export function getTaskByType(type: TaskType): Task | undefined {
  return getAllTasks().find(t => t.type === type)
}

/**
 * Get a task by its id.
 */
export function getTaskById(id: string): Task | undefined {
  return getAllTasks().find(t => t.id === id)
}

/**
 * Get task definitions for configuration.
 */
export function getTaskDefinitions() {
  return getAllTasks().map(task => ({
    type: task.type,
    id: task.id,
    name: task.name,
    description: task.description
  }))
}

/**
 * Check if a task type exists.
 */
export function isValidTaskType(type: string): type is TaskType {
  const validTypes = [
    'local_shell',
    'local_agent',
    'remote_agent',
    'dream',
    'local_workflow',
    'monitor_mcp',
    'in_process_teammate',
    'local_main_session'
  ]
  return validTypes.includes(type)
}

/**
 * Get default task configuration.
 */
export function getDefaultTaskConfig(type: TaskType): any {
  const configs: Record<TaskType, any> = {
    local_shell: { command: 'echo "Hello, World!"' },
    local_agent: { agent: 'default' },
    remote_agent: { server: 'localhost:3000' },
    dream: { context: 'general' },
    local_workflow: { workflow: 'default' },
    monitor_mcp: { server: 'localhost:3000', interval: 30000 },
    in_process_teammate: { role: 'code-review' },
    local_main_session: { sessionId: 'default' }
  }
  
  return configs[type] || {}
}