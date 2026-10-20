import assert from 'node:assert/strict';
import {
  buildDirectorPack,
  buildScriptEnhancePrompt,
  checkSourceLength,
  detectScriptEnhanceMode,
  parseEnhancedScript,
  scriptLengthBudget,
} from '../src/tools/visual/scriptEnhance.js';

/**
 * Which of the two passes runs is decided from the text, because the two
 * mistakes do not cost the same: reading an idea as a script wastes one
 * pass, reading a script as an idea rewrites words the owner chose.
 */
function modeChecks(): void {
  assert.equal(detectScriptEnhanceMode('[0-6秒] 她推开门\n[6-12秒] 街上下着雨'), 'have_script');
  assert.equal(detectScriptEnhanceMode('00:06 - 00:12 街上下着雨'), 'have_script');
  assert.equal(detectScriptEnhanceMode('段 1 · 开场\n她推开门'), 'have_script');
  assert.equal(detectScriptEnhanceMode('Scene 1\nShe opens the door'), 'have_script');
  assert.equal(detectScriptEnhanceMode('**对白**: 「我回来了」'), 'have_script');
  assert.equal(detectScriptEnhanceMode('【整片叙事】一个雨夜的故事'), 'have_script');
  // Several paragraphs of prose is a draft.
  const prose = `${'她推开门，雨水顺着伞骨滴在门槛上。'.repeat(8)}\n\n${'他没有回头，只把烟掐灭在窗台。'.repeat(8)}`;
  assert.equal(detectScriptEnhanceMode(prose), 'have_script');
  // A one-line request is not.
  assert.equal(detectScriptEnhanceMode('拍一个赛博朋克的猫'), 'from_idea');
  assert.equal(detectScriptEnhanceMode('一个女孩在雨夜的城市里走，氛围孤独一点'), 'from_idea');
}

/**
 * The owner wants to drop a novel in. A rule about not rewriting only holds
 * when the text is roughly the length of the film, so the arithmetic is
 * checked before the call rather than discovered by paying for one -- and it
 * is read from the model actually configured, because a clip is 15 seconds on
 * Seedance 2.0 and 30 on 2.5 while the guide that set 6-10 predates both.
 */
function budgetChecks(): void {
  // Seedance 2.0: 15-second clips, 4,000-character prompts, 1,545 reserved.
  const s20 = { maxClipSeconds: 15, maxPromptChars: 4000, segmentPromptReserve: 1545 };
  const s25 = { maxClipSeconds: 30, maxPromptChars: 4000, segmentPromptReserve: 1545 };

  const minute20 = scriptLengthBudget(60, s20);
  assert.equal(minute20.clipSeconds, 15);
  assert.equal(minute20.segments, 4, '60 秒在 2.0 上是 4 段，不是说明书的 8 段');
  assert.equal(minute20.authoredCharsPerSegment, 2455);
  // Density binds here, not the prompt limit: 60s * 42 < 4 * 2455.
  assert.equal(minute20.maxChars, 2520);
  assert.equal(minute20.minChars, 1200);

  const minute25 = scriptLengthBudget(60, s25);
  assert.equal(minute25.segments, 2, '同样 60 秒，2.5 只要 2 段');
  // The clip length decides how many segments, never how much a second of
  // film can carry, so the budget is the same on both models.
  assert.equal(minute25.maxChars, minute20.maxChars);

  // The prompt limit binds instead when a model has little room per segment:
  // 4 segments of 600 characters is under what 60 seconds could carry.
  const tight = scriptLengthBudget(60, { maxClipSeconds: 15, maxPromptChars: 2000, segmentPromptReserve: 1400 });
  assert.equal(tight.authoredCharsPerSegment, 600);
  assert.equal(tight.maxChars, 2400);
  assert.ok(tight.minChars <= tight.maxChars, 'the floor never exceeds the ceiling');
  // And a prompt limit tighter than one sentence still leaves a sentence.
  assert.equal(scriptLengthBudget(60, { maxPromptChars: 1500, segmentPromptReserve: 1545 }).authoredCharsPerSegment, 400);

  // The clip length changes the segment count, never the words a second holds.
  assert.equal(scriptLengthBudget(600, s20).segments, 40);
  assert.equal(scriptLengthBudget(600, s25).segments, 20);
  assert.equal(scriptLengthBudget(600, s20).maxChars, scriptLengthBudget(600, s25).maxChars);

  // Nothing configured: the shortest clip any supported model films.
  assert.equal(scriptLengthBudget(60).clipSeconds, 10);

  // A script the size of the film goes through.
  assert.equal(checkSourceLength('字'.repeat(1800), 60, s20).fits, true);
  // Some slack above the budget still goes through: the cap is prose padding.
  assert.equal(checkSourceLength('字'.repeat(6000), 60, s20).fits, true);
  // A novel does not, and the answer says what duration it would need.
  const novel = checkSourceLength('字'.repeat(100_000), 60, s20);
  assert.equal(novel.fits, false);
  if (novel.fits === false) {
    assert.equal(novel.chars, 100_000);
    // 100,000 characters at 42 per second is about 40 minutes of film.
    assert.equal(novel.secondsNeeded, 2381);
  }
  // Whitespace is not content.
  assert.equal(checkSourceLength(`${'字'.repeat(1000)}\n\n   \n`, 60, s20).chars, 1000);
}

