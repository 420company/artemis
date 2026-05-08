import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleSagaLongVideoWorkflow } from '../src/tools/visual/sagaWorkflow.js';

async function main(): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'artemis-saga-guard-'));
  const key = `guard-${Date.now()}`;

  const first = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key,
    cwd,
    locale: 'zh',
    text: '帮我生成一段30秒左右的视频，你的角色现在叫饼干姐姐，亚洲女性，内容是在不同的海滩享受阳光和海风。',
  });
  assert.equal(first.handled, true, 'initial long-video request should enter Saga workflow');

  const supportQuestion = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key,
    cwd,
    locale: 'zh',
    text: '检查我刚才发送的文字，还有就是为什么我发什么都会触发视频生成啊？你仔细检查一下',
  });
  assert.equal(supportQuestion.handled, false, 'support/debug question must exit Saga workflow and fall through to normal chat');

  const afterExit = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key,
    cwd,
    locale: 'zh',
    text: '这只是一句普通补充，不应该还在视频向导里',
  });
  assert.equal(afterExit.handled, false, 'workflow should remain cleared after support/debug question');

  console.log('saga workflow support-discussion guard ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
