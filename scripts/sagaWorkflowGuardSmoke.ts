import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderStore } from '../src/providers/store.js';
import { extractRequestedResolution, handleSagaLongVideoWorkflow } from '../src/tools/visual/sagaWorkflow.js';
import { BYTEPLUS_SEEDANCE_2_PRO_MODEL } from '../src/tools/visual/videoCapabilities.js';
import { extractBriefAspectRatio, normalizeAspectRatio, normalizeVideoRatioArgument } from '../src/tools/visual/aspectRatio.js';

// Explicit /saga entry only starts the wizard when a video provider is
// configured (resolveConfiguredVisualProvider). Configure one in the temp
// workspace so the smoke is hermetic: it must not depend on whatever the
// machine running it has in ~/.artemis/providers.json. The workspace store
// is checked before the home store, so a real home key is never used here.
async function configureVideoProfile(cwd: string): Promise<void> {
  const store = new ProviderStore(cwd);
  const data = await store.load();
  data.visualProfile = {
    enabled: true,
    image: {
      provider: 'byteplus',
      apiKey: 'smoke-key',
      baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
      model: 'seedream-5-0-260128',
    },
    video: {
      enabled: true,
      provider: 'byteplus',
      apiKey: 'smoke-key',
      baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
      model: BYTEPLUS_SEEDANCE_2_PRO_MODEL,
    },
  };
  await store.save(data);
}

