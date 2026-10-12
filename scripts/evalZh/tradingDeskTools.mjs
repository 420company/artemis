// The trading desk stub's tools (tradingDeskStub.mjs), also written into the
// task's MCP config by the worker so the agent sees them from the first turn.
// tradingDeskTools.json is generated from the platform server's own tool
// list (artemis-online: `npm run export:trading-tools`), so the eval agent
// reads the real descriptions and schemas; regenerate it when they change.
import { readFileSync } from 'node:fs'

const data = JSON.parse(readFileSync(new URL('./tradingDeskTools.json', import.meta.url), 'utf8'))

export const TOOLS = data.tools
