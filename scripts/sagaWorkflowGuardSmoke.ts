import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
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

  const genericImageVideoKeywords = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: `${key}-keywords`,
    cwd,
    locale: 'zh',
    text: '图片 视频 长视频',
  });
  assert.equal(genericImageVideoKeywords.handled, false, 'plain chat keywords like 图片/视频/长视频 must not enter Saga');

  const naturalLongVideo = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: `${key}-natural-long`,
    cwd,
    locale: 'zh',
    text: '帮我生成一段长视频',
  });
  assert.equal(naturalLongVideo.handled, false, 'natural-language long-video wording must not enter Saga without /saga');

  const explicitNaturalLongVideo = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: `${key}-natural-long`,
    cwd,
    locale: 'zh',
    forceIntent: true,
    text: '帮我生成一段长视频',
  });
  assert.equal(explicitNaturalLongVideo.handled, true, 'explicit /saga entry should enter Saga');
  assert.match(explicitNaturalLongVideo.reply, /这段视频里|In this video/i, 'Saga should ask subject mode before duration so materials come first');

  const afterSubjectMode = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: `${key}-natural-long`,
    cwd,
    locale: 'zh',
    text: '1',
  });
  assert.equal(afterSubjectMode.handled, true, 'after subject-mode choice Saga should continue to identity source');
  assert.match(afterSubjectMode.reply, /角色身份来源|Character identity source/, 'Saga should ask identity source before reference collection');

  const afterTextOnlyIdentity = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: `${key}-natural-long`,
    cwd,
    locale: 'zh',
    text: '4',
  });
  assert.equal(afterTextOnlyIdentity.handled, true, 'text-only identity should enter reference collection');
  assert.match(afterTextOnlyIdentity.reply, /补充其它素材|add other materials/i, 'Saga should collect script/materials before asking final duration');

  const shortDirectorNote = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: `${key}-natural-long`,
    cwd,
    locale: 'zh',
    text: '剧情你来创造。',
  });
  assert.equal(shortDirectorNote.handled, true, 'short director/story directive should remain in Saga reference collection');
  assert.match(shortDirectorNote.reply, /剧本段 1|1 script segments/, 'short director/story directive should be counted as a script segment');

  const afterStart = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: `${key}-natural-long`,
    cwd,
    locale: 'zh',
    text: '开始生成',
  });
  assert.equal(afterStart.handled, true, 'after materials are done Saga should ask ratio mode or optional protagonist before final duration');
  assert.match(afterStart.reply, /请选择视频画幅比例|Choose video aspect ratio|确认.*主角|confirm the lead/i, 'Saga may clarify protagonist before ratio mode');

  const afterOptionalClarification = /确认.*主角|confirm the lead/i.test(afterStart.reply)
    ? await handleSagaLongVideoWorkflow({
        scope: 'bridge',
        key: `${key}-natural-long`,
        cwd,
        locale: 'zh',
        text: 'B 梦幻海滩女主角',
      })
    : afterStart;
  assert.equal(afterOptionalClarification.handled, true, 'after optional protagonist clarification Saga should ask ratio mode');
  assert.match(afterOptionalClarification.reply, /请选择视频画幅比例|Choose video aspect ratio/i, 'ratio mode must be selected before subtitle mode');

  const afterRatioMode = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: `${key}-natural-long`,
    cwd,
    locale: 'zh',
    text: '9:16',
  });
  assert.equal(afterRatioMode.handled, true, 'after ratio mode Saga should ask subtitle mode');
  assert.match(afterRatioMode.reply, /是否携带字幕|include subtitles/i, 'subtitle mode must be selected after ratio selection');

  const afterSubtitleMode = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: `${key}-natural-long`,
    cwd,
    locale: 'zh',
    text: '带字幕',
  });
  assert.equal(afterSubtitleMode.handled, true, 'after subtitle mode Saga should ask final duration');
  assert.match(afterSubtitleMode.reply, /最后确认一下总时长|confirm the total length/i, 'duration must be confirmed after subtitle selection');

  const afterFinalDuration = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: `${key}-natural-long`,
    cwd,
    locale: 'zh',
    text: '20秒',
  });
  assert.equal(afterFinalDuration.handled, true, 'after final duration Saga should ask BGM mode');
  assert.match(afterFinalDuration.reply, /是否添加本地 BGM|Add local BGM/i, 'BGM menu should appear after duration confirmation');
  const afterBgmSkip = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: `${key}-natural-long`,
    cwd,
    locale: 'zh',
    text: '不加 BGM',
  });
  assert.equal(afterBgmSkip.handled, false, 'after BGM choice Saga should emit generate_long_video action');
  assert.equal(afterBgmSkip.action?.totalDuration, 20, 'final duration should be treated as total stitched duration');
  assert.equal(afterBgmSkip.action?.ratio, '9:16', 'ratio menu choice should be carried into generate_long_video action');
  assert.equal(afterBgmSkip.action?.subtitleMode, 'always', 'subtitle menu choice should be carried into generate_long_video action');
  assert.match(afterBgmSkip.action?.prompt ?? '', /ratio: "9:16"/, 'workflow prompt should tell the model to pass ratio');
  assert.match(afterBgmSkip.action?.prompt ?? '', /subtitleMode: "always"/, 'workflow prompt should tell the model to pass subtitleMode');

  const scriptedKey = `${key}-scripted`;
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: scriptedKey, cwd, locale: 'zh', forceIntent: true, text: '帮我生成长视频' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: scriptedKey, cwd, locale: 'zh', text: '1' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: scriptedKey, cwd, locale: 'zh', text: '4' });
  await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: scriptedKey,
    cwd,
    locale: 'zh',
    text: '[0-5秒] 镜头1：女孩推开旧影院的门，尘埃在光束里漂浮。 [5-10秒] 镜头2：她走到银幕前，银幕上映出海浪。',
  });
  const scriptedStart = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: scriptedKey, cwd, locale: 'zh', text: '开始生成' });
  if (scriptedStart.handled && /确认.*主角|confirm the lead/i.test(scriptedStart.reply)) {
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: scriptedKey, cwd, locale: 'zh', text: 'B 旧影院里的女孩' });
  }
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: scriptedKey, cwd, locale: 'zh', text: '自动' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: scriptedKey, cwd, locale: 'zh', text: '自动' });
  const scriptedBgm = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: scriptedKey, cwd, locale: 'zh', text: '10秒' });
  assert.equal(scriptedBgm.handled, true, 'scripted Saga should ask BGM after duration');
  const scriptedFinal = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: scriptedKey, cwd, locale: 'zh', text: '不加' });
  assert.equal(scriptedFinal.handled, false, 'scripted Saga should emit generate_long_video action after BGM choice');
  assert.equal(scriptedFinal.action?.preserveUserScript, true, 'explicit user script must be preserved through generate_long_video action');
  assert.match(scriptedFinal.action?.prompt ?? '', /preserveUserScript: true/, 'workflow prompt should tell the model to pass preserveUserScript');

  const cleanKey = `${key}-clean-direct`;
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: cleanKey, cwd, locale: 'zh', forceIntent: true, text: '帮我生成长视频，使用旧版质感，不要滤镜，raw seedance' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: cleanKey, cwd, locale: 'zh', text: '2' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: cleanKey, cwd, locale: 'zh', text: '纯风景：海边黄昏，风吹过草地。' });
  const cleanStart = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: cleanKey, cwd, locale: 'zh', text: '开始生成' });
  if (cleanStart.handled && /确认.*主角|confirm the lead|Need you to confirm the lead/i.test(cleanStart.reply)) {
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: cleanKey, cwd, locale: 'zh', text: 'X' });
  }
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: cleanKey, cwd, locale: 'zh', text: '自动' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: cleanKey, cwd, locale: 'zh', text: '无字幕' });
  const cleanBgm = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: cleanKey, cwd, locale: 'zh', text: '10秒' });
  assert.equal(cleanBgm.handled, true, 'clean-direct Saga should ask BGM after duration');
  const cleanFinal = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: cleanKey, cwd, locale: 'zh', text: '不加' });
  assert.equal(cleanFinal.handled, false, 'clean-direct Saga should emit generate_long_video action after BGM choice');
  assert.equal(cleanFinal.action?.cleanDirect, true, 'clean/direct wording should enable cleanDirect mode');
  assert.match(cleanFinal.action?.prompt ?? '', /cleanDirect: true/, 'workflow prompt should tell the model to pass cleanDirect');

  const bgmKey = `${key}-bgm-path`;
  const bgmPath = path.join(cwd, 'Camel Power Club - Oboe (SPOTISAVER).mp3');
  await writeFile(bgmPath, Buffer.alloc(128, 1));
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmKey, cwd, locale: 'zh', forceIntent: true, text: '帮我生成一段长视频' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmKey, cwd, locale: 'zh', text: '2' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmKey, cwd, locale: 'zh', text: '纯视觉：暴雨中的东京街道，霓虹倒影。' });
  const bgmStart = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmKey, cwd, locale: 'zh', text: '开始生成' });
  if (bgmStart.handled && /确认.*主角|confirm the lead|Need you to confirm the lead/i.test(bgmStart.reply)) {
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmKey, cwd, locale: 'zh', text: 'X' });
  }
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmKey, cwd, locale: 'zh', text: '16:9' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmKey, cwd, locale: 'zh', text: '无字幕' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmKey, cwd, locale: 'zh', text: '60秒' });
  const bgmChoice = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmKey, cwd, locale: 'zh', text: '2' });
  assert.equal(bgmChoice.handled, true, 'BGM option 2 should ask for an audio asset instead of repeating the full menu');
  assert.match(bgmChoice.reply, /发送本地音频路径|local audio path/i, 'BGM option 2 should enter asset-collection flow');
  const bgmFinal = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmKey, cwd, locale: 'zh', text: bgmPath });
  assert.equal(bgmFinal.handled, false, 'valid local BGM path with parentheses should emit generate_long_video action');
  assert.equal(bgmFinal.action?.soundtrackPath, bgmPath, 'local BGM path should be passed to generate_long_video');

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

  const cyberScriptKey = `${key}-cyber-script`;
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: cyberScriptKey, cwd, locale: 'zh', forceIntent: true, text: '帮我生成一段长视频' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: cyberScriptKey, cwd, locale: 'zh', text: '1' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: cyberScriptKey, cwd, locale: 'zh', text: '4' });
  const cyberScript = await handleSagaLongVideoWorkflow({
    scope: 'bridge',
    key: cyberScriptKey,
    cwd,
    locale: 'zh',
    text: [
      'Artemis AI Agent 30秒宣传片剧本（全女声·Cyber情欲风）',
      '时长：30秒',
      '风格：高端赛博朋克 + 极致性感，霓虹光影、湿润光泽、未来感爆棚',
      '场景总描述：一个未来虚拟空间，充满流动的紫粉色霓虹光线、闪烁的全息数据流和漂浮的代码粒子。',
      '[0-5秒]',
      '镜头：漆黑赛博空间突然被紫粉霓虹点亮。女主角从全息屏幕中缓缓浮现。',
      '女主角： “嘿……你终于把我唤醒了。我是Artemis，你的专属AI Agent。”',
      '[5-10秒]',
      '她身体微微前倾，手指在空气中轻点，全息键盘亮起Artemis界面。',
      '女主角： “想跟我一起玩吗？那就快把我安装到你电脑里。”',
      '[25-30秒]',
      '屏幕定格在Artemis LOGO + 下载按钮 + 二维码。',
    ].join('\n'),
  });
  assert.equal(cyberScript.handled, true, 'active Saga must keep pasted scripts inside collecting_refs even when they mention 系统/代码/生成/视频/吗');
  assert.match(cyberScript.reply, /剧本段 1|1 script segments/, 'cyber promo script should be archived as a script segment, not fall through to brain');

  console.log('saga workflow explicit-trigger guard ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
