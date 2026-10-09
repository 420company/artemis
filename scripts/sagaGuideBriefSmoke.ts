import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withHermeticWorkspace, videoTaskBodies } from './sagaHermeticHarness.js';
import { handleSagaLongVideoWorkflow } from '../src/tools/visual/sagaWorkflow.js';
import { executeGenerateLongVideo } from '../src/tools/generateLongVideo.js';
import { withRuntimeLogSink } from '../src/utils/log.js';

// Regression for the Saga Brief Authoring Guide v1.2: a brief written to the
// guide's §6 template, in Chinese and in English, goes through the wizard and
// generate_long_video with the network mocked. Every prompt sent to ModelArk
// must fit Seedance's 4,000 characters and still carry the brief's character
// lock, camera lock, audio lock and negative constraints, and lyrics or sign
// text must never be listed as dialogue.

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_PROMPT_CHARS = 4000;

type Case = {
  name: string;
  file: string;
  locale: 'zh-CN' | 'en';
  characters: string[];
  notDialogue: string[];
  worldAnchor: boolean;
};

const CASES: Case[] = [
  { name: 'cn', file: 'saga-guide-brief-cn.txt', locale: 'zh-CN', characters: ['林夏', '周屿'], notDialogue: ['It was just two lovers', '霓虹城市', '我等了你好久。” | 温柔'], worldAnchor: true },
  { name: 'en', file: 'saga-guide-brief-en.txt', locale: 'en', characters: ['Lin Xia', 'Zhou Yu'], notDialogue: ['It was just two lovers', 'neon city'], worldAnchor: false },
];

function promptText(body: Record<string, any>): string {
  return (body.content ?? []).filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n');
}

/** The lines the dialogue note says are spoken. */
function listedDialogue(text: string): string {
  return text.match(/Only these marked lines are spoken: (.*?)\. Other quoted text is not speech/)?.[1] ?? '';
}

async function runCase(entry: Case): Promise<void> {
  const brief = readFileSync(path.join(here, 'fixtures', entry.file), 'utf8');
  await withHermeticWorkspace({}, async (cwd, requests) => {
    const replies: string[] = [];
    let text = brief;
    let action: any;
    for (let turn = 0; turn < 14; turn += 1) {
      const out = await handleSagaLongVideoWorkflow({ scope: 'cli', key: `guide-${entry.name}`, cwd, text, locale: entry.locale, forceIntent: turn === 0 });
      if (!out.handled) {
        action = out.action;
        break;
      }
      replies.push(out.reply);
      const reply = out.reply;
      if (/这段视频里|In this video/i.test(reply)) text = '1';
      else if (/角色身份来源|identity source/i.test(reply)) text = '4';
      else if (/请选择视频画幅比例|Choose video aspect ratio/i.test(reply)) text = 'default';
      else if (/是否携带字幕|include subtitles/i.test(reply)) text = '3';
      else if (/总时长|total length|How long/i.test(reply)) text = 'default';
      else if (/背景音乐|background music/i.test(reply)) text = '1';
      else if (/确认.*主角|confirm the lead/i.test(reply)) text = '1';
      else text = '开始生成';
    }
    assert.ok(action, `${entry.name}: the wizard should end in a generate_long_video action`);
    assert.ok(!replies.some((reply) => /请选择视频画幅比例|Choose video aspect ratio/.test(reply)), `${entry.name}: the labelled ratio line answers the ratio question`);
    assert.equal(action.ratio, '9:16');
    assert.equal(action.totalDuration, 24, `${entry.name}: the total is the end of the last timecode`);
    assert.equal(action.continuity?.characters?.length, 2, `${entry.name}: the wizard passes the CHARACTER LOCK on`);
    if (entry.locale === 'zh-CN') {
      assert.ok(replies.some((reply) => /语速提示：段 3/.test(reply)), 'the over-long line in segment 3 gets a speech-rate warning');
    }

    const logs: string[] = [];
    const result = await withRuntimeLogSink(
      (log) => { logs.push(log.message); },
      () => executeGenerateLongVideo(
        { ...action, assemblyMode: 'ffmpeg', gpu: 'off', maxPolls: 3, pollIntervalMs: 1000 },
        { cwd, permissionMode: 'full-access', sessionId: `guide-${entry.name}`, locale: 'en', requestWorkspaceSwitch: async () => true } as any,
      ),
    );
    assert.equal(result.ok, true, result.output);
    const tasks = videoTaskBodies(requests);
    assert.equal(tasks.length, 3, `${entry.name}: one task per timecoded segment`);
    tasks.forEach((body, index) => {
      const sent = promptText(body);
      const label = `${entry.name} segment ${index + 1}`;
      assert.ok(sent.length <= MAX_PROMPT_CHARS, `${label}: ${sent.length} chars`);
      assert.match(sent, /\[LOCKED-CHARACTERS/, `${label}: character lock`);
      for (const name of entry.characters) assert.ok(sent.includes(name), `${label}: ${name} is locked`);
      assert.match(sent, /\[CAMERA: absolutely locked-off/, `${label}: camera lock`);
      assert.match(sent, /\[AUDIO-LOCK/, `${label}: audio lock`);
      assert.match(sent, /\[NEGATIVE:/, `${label}: negative constraints`);
      assert.ok(sent.indexOf('[AUDIO-LOCK') < sent.indexOf('[NEGATIVE:'), `${label}: the audio lock sits before NEGATIVE`);
      assert.doesNotMatch(sent, /附录|Appendix|═{6,}/, `${label}: no appendix or divider lines`);
      assert.doesNotMatch(sent, /Visual direction: Follow this exact timestamped script section/, `${label}: the beat is not repeated`);
      for (const text of entry.notDialogue) assert.ok(!listedDialogue(sent).includes(text), `${label}: "${text}" is not dialogue`);
      if (entry.worldAnchor) assert.match(sent, /\[WORLD ANCHOR · 黄昏大雨/, `${label}: the world anchor covers 0-24s`);
    });
    assert.ok(!/花样年华/.test(String(result.output).split('\n').find((line) => line.includes('.mp4')) ?? ''), 'a reference film is not the title');
  });
}

for (const entry of CASES) await runCase(entry);
console.log('saga guide brief smoke ok');
