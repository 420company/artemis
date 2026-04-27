import type { ToolDefinition } from "../../core/toolDef.js";
import type { ToolExecutionContext } from "../types.js";
import { z } from "zod";
import axios from "axios";
import * as cheerio from "cheerio";

// 网络搜索工具
export class SearchTool {
  static create(): ToolDefinition {
    return {
      type: "search",
      description: "在网络上搜索信息",
      kind: "function",
      permissionCategory: "read",
      executionMode: "blocking",
      parallelSafe: true,
      tags: ["search", "web"],
      validate: (action: any) => {
        const errors: string[] = [];
        if (!action.query) {
          errors.push("query is required");
        }
        if (action.limit && (typeof action.limit !== "number" || action.limit < 1 || action.limit > 100)) {
          errors.push("limit must be a number between 1 and 100");
        }
        return errors;
      },
      execute: async (args: any, context: ToolExecutionContext) => {
        try {
          // 使用 Google 搜索 API（需要配置）
          const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(args.query)}&num=${args.limit}`;
          const response = await axios.get(searchUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            }
          });

          const $ = cheerio.load(response.data);
          const results: any[] = [];

          $("div.g").each((index: number, element: any) => {
            const title = $(element).find("h3").text();
            const link = $(element).find("a").attr("href");
            const snippet = $(element).find(".VwiC3b").text();

            if (title && link && snippet) {
              // 解析 URL
              let parsedLink = link;
              if (link.startsWith("/url?q=")) {
                parsedLink = decodeURIComponent(link.split("/url?q=")[1].split("&")[0]);
              }

              results.push({
                title,
                url: parsedLink,
                snippet,
                index: index + 1
              });
            }
          });

          return {
            success: true,
            data: {
              query: args.query,
              results_count: results.length,
              results: results.slice(0, args.limit),
              search_engine: "Google"
            },
            summary: `找到 ${results.length} 个与 "${args.query}" 相关的结果`
          };
        } catch (error: any) {
          return {
            success: false,
            data: null,
            summary: `搜索失败: ${error.message}`
          };
        }
      }
    };
  }
}

// 网页内容提取工具
export class WebScraperTool {
  static create(): ToolDefinition {
    return {
      type: "web_scraper",
      description: "从指定 URL 提取网页内容",
      kind: "function",
      permissionCategory: "read",
      executionMode: "blocking",
      parallelSafe: true,
      tags: ["web", "scraper", "content"],
      validate: (action: any) => {
        const errors: string[] = [];
        if (!action.url) {
          errors.push("url is required");
        } else if (!action.url.startsWith("http://") && !action.url.startsWith("https://")) {
          errors.push("url must be a valid HTTP or HTTPS URL");
        }
        if (action.selectors && !Array.isArray(action.selectors)) {
          errors.push("selectors must be an array of strings");
        }
        if (action.remove_selectors && !Array.isArray(action.remove_selectors)) {
          errors.push("remove_selectors must be an array of strings");
        }
        return errors;
      },
      execute: async (args: any, context: ToolExecutionContext) => {
        try {
          const response = await axios.get(args.url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
            }
          });

          const $ = cheerio.load(response.data);

          // 移除不需要的内容
          if (args.remove_selectors) {
            args.remove_selectors.forEach((selector: string) => {
              $(selector).remove();
            });
          }

          let content = "";

          if (args.selectors) {
            // 只提取指定选择器的内容
            content = args.selectors.map((selector: string) => {
              return $(selector).text().trim();
            }).join("\n");
          } else {
            // 提取整个页面的文本内容
            content = $("body").text().trim();
          }

          // 清理内容
          content = content.replace(/\s+/g, " ").trim();

          return {
            success: true,
            data: {
              url: args.url,
              title: $("title").text().trim(),
              content: content,
              content_length: content.length
            },
            summary: `成功提取网页内容，长度: ${content.length} 字符`
          };
        } catch (error: any) {
          return {
            success: false,
            data: null,
            summary: `网页抓取失败: ${error.message}`
          };
        }
      }
    };
  }
}