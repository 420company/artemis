/* eslint-disable no-case-declarations */
import type { ToolDefinition } from "../../core/toolDef.js";
import type { ToolExecutionContext } from "../types.js";
import * as fs from 'fs/promises';
import * as path from 'path';

// MCP (Model Context Protocol) 协议实现
export class MCPTool {
  private static configFile = path.join(process.cwd(), '.artemis', 'mcp-config.json');
  private static serversDir = path.join(process.cwd(), '.artemis', 'mcp-servers');

  static create(): ToolDefinition {
    return {
      type: "mcp",
      description: "MCP (Model Context Protocol) 协议集成工具，用于管理和连接外部工具服务器",
      kind: "function",
      permissionCategory: "agent",
      executionMode: "blocking",
      parallelSafe: true,
      tags: ["mcp", "protocol", "integration"],
      validate: (action: any) => {
        const errors: string[] = [];
        if (!action.action || !["list", "add", "remove", "connect", "disconnect", "info", "update"].includes(action.action)) {
          errors.push("无效的操作类型");
        }
        if (["add"].includes(action.action)) {
          if (!action.name) errors.push("服务器名称不能为空");
          if (!action.url) errors.push("服务器 URL 不能为空");
        }
        if (["remove", "connect", "disconnect", "update", "info"].includes(action.action)) {
          if (!action.serverId && !action.name) errors.push("服务器 ID 或名称不能为空");
        }
        return errors;
      },
      execute: async (args: any, _context: ToolExecutionContext) => {
        try {
          // 确保目录存在
          await fs.mkdir(path.dirname(MCPTool.configFile), { recursive: true });
          await fs.mkdir(MCPTool.serversDir, { recursive: true });

          // 读取 MCP 配置
          let config: any = {
            servers: []
          };
          try {
            const data = await fs.readFile(MCPTool.configFile, 'utf-8');
            config = JSON.parse(data);
          } catch (error: any) {
            if (error.code !== 'ENOENT') {
              throw error;
            }
          }

          let result;

          switch (args.action) {
            case 'list':
              result = {
                success: true,
                data: {
                  servers: config.servers,
                  count: config.servers.length
                },
                summary: `找到 ${config.servers.length} 个 MCP 服务器配置`
              };
              break;

            case 'add':
              if (!args.name || !args.url) {
                return {
                  success: false,
                  data: null,
                  summary: "服务器名称和 URL 不能为空"
                };
              }

              // 检查是否已存在同名服务器
              if (config.servers.find((server: any) => server.name === args.name)) {
                return {
                  success: false,
                  data: null,
                  summary: "已存在同名的服务器配置"
                };
              }

              const newServer = {
                id: Date.now().toString(),
                name: args.name,
                url: args.url,
                config: args.config || {},
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                connected: false
              };

              config.servers.push(newServer);
              await fs.writeFile(MCPTool.configFile, JSON.stringify(config, null, 2));

              result = {
                success: true,
                data: {
                  server: newServer
                },
                summary: `服务器添加成功（名称: ${newServer.name}）`
              };
              break;

            case 'remove':
              if (!args.serverId && !args.name) {
                return {
                  success: false,
                  data: null,
                  summary: "服务器 ID 或名称不能为空"
                };
              }

              const serverIndex = config.servers.findIndex((server: any) => 
                server.id === args.serverId || server.name === args.name
              );

              if (serverIndex === -1) {
                return {
                  success: false,
                  data: null,
                  summary: "服务器未找到"
                };
              }

              const removedServer = config.servers[serverIndex];
              config.servers.splice(serverIndex, 1);
              await fs.writeFile(MCPTool.configFile, JSON.stringify(config, null, 2));

              result = {
                success: true,
                data: {
                  server: removedServer
                },
                summary: `服务器删除成功（名称: ${removedServer.name}）`
              };
              break;

            case 'connect':
              if (!args.serverId && !args.name) {
                return {
                  success: false,
                  data: null,
                  summary: "服务器 ID 或名称不能为空"
                };
              }

              const connectIndex = config.servers.findIndex((server: any) => 
                server.id === args.serverId || server.name === args.name
              );

              if (connectIndex === -1) {
                return {
                  success: false,
                  data: null,
                  summary: "服务器未找到"
                };
              }

              const serverToConnect = config.servers[connectIndex];

              try {
                // 尝试连接到 MCP 服务器
                const response = await MCPTool.testConnection(serverToConnect.url, args.timeout || 10);
                
                config.servers[connectIndex] = {
                  ...serverToConnect,
                  connected: true,
                  lastConnected: new Date().toISOString()
                };

                await fs.writeFile(MCPTool.configFile, JSON.stringify(config, null, 2));

                result = {
                  success: true,
                  data: {
                    server: config.servers[connectIndex],
                    connectionTest: response
                  },
                  summary: `服务器连接成功（名称: ${serverToConnect.name}）`
                };
              } catch (error: any) {
                return {
                  success: false,
                  data: null,
                  summary: `服务器连接失败: ${error.message}`
                };
              }
              break;

            case 'disconnect':
              if (!args.serverId && !args.name) {
                return {
                  success: false,
                  data: null,
                  summary: "服务器 ID 或名称不能为空"
                };
              }

              const disconnectIndex = config.servers.findIndex((server: any) => 
                server.id === args.serverId || server.name === args.name
              );

              if (disconnectIndex === -1) {
                return {
                  success: false,
                  data: null,
                  summary: "服务器未找到"
                };
              }

              const serverToDisconnect = config.servers[disconnectIndex];
              config.servers[disconnectIndex] = {
                ...serverToDisconnect,
                connected: false
              };
              await fs.writeFile(MCPTool.configFile, JSON.stringify(config, null, 2));

              result = {
                success: true,
                data: {
                  server: config.servers[disconnectIndex]
                },
                summary: `服务器断开连接成功（名称: ${serverToDisconnect.name}）`
              };
              break;

            case 'update':
              if (!args.serverId && !args.name) {
                return {
                  success: false,
                  data: null,
                  summary: "服务器 ID 或名称不能为空"
                };
              }

              const updateIndex = config.servers.findIndex((server: any) => 
                server.id === args.serverId || server.name === args.name
              );

              if (updateIndex === -1) {
                return {
                  success: false,
                  data: null,
                  summary: "服务器未找到"
                };
              }

              const serverToUpdate = config.servers[updateIndex];
              config.servers[updateIndex] = {
                ...serverToUpdate,
                ...(args.name && { name: args.name }),
                ...(args.url && { url: args.url }),
                ...(args.config && { config: { ...serverToUpdate.config, ...args.config } }),
                updatedAt: new Date().toISOString()
              };

              await fs.writeFile(MCPTool.configFile, JSON.stringify(config, null, 2));

              result = {
                success: true,
                data: {
                  server: config.servers[updateIndex]
                },
                summary: `服务器更新成功（名称: ${config.servers[updateIndex].name}）`
              };
              break;

            case 'info':
              if (!args.serverId && !args.name) {
                return {
                  success: false,
                  data: null,
                  summary: "服务器 ID 或名称不能为空"
                };
              }

              const infoIndex = config.servers.findIndex((server: any) => 
                server.id === args.serverId || server.name === args.name
              );

              if (infoIndex === -1) {
                return {
                  success: false,
                  data: null,
                  summary: "服务器未找到"
                };
              }

              const serverInfo = config.servers[infoIndex];
              
              // 获取服务器信息
              try {
                const serverData = await MCPTool.getServerInfo(serverInfo.url, args.timeout || 10);
                result = {
                  success: true,
                  data: {
                    ...serverInfo,
                    serverData
                  },
                  summary: `服务器信息获取成功（名称: ${serverInfo.name}）`
                };
              } catch (error: any) {
                return {
                  success: false,
                  data: null,
                  summary: `无法获取服务器信息: ${error.message}`
                };
              }
              break;

            default:
              return {
                success: false,
                data: null,
                summary: `未知操作: ${args.action}`
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

  // 测试与 MCP 服务器的连接
  private static async testConnection(url: string, timeout: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('连接超时'));
      }, timeout * 1000);

      // 简单的 HTTP 请求检查
      fetch(url)
        .then(response => {
          clearTimeout(timeoutId);
          if (response.ok) {
            resolve({
              success: true,
              status: response.status,
              statusText: response.statusText
            });
          } else {
            reject(new Error(`HTTP ${response.status}: ${response.statusText}`));
          }
        })
        .catch(error => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  // 获取 MCP 服务器信息
  private static async getServerInfo(url: string, timeout: number): Promise<any> {
    try {
      // 尝试获取服务器描述
      const response = await fetch(`${url}/describe`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(timeout * 1000)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch {
      // 如果无法获取详细信息，至少返回基本连接信息
      return {
        available: true,
        description: '无法获取服务器详细信息'
      };
    }
  }
}
