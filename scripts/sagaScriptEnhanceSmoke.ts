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
 * checked before the call rather than discovered by paying for one.
 */
function budgetChecks(): void {
  const oneMinute = scriptLengthBudget(60);
  assert.equal(oneMinute.segments, 8);
  assert.equal(oneMinute.minChars, 960);
  assert.equal(oneMinute.maxChars, 2000);
  // The longest film the panel allowed.
  const tenMinutes = scriptLengthBudget(600);
  assert.equal(tenMinutes.segments, 75);
  assert.equal(tenMinutes.maxChars, 18_750);

  // A script the size of the film goes through.
  const fits = checkSourceLength('字'.repeat(1800), 60);
  assert.equal(fits.fits, true);
  // Some slack above the budget still goes through: the cap is prose padding,
  // not a hard limit on what can be structured.
  assert.equal(checkSourceLength('字'.repeat(4800), 60).fits, true);
  // A novel does not.
  const novel = checkSourceLength('字'.repeat(100_000), 60);
  assert.equal(novel.fits, false);
  if (novel.fits === false) {
    assert.equal(novel.chars, 100_000);
    assert.equal(novel.timesOver, 50);
  }
  // Whitespace is not content.
  assert.equal(checkSourceLength(`${'字'.repeat(1000)}\n\n   \n`, 60).chars, 1000);
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
