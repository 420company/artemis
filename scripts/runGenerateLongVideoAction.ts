import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { executeGenerateLongVideo } from '../src/tools/generateLongVideo.js';

const actionPath = process.argv[2];
if (!actionPath) throw new Error('Usage: tsx scripts/runGenerateLongVideoAction.ts <action.json>');
const action = JSON.parse(await readFile(actionPath, 'utf8'));

console.log(`[runner] starting generate_long_video projectId=${action.projectId ?? 'auto'} at ${new Date().toISOString()}`);
const heartbeat = setInterval(() => {
  console.log(`[runner] still running ${action.projectId ?? 'auto'} at ${new Date().toISOString()}`);
}, 30_000);

try {
  const result = await executeGenerateLongVideo(action, {
    cwd: process.cwd(),
    locale: 'zh',
    permissionMode: 'trusted',
    sessionId: `manual-rerun-${randomUUID()}`,
  });
  clearInterval(heartbeat);
  console.log(result.output);
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  clearInterval(heartbeat);
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
