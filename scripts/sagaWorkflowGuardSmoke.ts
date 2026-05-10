import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleSagaLongVideoWorkflow } from '../src/tools/visual/sagaWorkflow.js';

async function main(): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'artemis-saga-guard-'));
  const key = `guard-${Date.now()}`;

  const genericTimedVideo = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key,
    cwd,
    locale: 'zh',
    text: '帮我生成一段30秒左右的视频，你的角色现在叫饼干姐姐，亚洲女性，内容是在不同的海滩享受阳光和海风。',
  });
  assert.equal(genericTimedVideo.handled, false, 'generic timed video must not auto-enter Saga without explicit long-video wording');

  const naturalLongVideo = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: `${key}-natural-long`,
    cwd,
    locale: 'zh',
    text: '帮我生成一段长视频',
  });
  assert.equal(naturalLongVideo.handled, true, 'explicit natural-language long-video wording should enter Saga');
  assert.match(naturalLongVideo.reply, /final stitched video duration|最终成片的总时长|目标总时长/i, 'Saga should ask for total stitched duration before collecting refs');

  const afterDuration = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: `${key}-natural-long`,
    cwd,
    locale: 'zh',
    text: '20秒',
  });
  assert.equal(afterDuration.handled, true, 'after total duration confirmation Saga should continue to reference collection');
  assert.match(afterDuration.reply, /Target total duration: 20s|目标总时长：20 秒/, 'duration confirmation should be treated as total duration, not per-segment duration');

  const pastedLog = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: `${key}-paste`,
    cwd,
    locale: 'zh',
    text: [
      '我只是粘贴一段历史记录让你检查，不要触发视频流程：',
      '如果用户配置的视频生成模型是普通模型呢？',
      '你来做一个真实测试，把 model 切到 dreamina-seedance-2-0-fast-260128，测试做合成20秒的视频。',
      '好，要做一段长视频。先把参考材料备齐。',
      '准备好了回复 "开始生成"；想直接开始就回复 "跳过"；不做了回复 "取消"。',
      '问题是：为什么我发什么都会触发视频生成？能不能优化触发逻辑？',
    ].join('\n'),
  });
  assert.equal(pastedLog.handled, false, 'pasted logs/meta discussion with generation words must not enter Saga workflow');



  const mistakenSageAlias = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: `${key}-sage-alias`,
    cwd,
    locale: 'zh',
    text: '/sage 帮我生成一段30秒左右的视频',
  });
  assert.equal(mistakenSageAlias.handled, false, 'the system command is /saga; /sage must not trigger Saga');

  const explicit = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: `${key}-explicit`,
    cwd,
    locale: 'zh',
    forceIntent: true,
    text: '帮我生成一段30秒左右的视频，你的角色现在叫饼干姐姐，亚洲女性，内容是在不同的海滩享受阳光和海风。',
  });
  assert.equal(explicit.handled, true, 'explicit /saga entry should enter Saga workflow');

  const supportQuestion = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: `${key}-explicit`,
    cwd,
    locale: 'zh',
    text: '检查我刚才发送的文字，还有就是为什么我发什么都会触发视频生成啊？你仔细检查一下',
  });
  assert.equal(supportQuestion.handled, false, 'support/debug question must exit Saga workflow and fall through to normal chat');

  const afterExit = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: `${key}-explicit`,
    cwd,
    locale: 'zh',
    text: '这只是一句普通补充，不应该还在视频向导里',
  });
  assert.equal(afterExit.handled, false, 'workflow should remain cleared after support/debug question');

  console.log('saga workflow explicit-trigger guard ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
