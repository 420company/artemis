/* eslint-disable @typescript-eslint/no-unused-vars */
import type { ToolDefinition } from "../../core/toolDef.js";
import type { ToolExecutionContext } from "../types.js";
import { z } from "zod";
import * as fs from 'fs/promises';
import * as path from 'path';

interface NotebookEntry {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastAccessed: string;
}

interface WorktreeNode {
  id: string;
  name: string;
  type: 'folder' | 'file' | 'notebook';
  path: string;
  children?: WorktreeNode[];
  notebookId?: string;
  isExpanded?: boolean;
}

const notebooksDir = path.join(process.cwd(), '.artemis', 'notebooks');

// 笔记本编辑和工作树管理工具函数
export async function execNotebookCreate(inp: Record<string, unknown>, cwd: string): Promise<{ ok: boolean; output: string }> {
  const title = String(inp.title ?? '');
  if (!title) {
    return { ok: false, output: "笔记标题不能为空" };
  }

  const newEntry: NotebookEntry = {
    id: Date.now().toString(),
    title: title,
    content: String(inp.content ?? ''),
    tags: Array.isArray(inp.tags) ? inp.tags.map(String) : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastAccessed: new Date().toISOString()
  };

  try {
    await fs.mkdir(notebooksDir, { recursive: true });
    await fs.writeFile(
      path.join(notebooksDir, `${newEntry.id}.json`),
      JSON.stringify(newEntry, null, 2)
    );
    
    return { 
      ok: true, 
      output: JSON.stringify({
        success: true,
        data: { entry: newEntry },
        summary: `笔记创建成功（ID: ${newEntry.id}）`
      }) 
    };
  } catch (error: any) {
    return { ok: false, output: `操作失败: ${error.message}` };
  }
}

export async function execNotebookList(inp: Record<string, unknown>, cwd: string): Promise<{ ok: boolean; output: string }> {
  try {
    await fs.mkdir(notebooksDir, { recursive: true });
    const files = await fs.readdir(notebooksDir);
    const notes = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        const data = JSON.parse(await fs.readFile(path.join(notebooksDir, file), 'utf-8'));
        notes.push(data);
      }
    }

    return { 
      ok: true, 
      output: JSON.stringify({
        success: true,
        data: { notes, count: notes.length },
        summary: `找到 ${notes.length} 个笔记`
      }) 
    };
  } catch (error: any) {
    return { ok: false, output: `操作失败: ${error.message}` };
  }
}

export async function execNotebookUpdate(inp: Record<string, unknown>, cwd: string): Promise<{ ok: boolean; output: string }> {
  const id = String(inp.id ?? '');
  if (!id) {
    return { ok: false, output: "笔记 ID 不能为空" };
  }

  const existingFile = path.join(notebooksDir, `${id}.json`);
  try {
    const existingData = JSON.parse(await fs.readFile(existingFile, 'utf-8'));
    
    const updatedEntry = {
      ...existingData,
      ...(typeof inp.title === 'string' && { title: inp.title }),
      ...(typeof inp.content === 'string' && { content: inp.content }),
      ...(Array.isArray(inp.tags) && { tags: inp.tags.map(String) }),
      updatedAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString()
    };

    await fs.writeFile(existingFile, JSON.stringify(updatedEntry, null, 2));

    return { 
      ok: true, 
      output: JSON.stringify({
        success: true,
        data: { entry: updatedEntry },
        summary: `笔记更新成功（ID: ${id}）`
      }) 
    };
  } catch (error) {
    return { ok: false, output: "笔记未找到" };
  }
}

export async function execNotebookDelete(inp: Record<string, unknown>, cwd: string): Promise<{ ok: boolean; output: string }> {
  const id = String(inp.id ?? '');
  if (!id) {
    return { ok: false, output: "笔记 ID 不能为空" };
  }

  const deleteFile = path.join(notebooksDir, `${id}.json`);
  try {
    await fs.unlink(deleteFile);
    return { 
      ok: true, 
      output: JSON.stringify({
        success: true,
        data: { id },
        summary: `笔记删除成功（ID: ${id}）`
      }) 
    };
  } catch (error) {
    return { ok: false, output: "笔记未找到" };
  }
}

