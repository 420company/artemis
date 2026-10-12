/**
 * Imported first by the CLI entry, so the per-run MCP headers are taken off
 * their inherited descriptor (and the descriptor closed) before any other
 * module is evaluated, let alone a tool started. See inheritedHeaders.ts.
 */
import { loadInheritedMcpHeaders } from './inheritedHeaders.js';

const problem = loadInheritedMcpHeaders();
if (problem) process.stderr.write(`[mcp] ${problem}\n`);