/** The specs the panel injected, and the rules only the UI knows. */
function directorPackChecks(): void {
  const pack = buildDirectorPack({
    subject: 'lead',
    identityMode: 'character_image',
    slots: [
      { name: '阿雨', referenceCount: 2, looks: 'Look A 白衬衫 0-5秒' },
      { name: '老陈' },
    ],
    firstFrame: '/tmp/first.png',
    ratio: '9:16',
    totalSeconds: 48,
    segmentCapSeconds: 6,
    subtitleMode: 'auto',
  });
  assert.match(pack, /身份来源模式: 角色图生成三视图/);
  assert.match(pack, /1\. 阿雨: 2 张参考图 · 同人换装: Look A 白衬衫 0-5秒/);
  assert.match(pack, /2\. 老陈: 未上传参考图/);
  assert.match(pack, /同人换装≠新角色/);
  assert.match(pack, /首帧锚定: \/tmp\/first\.png/);
  assert.doesNotMatch(pack, /末帧锚定/);
  assert.match(pack, /画幅: 9:16 · 总时长: 48s/);
  assert.match(pack, /单段时长上限: 6s/);
  assert.match(pack, /字幕: 自动/);
  assert.match(pack, /优先级: 角色身份 > 多角色绑定/);
  // Slots belong to a lead run; a product or a vase has none.
  const visual = buildDirectorPack({ subject: 'visual', slots: [{ name: '不该出现' }], ratio: '16:9', totalSeconds: 30 });
  assert.doesNotMatch(visual, /不该出现|角色卡槽/);
}

/** The owner's prompts, carried over as written. */
function promptChecks(): void {
  const director = { subject: 'lead' as const, ratio: '16:9', totalSeconds: 60, slots: [{ name: '阿雨' }] };
  const have = buildScriptEnhancePrompt({ mode: 'have_script', story: '她推开门。', director });
  assert.match(have, /【铁律 - 违反即任务失败】/);
  assert.match(have, /用户原文每个字都神圣/);
  assert.match(have, /不要静默改写/);
  assert.match(have, /以下为降级版本供你判断是否使用/);
  assert.match(have, /【用户原始剧本\(神圣 - 不得改字\)】\n她推开门。/);
  assert.match(have, /画幅: 16:9/);
  assert.match(have, /总时长: 60s/);
  assert.match(have, /【Director Pack · 导演备注】/);
  assert.match(have, /请动态使用以上人物名字/);

  const idea = buildScriptEnhancePrompt({ mode: 'from_idea', story: '赛博朋克的猫', director });
  assert.match(idea, /撰写一份 Artemis Saga 长视频工作流的完整剧本/);
  assert.match(idea, /根据以下题材写完整剧本:\n\n赛博朋克的猫/);
  assert.doesNotMatch(idea, /铁律/);
}

/**
 * When the model will not keep every word it says so on its own first line.
 * That line is a message to the owner, not part of the script, so it never
 * reaches the renderer — and the downgrade is reported, never substituted
 * silently.
 */
function degradedChecks(): void {
  const plain = parseEnhancedScript('【整片叙事】\n一个雨夜。');
  assert.equal(plain.degraded, undefined);
  assert.match(plain.script, /^【整片叙事】/);

  const answer = 'AI 检测到 [原文含大量内心独白无法转为画面],无法以原样输出。以下为降级版本供你判断是否使用 ↓\n\n【整片叙事】\n降级后的剧本。';
  const degraded = parseEnhancedScript(answer);
  assert.equal(degraded.degraded?.reason, '原文含大量内心独白无法转为画面');
  assert.match(degraded.script, /^【整片叙事】/);
  assert.doesNotMatch(degraded.script, /AI 检测到/, 'the notice is not part of the script');

  // A refusal with nothing after it leaves the owner's own text standing.
  const refused = parseEnhancedScript('AI 检测到 [无法处理],无法以原样输出。以下为降级版本供你判断是否使用 ↓');
  assert.equal(refused.script, '');
  assert.equal(refused.degraded?.reason, '无法处理');

  // A fenced answer still parses.
  assert.match(parseEnhancedScript('```\n【整片叙事】\n一个雨夜。\n```').script, /^【整片叙事】/);
}

function main(): void {
  modeChecks();
  budgetChecks();
  directorPackChecks();
  promptChecks();
  degradedChecks();
  console.log('saga script enhance smoke: ok');
}

main();