async function main(): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'artemis-saga-guard-'));
  await configureVideoProfile(cwd);
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
  assert.match(afterFinalDuration.reply, /是否添加背景音乐|Add background music/i, 'BGM menu should appear after duration confirmation');
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
  const bgmAfterPath = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmKey, cwd, locale: 'zh', text: bgmPath });
  assert.equal(bgmAfterPath.handled, true, 'path-only BGM reply should open the mix-settings follow-up, not start generation');
  assert.match(bgmAfterPath.reply ?? '', /已接收音乐|Music received|调整混音参数|Adjust the mix/, 'mix-settings follow-up should reference defaults and the captured music file');
  const bgmFinal = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmKey, cwd, locale: 'zh', text: 'default' });
  assert.equal(bgmFinal.handled, false, 'default reply in mix-settings step should emit generate_long_video');
  assert.equal(bgmFinal.action?.soundtrackPath, bgmPath, 'local BGM path should be passed to generate_long_video');
  assert.equal(bgmFinal.action?.soundtrackStartSec, undefined, 'mix-settings defaults must keep startSec undefined (renderer applies 0s)');
  assert.equal(bgmFinal.action?.soundtrackVolumeDb, undefined, 'mix-settings defaults must keep music volume undefined (renderer applies -12dB)');

  const bgmInlineKey = `${key}-bgm-inline`;
  const bgmInlinePath = path.join(cwd, 'inline-bgm.mp3');
  await writeFile(bgmInlinePath, Buffer.alloc(128, 1));
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmInlineKey, cwd, locale: 'zh', forceIntent: true, text: '帮我生成一段长视频' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmInlineKey, cwd, locale: 'zh', text: '2' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmInlineKey, cwd, locale: 'zh', text: '纯视觉：雨夜东京。' });
  const bgmInlineStart = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmInlineKey, cwd, locale: 'zh', text: '开始生成' });
  if (bgmInlineStart.handled && /确认.*主角|confirm the lead/i.test(bgmInlineStart.reply)) {
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmInlineKey, cwd, locale: 'zh', text: 'X' });
  }
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmInlineKey, cwd, locale: 'zh', text: '16:9' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmInlineKey, cwd, locale: 'zh', text: '无字幕' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmInlineKey, cwd, locale: 'zh', text: '60秒' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmInlineKey, cwd, locale: 'zh', text: '2' });
  const bgmInlineFinal = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmInlineKey, cwd, locale: 'zh', text: `${bgmInlinePath} 从1:19开始 音量-15dB 淡出2秒` });
  assert.equal(bgmInlineFinal.handled, false, 'inline mix params with the path should skip the follow-up and emit generate_long_video');
  assert.equal(bgmInlineFinal.action?.soundtrackPath, bgmInlinePath, 'inline-params flow must keep the BGM path');
  assert.equal(bgmInlineFinal.action?.soundtrackStartSec, 79, 'inline 从1:19开始 should set soundtrackStartSec to 79');
  assert.equal(bgmInlineFinal.action?.soundtrackVolumeDb, -15, 'inline 音量-15dB should set soundtrackVolumeDb to -15');
  assert.equal(bgmInlineFinal.action?.soundtrackFadeOutSec, 2, 'inline 淡出2秒 should set soundtrackFadeOutSec to 2');

  // "环境音音量 / 环境音量 / 环境声音量 / ambient sound volume -18dB" set the ambience level
  // and leave the music volume alone.
  for (const [index, reply] of ['环境音音量 -18dB', '环境音量 -18dB', '环境声音量 -18dB', 'ambient sound volume -18dB'].entries()) {
    const ambienceKey = `${key}-bgm-ambience-${index}`;
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: ambienceKey, cwd, locale: 'zh', forceIntent: true, text: '帮我生成一段长视频' });
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: ambienceKey, cwd, locale: 'zh', text: '2' });
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: ambienceKey, cwd, locale: 'zh', text: '纯视觉：雨夜东京。' });
    const ambienceStart = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: ambienceKey, cwd, locale: 'zh', text: '开始生成' });
    if (ambienceStart.handled && /确认.*主角|confirm the lead/i.test(ambienceStart.reply)) {
      await handleSagaLongVideoWorkflow({ scope: 'bridge', key: ambienceKey, cwd, locale: 'zh', text: 'X' });
    }
    for (const answer of ['16:9', '无字幕', '60秒', '2']) await handleSagaLongVideoWorkflow({ scope: 'bridge', key: ambienceKey, cwd, locale: 'zh', text: answer });
    const ambienceFinal = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: ambienceKey, cwd, locale: 'zh', text: `${bgmInlinePath} ${reply}` });
    assert.equal(ambienceFinal.action?.environmentVolumeDb, -18, `"${reply}" sets the ambience level`);
    assert.equal(ambienceFinal.action?.soundtrackVolumeDb, undefined, `"${reply}" never sets the music volume`);
  }

  // Guide §9.6: a declared subject mode / identity source skips those questions.
  const declaredText = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: `${key}-declared-text`, cwd, locale: 'zh-CN', forceIntent: true, text: '主体模式：有主角。身份来源：纯文字。\n[0-5秒] 镜头1：风筝飞过山坡。\n[5-10秒] 镜头2：风筝落进草地。' });
  assert.match(declaredText.reply, /已按剧本设定：有主角 · 身份来源：纯文字/);
  assert.match(declaredText.reply, /补充其它素材/, 'text-only identity goes straight to the materials step');
  const declaredVisual = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: `${key}-declared-visual`, cwd, locale: 'zh-CN', forceIntent: true, text: '主体模式：纯视觉 / 无主角。\n[0-5秒] 雨中的山谷。\n[5-10秒] 云雾散开。' });
  assert.match(declaredVisual.reply, /已按剧本设定：纯视觉/);
  assert.doesNotMatch(declaredVisual.reply, /这段视频里/, 'the subject question is not asked again');
  const declaredTurnaround = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: `${key}-declared-turnaround`, cwd, locale: 'en', forceIntent: true, text: 'Subject mode: has protagonist. Identity source: turnaround reference sheet; do not inherit reference-photo backgrounds.\n[0-5s] A girl opens the door.\n[5-10s] She looks back.' });
  assert.match(declaredTurnaround.reply, /Taken from your brief: has a protagonist · identity source: turnaround sheet/);
  const undeclared = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: `${key}-undeclared`, cwd, locale: 'zh-CN', forceIntent: true, text: '帮我做一个关于风筝的长视频' });
  assert.match(undeclared.reply, /这段视频里/, 'without a declaration the subject question is asked');
  // Only a header line that starts with the label and holds exactly one option counts.
  for (const [index, text] of [
    '【整片叙事】\n一部关于失忆侦探的短片。档案上写着：身份来源：照片。主体模式：纯视觉 是这部片子的反讽标题。\n[0-6秒] 段 1 · 侦探翻看旧档案。\n[6-12秒] 段 2 · 他抬头望向窗外。',
    '重庆夜市，三个老同学十年后重逢。主体模式：有主角。身份来源：纯文字。\n[0-6秒] 段 1 · 夜市。\n[6-12秒] 段 2 · 重逢。',
    '[0-6秒] 段 1 · 夜市。\n主体模式：纯视觉\n[6-12秒] 段 2 · 重逢。',
    '主体模式：纯视觉是主题\n[0-6秒] 段 1 · 夜市。\n[6-12秒] 段 2 · 重逢。',
  ].entries()) {
    const prose = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: `${key}-declared-prose-${index}`, cwd, locale: 'zh-CN', forceIntent: true, text });
    assert.match(prose.reply, /这段视频里/, `a declaration inside story prose is not an answer: ${text.slice(0, 40)}`);
  }

  const bgmTuneKey = `${key}-bgm-tune`;
  const bgmTunePath = path.join(cwd, 'tune-bgm.mp3');
  await writeFile(bgmTunePath, Buffer.alloc(128, 1));
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmTuneKey, cwd, locale: 'zh', forceIntent: true, text: '帮我生成一段长视频' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmTuneKey, cwd, locale: 'zh', text: '2' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmTuneKey, cwd, locale: 'zh', text: '纯视觉：雪山远景。' });
  const bgmTuneStart = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmTuneKey, cwd, locale: 'zh', text: '开始生成' });
  if (bgmTuneStart.handled && /确认.*主角|confirm the lead/i.test(bgmTuneStart.reply)) {
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmTuneKey, cwd, locale: 'zh', text: 'X' });
  }
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmTuneKey, cwd, locale: 'zh', text: '16:9' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmTuneKey, cwd, locale: 'zh', text: '无字幕' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmTuneKey, cwd, locale: 'zh', text: '60秒' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmTuneKey, cwd, locale: 'zh', text: '2' });
  const bgmTuneAsk = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmTuneKey, cwd, locale: 'zh', text: bgmTunePath });
  assert.equal(bgmTuneAsk.handled, true, 'plain path reply should open the mix-settings follow-up');
  const bgmTuneGarbage = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmTuneKey, cwd, locale: 'zh', text: 'asdf qwerty hello' });
  assert.equal(bgmTuneGarbage.handled, true, 'unparseable mix-settings reply should re-ask, not auto-default');
  assert.match(bgmTuneGarbage.reply ?? '', /没识别|Could not parse|调整混音参数|Adjust the mix/, 'mix-settings re-ask should explain why and reprint the menu');
  const bgmTuneFinal = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmTuneKey, cwd, locale: 'zh', text: '从45秒开始 淡入1秒' });
  assert.equal(bgmTuneFinal.handled, false, 'recognised mix params in the settings step should emit generate_long_video');
  assert.equal(bgmTuneFinal.action?.soundtrackPath, bgmTunePath, 'settings-step adjustments must keep the captured BGM path');
  assert.equal(bgmTuneFinal.action?.soundtrackStartSec, 45, 'settings 从45秒开始 should set startSec to 45');
  assert.equal(bgmTuneFinal.action?.soundtrackFadeInSec, 1, 'settings 淡入1秒 should set fadeInSec to 1');

  const bgmEnKey = `${key}-bgm-en`;
  const bgmEnPath = path.join(cwd, 'en-bgm.mp3');
  await writeFile(bgmEnPath, Buffer.alloc(128, 1));
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmEnKey, cwd, locale: 'en', forceIntent: true, text: 'help me generate a long video' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmEnKey, cwd, locale: 'en', text: '2' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmEnKey, cwd, locale: 'en', text: 'Pure visual: neon Tokyo street at night, rain reflections.' });
  const bgmEnStart = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmEnKey, cwd, locale: 'en', text: 'start' });
  if (bgmEnStart.handled && /confirm the lead|Need you to confirm the lead/i.test(bgmEnStart.reply)) {
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmEnKey, cwd, locale: 'en', text: 'X' });
  }
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmEnKey, cwd, locale: 'en', text: '16:9' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmEnKey, cwd, locale: 'en', text: 'no subtitles' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmEnKey, cwd, locale: 'en', text: '60s' });
  const bgmEnChoice = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmEnKey, cwd, locale: 'en', text: '2' });
  assert.equal(bgmEnChoice.handled, true, 'EN locale: BGM option 2 should not repeat the full menu');
  assert.match(bgmEnChoice.reply, /local audio path/i, 'EN locale: BGM option 2 should enter the asset-collection prompt');
  assert.doesNotMatch(bgmEnChoice.reply, /Add local BGM\?/, 'EN locale: BGM option 2 must not echo the full menu');
  const bgmEnAfterPath = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmEnKey, cwd, locale: 'en', text: bgmEnPath });
  assert.equal(bgmEnAfterPath.handled, true, 'EN locale: path-only reply should open the mix-settings follow-up');
  assert.match(bgmEnAfterPath.reply ?? '', /Music received|Adjust the mix|default/i, 'EN locale: settings ask should mention defaults');
  const bgmEnFinal = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmEnKey, cwd, locale: 'en', text: 'default' });
  assert.equal(bgmEnFinal.handled, false, 'EN locale: default reply should emit generate_long_video');
  assert.equal(bgmEnFinal.action?.soundtrackPath, bgmEnPath, 'EN locale: BGM path must be carried into generate_long_video');

  const bgmSkipNumKey = `${key}-bgm-skip-num`;
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmSkipNumKey, cwd, locale: 'zh', forceIntent: true, text: '帮我生成一段长视频' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmSkipNumKey, cwd, locale: 'zh', text: '2' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmSkipNumKey, cwd, locale: 'zh', text: '纯视觉：雪山黄昏远景。' });
  const bgmSkipNumStart = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmSkipNumKey, cwd, locale: 'zh', text: '开始生成' });
  if (bgmSkipNumStart.handled && /确认.*主角|confirm the lead|Need you to confirm the lead/i.test(bgmSkipNumStart.reply)) {
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmSkipNumKey, cwd, locale: 'zh', text: 'X' });
  }
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmSkipNumKey, cwd, locale: 'zh', text: '16:9' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmSkipNumKey, cwd, locale: 'zh', text: '无字幕' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmSkipNumKey, cwd, locale: 'zh', text: '60秒' });
  const bgmSkipNum = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: bgmSkipNumKey, cwd, locale: 'zh', text: '1' });
  assert.equal(bgmSkipNum.handled, false, 'BGM option 1 (numeric) should emit generate_long_video action without re-asking the menu');
  assert.equal(bgmSkipNum.action?.soundtrackPath, undefined, 'BGM option 1 must not attach a soundtrack path');
  assert.equal(bgmSkipNum.action?.soundtrackUrl, undefined, 'BGM option 1 must not attach a soundtrack URL');
  assert.equal(bgmSkipNum.action?.totalDuration, 60, 'BGM-skip flow should preserve the user-chosen total duration');
  assert.equal(bgmSkipNum.action?.ratio, '16:9', 'BGM-skip flow should preserve the user-chosen ratio');

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

  // Real briefs read like "workflow discussion" to the classifier (video words
  // plus a question mark or 没有 in the dialogue). /saga must still start Saga.
  for (const [suffix, brief] of [
    ['brief-question', '30秒短片《码头》\n[0-10秒] 夜景，方天豪走向镜头。对白：“你还好吗？”\n[10-20秒] 他转身。\n[20-30秒] 船离开。'],
    ['brief-negation', '视频风格：电影感。\n[0-5秒] 女孩推开门，没有人在家。\n[5-10秒] 她发现桌上的信。'],
  ] as const) {
    const scripted = await handleSagaLongVideoWorkflow({
      scope: 'bridge',
      key: `${key}-${suffix}`,
      cwd,
      locale: 'zh',
      forceIntent: true,
      text: brief,
    });
    assert.equal(scripted.handled, true, `explicit /saga with a real brief (${suffix}) must enter the Saga wizard`);
    assert.match(scripted.reply, /这段视频里|In this video/i, `explicit /saga brief (${suffix}) should open with the subject-mode menu`);
  }

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

  // The same image sent in two turns, once as an attachment (saved under
  // saga-refs) and once as a pasted local path, counts as one image.
  const previousMediaRoot = process.env.ARTEMIS_MEDIA_OUTPUT_ROOT;
  process.env.ARTEMIS_MEDIA_OUTPUT_ROOT = await mkdtemp(path.join(os.tmpdir(), 'artemis-saga-media-'));
  try {
    const imageBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 7)]);
    const localImage = path.join(cwd, 'lead-photo.png');
    await writeFile(localImage, imageBytes);
    const dedupKey = `${key}-cross-turn-dedup`;
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: dedupKey, cwd, locale: 'zh', forceIntent: true, text: '帮我生成一段长视频' });
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: dedupKey, cwd, locale: 'zh', text: '1' });
    const askImage = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: dedupKey, cwd, locale: 'zh', text: '3' });
    assert.equal(askImage.handled, true);
    const firstImage = await handleSagaLongVideoWorkflow({
      scope: 'bridge',
      key: dedupKey,
      cwd,
      locale: 'zh',
      text: '',
      imageAttachments: [{ data: imageBytes.toString('base64'), mediaType: 'image/png' }],
    });
    assert.match(firstImage.reply, /已收到 1 张|Got 1 /, `first upload should count as one image: ${firstImage.reply}`);
    const samePathAgain = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: dedupKey, cwd, locale: 'zh', text: localImage });
    assert.match(samePathAgain.reply, /已收到 1 张|Got 1 /, `the same image pasted as a path in a later turn must not count twice: ${samePathAgain.reply}`);
  } finally {
    if (previousMediaRoot === undefined) delete process.env.ARTEMIS_MEDIA_OUTPUT_ROOT;
    else process.env.ARTEMIS_MEDIA_OUTPUT_ROOT = previousMediaRoot;
  }

  // A menu button labelled "默认/自动" confirms the default, like "默认" alone.
  const comboKey = `${key}-default-auto-combo`;
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: comboKey, cwd, locale: 'zh', forceIntent: true, text: '帮我生成一段长视频' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: comboKey, cwd, locale: 'zh', text: '1' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: comboKey, cwd, locale: 'zh', text: '4' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: comboKey, cwd, locale: 'zh', text: '剧情你来创造。' });
  const comboStart = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: comboKey, cwd, locale: 'zh', text: '开始生成' });
  if (/确认.*主角|confirm the lead/i.test(comboStart.reply)) {
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: comboKey, cwd, locale: 'zh', text: 'B 海边的女孩' });
  }
  const comboRatio = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: comboKey, cwd, locale: 'zh', text: '默认/自动' });
  assert.match(comboRatio.reply, /是否携带字幕|include subtitles/i, `"默认/自动" should confirm the default ratio: ${comboRatio.reply}`);
  const comboSubtitle = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: comboKey, cwd, locale: 'zh', text: '默认 / 自动' });
  assert.match(comboSubtitle.reply, /最后确认一下总时长|confirm the total length/i, `"默认 / 自动" should confirm the default subtitle mode: ${comboSubtitle.reply}`);

  // A message that is only a resolution choice sets it; story text never does.
  const hdKey = `${key}-resolution`;
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: hdKey, cwd, locale: 'zh', forceIntent: true, text: '帮我生成一段长视频' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: hdKey, cwd, locale: 'zh', text: '1' });
  for (const bare of ['480', '720', '1080']) {
    assert.equal(extractRequestedResolution(bare), undefined, `a bare "${bare}" is not a resolution`);
  }
  const hdAck = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: hdKey, cwd, locale: 'zh', text: '1080P' });
  assert.equal(hdAck.handled, true);
  assert.match(hdAck.reply, /1080p/, 'a resolution-only message is acknowledged');
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: hdKey, cwd, locale: 'zh', text: '4' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: hdKey, cwd, locale: 'zh', text: '剧情你来创造。' });
  const hdStart = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: hdKey, cwd, locale: 'zh', text: '开始生成' });
  if (/确认.*主角|confirm the lead/i.test(hdStart.reply)) {
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: hdKey, cwd, locale: 'zh', text: 'B 海边的女孩' });
  }
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: hdKey, cwd, locale: 'zh', text: '9:16' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: hdKey, cwd, locale: 'zh', text: '自动' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: hdKey, cwd, locale: 'zh', text: '10秒' });
  const hdFinal = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: hdKey, cwd, locale: 'zh', text: '不加' });
  assert.equal(hdFinal.handled, false, 'the resolution flow should end in a generate_long_video action');
  assert.equal(hdFinal.action?.resolution, '1080p', 'a resolution-only message should reach the action');
  assert.match(hdFinal.action?.prompt ?? '', /resolution: "1080p"/, 'workflow prompt should tell the model to pass resolution');

  const storyKey = `${key}-resolution-in-story`;
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: storyKey, cwd, locale: 'zh', forceIntent: true, text: '帮我生成一段长视频，画面里有一台1080P的旧显示器' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: storyKey, cwd, locale: 'zh', text: '1' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: storyKey, cwd, locale: 'zh', text: '4' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: storyKey, cwd, locale: 'zh', text: '[0-5秒] 一台1080P的旧显示器在桌上闪烁。 [5-10秒] 屏幕里出现 720p 的雪花画面。' });
  const storyStart = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: storyKey, cwd, locale: 'zh', text: '开始生成' });
  if (/确认.*主角|confirm the lead/i.test(storyStart.reply)) {
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: storyKey, cwd, locale: 'zh', text: 'X' });
  }
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: storyKey, cwd, locale: 'zh', text: '16:9' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: storyKey, cwd, locale: 'zh', text: '自动' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: storyKey, cwd, locale: 'zh', text: '10秒' });
  const storyFinal = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: storyKey, cwd, locale: 'zh', text: '不加' });
  assert.equal(storyFinal.handled, false);
  assert.equal(storyFinal.action?.resolution, undefined, 'a resolution mentioned in the story never sets the billing resolution');
  assert.equal(afterBgmSkip.action?.resolution, undefined, 'no resolution is set unless the user named one');

  // "[原样直传]" switches on raw mode, and raw mode skips the narrative LLM call.
  const rawKey = `${key}-raw-tag`;
  const originalFetch = globalThis.fetch;
  let chatCalls = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).endsWith('/chat/completions')) chatCalls += 1;
    return new Response('{"error":{"message":"offline"}}', { status: 400 });
  }) as typeof fetch;
  try {
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: rawKey, cwd, locale: 'zh', forceIntent: true, text: '帮我生成长视频 [原样直传]' });
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: rawKey, cwd, locale: 'zh', text: '1' });
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: rawKey, cwd, locale: 'zh', text: '4' });
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: rawKey, cwd, locale: 'zh', text: '[0-5秒] 镜头1：风筝飞过山坡。 [5-10秒] 镜头2：风筝落进草地。' });
    const rawStart = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: rawKey, cwd, locale: 'zh', text: '开始生成' });
    assert.doesNotMatch(rawStart.reply, /确认.*主角|confirm the lead/i, 'raw mode never asks to confirm the lead');
    assert.equal(chatCalls, 0, 'raw mode skips the narrative LLM call');
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: rawKey, cwd, locale: 'zh', text: '自动' });
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: rawKey, cwd, locale: 'zh', text: '自动' });
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: rawKey, cwd, locale: 'zh', text: '10秒' });
    const rawFinal = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: rawKey, cwd, locale: 'zh', text: '不加' });
    assert.equal(rawFinal.action?.rawPassthrough, true, '"[原样直传]" should enable raw passthrough');
    assert.notEqual(rawFinal.action?.cleanDirect, true, '"[原样直传]" is raw passthrough, not cleanDirect');

    // The guide's cleanDirect sentence (§9.10) keeps the narrative analysis.
    chatCalls = 0;
    const cleanKey = `${key}-clean-direct-guide`;
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: cleanKey, cwd, locale: 'zh', forceIntent: true, text: '帮我生成长视频\n请用原始质感 / 少滤镜 / raw-seedance / clean-direct。\n保留自然纹理，不要过度导演包装。' });
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: cleanKey, cwd, locale: 'zh', text: '1' });
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: cleanKey, cwd, locale: 'zh', text: '4' });
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key: cleanKey, cwd, locale: 'zh', text: '[0-5秒] 镜头1：风筝飞过山坡。 [5-10秒] 镜头2：风筝落进草地。' });
    let clean = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: cleanKey, cwd, locale: 'zh', text: '开始生成' });
    assert.ok(chatCalls > 0, 'cleanDirect still runs the narrative analysis');
    for (const reply of ['自动', '自动', '10秒', '不加']) {
      if (!clean.handled) break;
      clean = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: cleanKey, cwd, locale: 'zh', text: /确认.*主角|confirm the lead/i.test(clean.reply) ? 'X' : reply });
    }
    assert.equal(clean.handled, false, 'the cleanDirect flow should end in an action');
    assert.equal(clean.action?.cleanDirect, true, 'the guide sentence enables cleanDirect');
    assert.notEqual(clean.action?.rawPassthrough, true, 'the guide sentence is not raw passthrough');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Everyday wording in a story never switches on raw mode.
  const casualKey = `${key}-casual-raw-words`;
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: casualKey, cwd, locale: 'zh', forceIntent: true, text: '帮我生成长视频：一个博主对着镜头说她的自拍从来不用美颜、不要滤镜，write a short prompt for each scene' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: casualKey, cwd, locale: 'zh', text: '2' });
  await handleSagaLongVideoWorkflow({ scope: 'bridge', key: casualKey, cwd, locale: 'zh', text: '纯风景：清晨的湖面，薄雾缓缓散开。' });
  let casual = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: casualKey, cwd, locale: 'zh', text: '开始生成' });
  for (const reply of ['自动', '无字幕', '10秒', '不加', '不加']) {
    if (!casual.handled) break;
    casual = await handleSagaLongVideoWorkflow({ scope: 'bridge', key: casualKey, cwd, locale: 'zh', text: /主角/.test(casual.reply) ? 'X' : reply });
  }
  assert.equal(casual.handled, false, 'the casual-words flow should end in a generate_long_video action');
  assert.notEqual(casual.action?.cleanDirect, true, '"不要滤镜" / "short prompt" in a story must not switch on raw mode');

  await ratioCases(cwd, key);

  console.log('saga workflow explicit-trigger guard ok');
}