export async function execNotebookView(inp: Record<string, unknown>, cwd: string): Promise<{ ok: boolean; output: string }> {
  const id = String(inp.id ?? '');
  if (!id) {
    return { ok: false, output: "笔记 ID 不能为空" };
  }

  const viewFile = path.join(notebooksDir, `${id}.json`);
  try {
    const viewData = JSON.parse(await fs.readFile(viewFile, 'utf-8'));
    
    viewData.lastAccessed = new Date().toISOString();
    await fs.writeFile(viewFile, JSON.stringify(viewData, null, 2));

    return { 
      ok: true, 
      output: JSON.stringify({
        success: true,
        data: { entry: viewData },
        summary: `笔记查看成功（ID: ${id}）`
      }) 
    };
  } catch (error) {
    return { ok: false, output: "笔记未找到" };
  }
}

export async function execNotebookSearch(inp: Record<string, unknown>, cwd: string): Promise<{ ok: boolean; output: string }> {
  const search = String(inp.search ?? '');
  if (!search) {
    return { ok: false, output: "搜索词不能为空" };
  }

  try {
    const searchFiles = await fs.readdir(notebooksDir);
    const searchResults = [];

    for (const file of searchFiles) {
      if (file.endsWith('.json')) {
        const data = JSON.parse(await fs.readFile(path.join(notebooksDir, file), 'utf-8'));
        
        if (data.title.toLowerCase().includes(search.toLowerCase()) || 
            data.content.toLowerCase().includes(search.toLowerCase()) ||
            data.tags.some((tag: string) => tag.toLowerCase().includes(search.toLowerCase()))) {
          searchResults.push(data);
        }
      }
    }

    return { 
      ok: true, 
      output: JSON.stringify({
        success: true,
        data: { results: searchResults, count: searchResults.length },
        summary: `找到 ${searchResults.length} 个匹配的笔记`
      }) 
    };
  } catch (error: any) {
    return { ok: false, output: `操作失败: ${error.message}` };
  }
}

export async function execNotebookAddTag(inp: Record<string, unknown>, cwd: string): Promise<{ ok: boolean; output: string }> {
  const id = String(inp.id ?? '');
  const tags = Array.isArray(inp.tags) ? inp.tags.map(String) : [];
  
  if (!id || tags.length === 0) {
    return { ok: false, output: "笔记 ID 和标签不能为空" };
  }

  const addTagFile = path.join(notebooksDir, `${id}.json`);
  try {
    const addTagData = JSON.parse(await fs.readFile(addTagFile, 'utf-8'));
    
    const existingTags = new Set(addTagData.tags);
    const newTags = tags.filter(tag => !existingTags.has(tag));
    
    addTagData.tags = [...addTagData.tags, ...newTags];
    addTagData.updatedAt = new Date().toISOString();
    addTagData.lastAccessed = new Date().toISOString();
    
    await fs.writeFile(addTagFile, JSON.stringify(addTagData, null, 2));

    return { 
      ok: true, 
      output: JSON.stringify({
        success: true,
        data: { entry: addTagData, addedTags: newTags },
        summary: `添加了 ${newTags.length} 个新标签`
      }) 
    };
  } catch (error) {
    return { ok: false, output: "笔记未找到" };
  }
}

export async function execNotebookRemoveTag(inp: Record<string, unknown>, cwd: string): Promise<{ ok: boolean; output: string }> {
  const id = String(inp.id ?? '');
  const tags = Array.isArray(inp.tags) ? inp.tags.map(String) : [];
  
  if (!id || tags.length === 0) {
    return { ok: false, output: "笔记 ID 和标签不能为空" };
  }

  const removeTagFile = path.join(notebooksDir, `${id}.json`);
  try {
    const removeTagData = JSON.parse(await fs.readFile(removeTagFile, 'utf-8'));
    
    const tagsBefore = removeTagData.tags.length;
    removeTagData.tags = removeTagData.tags.filter((tag: string) => !tags.includes(tag));
    const removedCount = tagsBefore - removeTagData.tags.length;
    
    removeTagData.updatedAt = new Date().toISOString();
    removeTagData.lastAccessed = new Date().toISOString();
    
    await fs.writeFile(removeTagFile, JSON.stringify(removeTagData, null, 2));

    return { 
      ok: true, 
      output: JSON.stringify({
        success: true,
        data: { entry: removeTagData, removedTags: tags.filter(tag => tagsBefore > removeTagData.tags.length) },
        summary: `移除了 ${removedCount} 个标签`
      }) 
    };
  } catch (error) {
    return { ok: false, output: "笔记未找到" };
  }
}

