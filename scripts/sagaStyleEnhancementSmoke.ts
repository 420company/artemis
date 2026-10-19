import assert from 'node:assert/strict';
import { buildStyleEnhancement, matchStyleDna, routeQuestion } from '../src/tools/visual/styleMatch.js';
import { STYLE_LIBRARY, STYLE_PRINCIPLES, principleById } from '../src/tools/visual/styleDna.js';
import { runHermeticSaga, videoTaskBodies } from './sagaHermeticHarness.js';

/** The library itself: ids unique, every referenced principle exists, every style usable. */
function libraryChecks(): void {
  const ids = new Set<string>();
  for (const style of STYLE_LIBRARY) {
    assert.equal(ids.has(style.id), false, `duplicate style id ${style.id}`);
    ids.add(style.id);
    assert.ok(style.triggers.length >= 4, `${style.id} needs a usable trigger dictionary`);
    assert.ok(style.motifs.length > 0 && style.camera.length > 0 && style.antiPatterns.length > 0, `${style.id} is missing a field the prompt block needs`);
    for (const id of style.principles) principleById(id);
  }
  assert.equal(STYLE_PRINCIPLES.length, 24, 'the verification produced 24 transferable principles');
  const principleIds = new Set(STYLE_PRINCIPLES.map((principle) => principle.id));
  assert.equal(principleIds.size, 24, 'principle ids are unique');
}

/** Sub-genre matching: "rap MV" is not a style, so each request lands on one. */
function matchChecks(): void {
  const cases: Array<{ story: string; expect: string }> = [
    { story: '帮我拍个说唱 MV，街头写实，滑板，鱼眼，不要 AI 感', expect: 'hh-real-street' },
    { story: '想要 Lisa 那种暗黑女团嘻哈，能剧面具，王座，仪式感', expect: 'hh-kpop' },
    { story: '大牌美妆商拍，口红质地微距，全程无对白，高级感', expect: 'ad-cosmetics' },
    { story: '沉浸式护肤，小红书种草，精华质地特写，早C晚A', expect: 'ugc-skincare-asmr' },
    { story: '像周杰伦《晴天》那种校园 MV，单车，雨，走心一点', expect: 'mv-mandopop-ballad' },
    { story: '电音节现场那种感觉，激光烟雾，万人举手，drop 要炸开', expect: 'mv-edm-festival' },
    { story: '威士忌广告，书房雪茄，冰球，绅士，仪式感', expect: 'ad-premium-spirits' },
    { story: '麻醉的行业史科普，古今对比，传统技艺', expect: 'exp-historical-doc' },
  ];
  for (const { story, expect } of cases) {
    const match = matchStyleDna({ story });
    assert.ok(match, `no style matched: ${story}`);
    assert.equal(match.style.id, expect, `${story} → ${match.style.id}, expected ${expect} (hits ${match.hits.join('/')})`);
  }
}

/** Too vague to enhance: stay silent rather than guess a style. */
function silenceChecks(): void {
  for (const story of ['帮我生成一段长视频', '做个视频', '一分钟的片子，内容你来定', '']) {
    assert.equal(matchStyleDna({ story }), undefined, `vague request should not match: ${JSON.stringify(story)}`);
  }
  // A product request must not be dressed as a music video.
  const product = matchStyleDna({ story: '咖啡机的主图视频，卖点演示，详情页用，生活方式场景', mode: 'product' });
  assert.ok(product, 'product request should match');
  assert.notEqual(product.category, 'music-mv', 'product request matched a music-video style');
}

/** P24: an umbrella style asks for its route instead of picking one. */
function routeChecks(): void {
  const open = matchStyleDna({ story: '帮我做个动画 MV，二次元，卡通风格' });
  assert.ok(open, 'animation request should match the umbrella style');
  assert.equal(open.style.id, 'mv-animation');
  assert.ok(open.openRoutes && open.openRoutes.length >= 6, 'the animation routes should be offered');
  assert.match(routeQuestion(open), /不是一种风格/);

  const settled = matchStyleDna({ story: '黏土定格动画 MV，手工感，治愈系，二次元' });
  assert.ok(settled, 'clay request should match');
  assert.equal(settled.openRoutes, undefined, 'a named route settles the question');
}

/** The block carries rules, forbidden elements and the anchors' self-check. */
function blockChecks(): void {
  const match = matchStyleDna({ story: '说唱 MV，街头写实，滑板，鱼眼，crew' });
  assert.ok(match);
  // Category defaults reach the block even when the style did not list them.
  assert.ok(match.principles.includes('P6') && match.principles.includes('P23'), 'hip-hop defaults missing');
  const block = buildStyleEnhancement(match);
  assert.match(block, /Style Enhancement — additive/);
  assert.match(block, /禁止 \/ Forbidden: .*赛博朋克/);
  assert.match(block, /P6\./);
  assert.match(block, /#68/);
  assert.match(block, /#4/);
  assert.ok(block.split('\n').length <= 30, `the block rides in the planning story; keep it short (got ${block.split('\n').length} lines)`);

  // No anchors outside music videos: they were distilled from MVs.
  const ad = matchStyleDna({ story: '威士忌广告，橡木桶，品鉴，绅士，书房' });
  assert.ok(ad);
  assert.doesNotMatch(buildStyleEnhancement(ad), /自检/);
}

/** End to end: the rules reach the segment prompts, and only when they should. */
async function pipelineChecks(): Promise<void> {
  const story = '说唱 MV，街头写实，滑板青年，鱼眼镜头，crew 群像，夜晚街角。';
  const enhanced = await runHermeticSaga({ prompt: story, story, totalDuration: 10, ratio: '9:16', generateAudio: false }, { render: false });
  assert.equal(enhanced.result.ok, true, enhanced.result.output);
  assert.ok(enhanced.logs.some((line) => line.includes('风格增强')), `the applied style should be logged: ${enhanced.logs.join(' | ')}`);
  const prompts = JSON.stringify(videoTaskBodies(enhanced.requests));
  // The style reaches the video model through the continuity bible: its
  // forbidden elements join NEGATIVE, and its palette and camera fill the
  // slots the user and the brief left empty.
  assert.match(prompts, /\[NEGATIVE:[^\]]*赛博朋克/, 'the forbidden list should reach NEGATIVE');
  assert.match(prompts, /\[PALETTE:[^\]]*粗粝质感/, 'the style palette should fill the empty slot');
  assert.match(prompts, /\[CAMERA:[^\]]*鱼眼/, 'the style camera should fill the empty slot');

  // cleanDirect: the user asked for their own words, so nothing is added.
  const raw = await runHermeticSaga(
    { prompt: `${story}\n请用原始质感，不要滤镜，raw-seedance`, story, totalDuration: 10, ratio: '9:16', generateAudio: false, cleanDirect: true },
    { render: false },
  );
  assert.equal(raw.result.ok, true, raw.result.output);
  assert.equal(raw.logs.some((line) => line.includes('风格增强')), false, 'cleanDirect must not add the style block');
  const rawPrompts = JSON.stringify(videoTaskBodies(raw.requests));
  assert.doesNotMatch(rawPrompts, /赛博朋克/, 'cleanDirect prompts must stay the user\'s own');
}

async function main(): Promise<void> {
  libraryChecks();
  matchChecks();
  silenceChecks();
  routeChecks();
  blockChecks();
  await pipelineChecks();
  console.log('saga style enhancement smoke: ok');
}

await main();