function ratioBrief(ratioLine: string, extra = '', timecodes = ['[0-8秒] 女孩推开旧影院的门。', '[8-16秒] 她走到银幕前。']): string {
  return ['【整片叙事】', `一个女孩在废弃影院里找到童年的胶片。${extra}`, '【画质规格】', ratioLine, '· 镜头: 35mm', '【分镜】', ...timecodes].join('\n');
}

async function ratioCases(cwd: string, key: string): Promise<void> {
  const table: Array<[string, string, string | undefined, boolean?]> = [
    ['labelled zh', ratioBrief('· 画幅比例 / ratio: 9:16 竖屏'), '9:16', true],
    ['labelled en', 'Aspect ratio: 9:16 portrait\n[0-8s] A girl opens the door.', '9:16', true],
    ['labelled 1:1', ratioBrief('· 画幅比例 / ratio: 1:1 方屏'), '1:1', true],
    ['timecodes past 1:10 with 16:9', ratioBrief('· 画幅比例 / ratio: 16:9 横屏', '', ['[0:56-1:04] 推门。', '[1:04-1:12] 走近。', '[1:12-1:20] 银幕亮起。']), '16:9', true],
    ['unlabelled timecodes only', ratioBrief('· 镜头: 50mm', '', ['[1:04-1:12] 走近。', '[1:12-1:20] 银幕亮起。']), undefined],
    ['BGM start 1:19', ratioBrief('· 摄影机感: iPhone', '配乐起点从 1:19 开始。'), undefined],
    ['纵向推进', ratioBrief('· 摄影机感: iPhone', '镜头纵向推进。'), undefined],
    ['town square', '[0-8s] A girl crosses the town square.\n[8-16s] She stops.', undefined],
    ['portrait 85mm', '[0-8s] Close portrait of the girl, 85mm, vertical light.', undefined],
    ['竖版', ratioBrief('· 画面尺寸：竖版'), '9:16', true],
    ['9×16', ratioBrief('· 画面尺寸：9×16'), '9:16', true],
    ['1080x1920', ratioBrief('· 画面尺寸：1080x1920'), '9:16', true],
    ['unlabelled 竖屏 in request', '帮我做一个竖屏长视频', '9:16', false],
    ['unfilled template', ratioBrief('· 画幅比例 / ratio: [16:9 横屏 / 9:16 竖屏 / 1:1 方屏]'), undefined],
    ['bare 比例 about a prop', '· 比例：1:1 还原道具尺寸\n[0-6秒] 段 1 · 桌上摆着一只青花瓷碗。', undefined],
    ['bare 比例 with only a ratio', '· 比例：9:16\n[0-6秒] 段 1 · 桌上摆着一只青花瓷碗。', '9:16', true],
    ['人物比例 is not a label', ratioBrief('· 人物比例：9:16 竖屏 和 16:9 都试过'), undefined],
  ];
  for (const [name, text, expected, labelled] of table) {
    const found = extractBriefAspectRatio(text);
    assert.equal(found?.ratio, expected, `ratio case "${name}"`);
    if (expected) assert.equal(found?.labelled, labelled, `ratio case "${name}" labelled`);
  }
  for (const [value, expected] of [['9:16 竖屏', '9:16'], ['竖屏 9:16', '9:16'], ['portrait', '9:16'], ['9×16', '9:16'], ['1920x1080', '16:9'], ['square', '1:1'], ['16:9 / 9:16', undefined], ['', undefined]] as const) {
    assert.equal(normalizeAspectRatio(value), expected, `normalizeAspectRatio(${JSON.stringify(value)})`);
  }
  const warnings: string[] = [];
  assert.equal(normalizeVideoRatioArgument('portrait', '16:9', (m) => warnings.push(m)), '9:16');
  assert.equal(normalizeVideoRatioArgument('4:3', '16:9', (m) => warnings.push(m)), '4:3');
  assert.equal(normalizeVideoRatioArgument('tall-ish', '16:9', (m) => warnings.push(m)), '16:9');
  assert.equal(warnings.length, 1, 'an unrecognised ratio warns before defaulting');

  async function drive(name: string, text: string, ratioAnswer: string): Promise<{ menu?: string; note?: string; ratio?: string }> {
    const flowKey = `${key}-ratio-${name}`;
    const send = (t: string, forceIntent = false) => handleSagaLongVideoWorkflow({ scope: 'bridge', key: flowKey, cwd, locale: 'zh-CN', text: t, forceIntent });
    let out = await send(text, true);
    let menu: string | undefined;
    let note: string | undefined;
    for (let step = 0; step < 12 && out.handled; step += 1) {
      const head = out.reply.split('\n')[0] ?? '';
      let answer = '开始生成';
      if (/请选择视频画幅比例/.test(head)) { menu = head; answer = ratioAnswer; }
      else if (/画幅：/.test(head)) { note = head; answer = '默认'; }
      else if (/这段视频里/.test(out.reply)) answer = '2';
      else if (/字幕/.test(head)) answer = '默认';
      else if (/时长/.test(out.reply)) answer = '默认';
      else if (/背景音乐/.test(head)) answer = '不加';
      else if (/主角/.test(out.reply)) answer = '1';
      out = await send(answer);
    }
    assert.equal(out.handled, false, `ratio flow "${name}" should end in an action: ${out.handled ? out.reply.slice(0, 300) : ""}`);
    return { menu, note, ratio: out.action?.ratio };
  }
  const labelledFlow = await drive('labelled', ratioBrief('· 画幅比例 / ratio: 9:16 竖屏', '', ['[1:04-1:12] 走近。', '[1:12-1:20] 银幕亮起。']), '默认');
  assert.equal(labelledFlow.menu, undefined, 'a labelled ratio line skips the ratio menu');
  assert.match(labelledFlow.note ?? '', /9:16 竖屏（按剧本）/);
  assert.equal(labelledFlow.ratio, '9:16');
  const templateFlow = await drive('template', ratioBrief('· 画幅比例 / ratio: [16:9 横屏 / 9:16 竖屏 / 1:1 方屏]'), '竖屏 9:16');
  assert.match(templateFlow.menu ?? '', /当前建议：16:9 横屏/, 'an unfilled template line is no answer');
  assert.equal(templateFlow.ratio, '9:16', 'a menu reply naming the ratio and its label is accepted');
  const copiedFlow = await drive('copied', ratioBrief('· 摄影机感: iPhone', '配乐起点从 1:19 开始。'), '9:16 竖屏');
  assert.match(copiedFlow.menu ?? '', /当前建议：16:9 横屏/, '"1:19" is not a 1:1 ratio');
  assert.equal(copiedFlow.ratio, '9:16', 'a line copied from the menu is accepted');
  // Orientation words in story prose only preselect the menu; they never skip it.
  for (const [name, text, suggestion] of [
    ['prose-phone', '她把手机横屏举起，对着海边的落日拍视频。\n[0-6秒] 段 1 · 海边落日，女孩举着手机。\n[6-12秒] 段 2 · 她放下手机，转身离开。', '16:9 横屏'],
    ['prose-request', '/saga 帮我做一个视频，画面要像横屏电影那样宽，但最终发抖音\n[0-6秒] 段 1 · 城市天际线。\n[6-12秒] 段 2 · 霓虹街道。', '16:9 横屏'],
    ['prop-scale', '· 比例：1:1 还原道具尺寸\n[0-6秒] 段 1 · 桌上摆着一只青花瓷碗。\n[6-12秒] 段 2 · 镜头缓缓推近碗沿的裂纹。', '16:9 横屏'],
  ] as const) {
    const flow = await drive(name, text, '默认');
    assert.ok(flow.menu, `${name}: the ratio menu is shown`);
    assert.match(flow.menu ?? '', new RegExp(`当前建议：${suggestion}`), name);
    assert.equal(flow.note, undefined, `${name}: no ratio is taken as stated`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