export async function execNotebookTree(inp: Record<string, unknown>, cwd: string): Promise<{ ok: boolean; output: string }> {
  try {
    const treeNodes: WorktreeNode[] = [];
    
    const treeFiles = await fs.readdir(notebooksDir);
    for (const file of treeFiles) {
      if (file.endsWith('.json')) {
        const data = JSON.parse(await fs.readFile(path.join(notebooksDir, file), 'utf-8'));
        
        treeNodes.push({
          id: data.id,
          name: data.title,
          type: 'notebook',
          path: data.title,
          notebookId: data.id,
          isExpanded: false
        });
      }
    }

    treeNodes.sort((a, b) => a.name.localeCompare(b.name));

    const rootNode: WorktreeNode = {
      id: 'root',
      name: 'Notebooks',
      type: 'folder',
      path: 'Notebooks',
      isExpanded: true,
      children: treeNodes
    };

    return { 
      ok: true, 
      output: JSON.stringify({
        success: true,
        data: { tree: rootNode },
        summary: "工作树结构获取成功"
      }) 
    };
  } catch (error: any) {
    return { ok: false, output: `操作失败: ${error.message}` };
  }
}

// 笔记本编辑和工作树管理工具
export class NotebookWorktreeTool {
  static create(): ToolDefinition {
    return {
      type: "notebook_worktree",
      description: "管理笔记本和工作树结构，支持创建、查看、更新、删除笔记，以及获取工作树结构",
      kind: "function",
      permissionCategory: "read",
      executionMode: "blocking",
      parallelSafe: true,
      tags: ["notebook", "worktree", "notes", "management"],
      validate: (action: any) => {
        const errors: string[] = [];
        if (!action.action || !["create", "list", "update", "delete", "view", "search", "addTag", "removeTag", "tree"].includes(action.action)) {
          errors.push("无效的操作类型");
        }
        if (["create"].includes(action.action)) {
          if (!action.title) errors.push("笔记标题不能为空");
        }
        if (["update", "delete", "view", "addTag", "removeTag"].includes(action.action)) {
          if (!action.id) errors.push("笔记 ID 不能为空");
        }
        if (["search"].includes(action.action)) {
          if (!action.search) errors.push("搜索词不能为空");
        }
        if (["addTag", "removeTag"].includes(action.action)) {
          if (!action.tags || !Array.isArray(action.tags) || action.tags.length === 0) {
            errors.push("标签不能为空且必须是数组类型");
          }
        }
        return errors;
      },
      execute: async (args: any, context: ToolExecutionContext) => {
        try {
          await fs.mkdir(notebooksDir, { recursive: true });

          let result;

          switch (args.action) {
            case 'create':
              result = await execNotebookCreate(args, context.cwd);
              break;

            case 'list':
              result = await execNotebookList(args, context.cwd);
              break;

            case 'update':
              result = await execNotebookUpdate(args, context.cwd);
              break;

            case 'delete':
              result = await execNotebookDelete(args, context.cwd);
              break;

            case 'view':
              result = await execNotebookView(args, context.cwd);
              break;

            case 'search':
              result = await execNotebookSearch(args, context.cwd);
              break;

            case 'addTag':
              result = await execNotebookAddTag(args, context.cwd);
              break;

            case 'removeTag':
              result = await execNotebookRemoveTag(args, context.cwd);
              break;

            case 'tree':
              result = await execNotebookTree(args, context.cwd);
              break;

            default:
              return {
                success: false,
                data: null,
                summary: `未知操作：${args.action}`
              };
          }

          return JSON.parse(result.output);
        } catch (error: any) {
          if (error.code === 'ENOENT') {
            return {
              success: false,
              data: null,
              summary: "笔记未找到"
            };
          }
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