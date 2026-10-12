/**
 * core/todoList.ts — the `todo` tool: the run's plan as a checklist.
 *
 * The model sends the whole list each time (add, reorder, tick off: one
 * call). It is kept on the conversation's task board (`session.tasks`, the
 * same board the JSON envelope's `tasks` field fills, restored after a
 * context compaction), and every change is reported to the host as
 * `[tasks] updated` with a `todo` progress event (core/progressEvents.ts),
 * which the web app shows as the plan in its 任务进度 panel.
 */

import type { SessionRecord, TaskItem, TaskStatus } from './types.js';

export const MAX_TODO_ITEMS = 30;
export const MAX_TODO_CHARS = 200;
const STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed', 'blocked'];

export type TodoAction = { type: 'todo'; todos: Array<{ id?: string; content: string; status?: TaskStatus }> };

export function validateTodoAction(action: unknown): string[] {
  const errors: string[] = [];
  const todos = (action as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(todos)) return ['todos must be an array of {content, status}'];
  if (todos.length > MAX_TODO_ITEMS) errors.push(`todos: at most ${MAX_TODO_ITEMS} items`);
  todos.forEach((item, index) => {
    const entry = item as { content?: unknown; status?: unknown; id?: unknown } | null;
    if (!entry || typeof entry !== 'object') {
      errors.push(`todos[${index}] must be an object`);
      return;
    }
    if (typeof entry.content !== 'string' || !entry.content.trim()) errors.push(`todos[${index}].content must be a non-empty string`);
    else if ([...entry.content.trim()].length > MAX_TODO_CHARS) errors.push(`todos[${index}].content: at most ${MAX_TODO_CHARS} characters`);
    if (entry.status !== undefined && !STATUSES.includes(entry.status as TaskStatus)) errors.push(`todos[${index}].status must be one of ${STATUSES.join(', ')}`);
    if (entry.id !== undefined && (typeof entry.id !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(entry.id))) errors.push(`todos[${index}].id must be a short word`);
  });
  return errors;
}

/** The list as stored: ids kept or given (`t1`, `t2`, …), statuses defaulted, duplicates of an id renamed. */
export function normalizeTodos(todos: TodoAction['todos']): TaskItem[] {
  const seen = new Set<string>();
  return todos.slice(0, MAX_TODO_ITEMS).map((item, index) => {
    let id = typeof item.id === 'string' && item.id ? item.id : `t${index + 1}`;
    if (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    return {
      id,
      content: item.content.trim().replace(/\s+/g, ' '),
      status: STATUSES.includes(item.status as TaskStatus) ? (item.status as TaskStatus) : 'pending',
    };
  });
}

const MARK: Record<TaskStatus, string> = { pending: '[ ]', in_progress: '[>]', completed: '[x]', blocked: '[!]' };

/** What the model reads back: the list as it now stands. */
export function renderTodos(items: readonly TaskItem[]): string {
  if (!items.length) return 'The plan is now empty.';
  const done = items.filter((item) => item.status === 'completed').length;
  return [`Plan updated (${done}/${items.length} done):`, ...items.map((item) => `${MARK[item.status]} ${item.id}. ${item.content}`)].join('\n');
}

/** Replaces the conversation's task board with the new list. */
export function applyTodos(session: SessionRecord, action: TodoAction): TaskItem[] {
  const items = normalizeTodos(action.todos);
  session.tasks = items;
  return items;
}
