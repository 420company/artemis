import assert from 'node:assert/strict';
import { buildCompactStyleEnhancement, buildStyleEnhancement, matchStyleDna, musicStructureFor, pickStructureTemplate, routeQuestion } from '../src/tools/visual/styleMatch.js';
import { CONDITIONAL_PRINCIPLES, ELICITATION, STRUCTURE_TEMPLATES, STYLE_LIBRARY, STYLE_PRINCIPLES, principleById, styleById } from '../src/tools/visual/styleDna.js';
import { runHermeticSaga, videoTaskBodies, withHermeticWorkspace } from './sagaHermeticHarness.js';

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
  assert.equal(STYLE_PRINCIPLES.length, 28, '24 verified principles, P25, and the three from the director-mode panel and VIBES');
  const principleIds = new Set(STYLE_PRINCIPLES.map((principle) => principle.id));
  assert.equal(principleIds.size, 28, 'principle ids are unique');
  for (const template of STRUCTURE_TEMPLATES) {
    assert.ok(template.beats.length >= 3, `${template.id} needs a usable skeleton`);
    for (const beat of template.beats) assert.ok(beat.span && beat.beat && beat.camera, `${template.id} has an incomplete beat`);
  }
  for (const [key, item] of Object.entries(ELICITATION)) {
    assert.ok(item.question.endsWith('？'), `${key} should read as a question`);
    assert.ok(item.hint.length > 10, `${key} needs a usable hint`);
  }
  for (const principle of CONDITIONAL_PRINCIPLES) {
    assert.ok((principle.triggers?.length ?? 0) >= 3, `${principle.id} is conditional, so it needs a usable cue list`);
  }
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

/** P25 is a technique: it waits for its own cue instead of riding along. */
function conditionalPrincipleChecks(): void {
  const asked = matchStyleDna({ story: '说唱 MV，街头写实，crew 群像，副歌想用穿越机飞进烟花爆炸中心' });
  assert.ok(asked, 'the request should still match a street style');
  assert.ok(asked.principles.includes('P25'), 'P25 should apply once the request asks for the reveal');
  assert.match(buildStyleEnhancement(asked), /FPV drone flying through explosion interior/, 'the prompt keyword should reach the block');

  const plain = matchStyleDna({ story: '说唱 MV，街头写实，滑板，鱼眼，crew 群像' });
  assert.ok(plain);
  assert.equal(plain.principles.includes('P25'), false, 'P25 must not ride along uninvited');

  // Native to the festival style: the FPV fly-through is part of its DNA.
  assert.ok(styleById('mv-edm-festival')?.principles.includes('P25'), 'EDM should carry P25 unconditionally');
  const edm = matchStyleDna({ story: '电音节现场那种感觉，激光烟雾，万人举手，drop 要炸开' });
  assert.ok(edm);
  assert.ok(edm.principles.includes('P25'), 'the festival style applies P25 without a cue');

  // Out of scope: a phone-shot UGC video cannot fly a drone through anything.
  const ugc = matchStyleDna({ story: '沉浸式护肤，小红书种草，精华质地特写，早C晚A，想要烟花感的奇观' });
  assert.ok(ugc);
  assert.equal(ugc.principles.includes('P25'), false, 'P25 is out of scope for UGC');
}

/** A request with no structure of its own gets a skeleton; one that brought a script keeps it. */
function structureChecks(): void {
  const match = matchStyleDna({ story: '说唱 MV，街头写实，滑板，鱼眼，crew' });
  assert.ok(match);
  const template = pickStructureTemplate(match, false);
  assert.ok(template, 'a request without a structure should get one');
  assert.equal(template.id, 'four-beat-mv');
  assert.equal(pickStructureTemplate(match, true), undefined, 'a user who wrote a script keeps it (P27)');
  const block = buildStyleEnhancement(match, { structureTemplate: template });
  assert.match(block, /结构 \/ Structure/);
  assert.match(block, /收束留余味|收束/);

  // The commercial skeleton for an ad, the beauty three-act for cosmetics.
  const ad = matchStyleDna({ story: '威士忌广告，橡木桶，品鉴，绅士，书房' });
  assert.ok(ad);
  assert.equal(pickStructureTemplate(ad, false)?.id, 'four-beat-ad');
  const cosmetics = matchStyleDna({ story: '大牌美妆商拍，口红质地微距，全程无对白，高级感' });
  assert.ok(cosmetics);
  assert.equal(pickStructureTemplate(cosmetics, false)?.id, 'beauty-three-act');

  // Music styles carry their cut-point mapping; VIBES would only fill its numbers.
  const edm = matchStyleDna({ story: '电音节现场那种感觉，激光烟雾，万人举手，drop 要炸开' });
  assert.ok(edm);
  assert.match(String(musicStructureFor(edm)), /build-up/);
  assert.equal(musicStructureFor(ad), undefined, 'an ad has no music structure');
}

/** The single-clip path (一句话生成) gets the three locks, within a tight budget. */
function compactChecks(): void {
  const match = matchStyleDna({ story: '帮我生成一个说唱 MV 的视频，街头写实，滑板，鱼眼' });
  assert.ok(match);
  const compact = buildCompactStyleEnhancement(match);
  assert.ok(compact.length > 0 && compact.length <= 420, `compact block should fit the budget (got ${compact.length})`);
  assert.match(compact, /色调 Palette/);
  assert.match(compact, /禁止 Avoid/);
  assert.doesNotMatch(compact, /自检|Rules|结构/, 'the compact block carries only what changes the picture');
  assert.equal(buildCompactStyleEnhancement(match, 40), '', 'an impossible budget yields nothing rather than a truncated lock');
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

/** End to end on the single-clip path: the locks reach the video task itself. */
async function singleClipPipelineChecks(): Promise<void> {
  const { executeGenerateVideo } = await import('../src/tools/generateVideo.js');
  const story = '帮我生成一个说唱 MV 的视频，街头写实，滑板青年，鱼眼镜头，crew 群像。';
  await withHermeticWorkspace({ render: false }, async (cwd, requests) => {
    const result = await executeGenerateVideo(
      { type: 'generate_video', prompt: story, duration: 5, ratio: '9:16', resolution: '480p' } as never,
      { cwd, permissionMode: 'full-access', sessionId: 'style-single', locale: 'zh-CN', requestWorkspaceSwitch: async () => true } as never,
    );
    assert.equal((result as { ok: boolean }).ok, true, String((result as { output: string }).output));
    const sent = JSON.stringify(videoTaskBodies(requests));
    assert.match(sent, /赛博朋克|cyberpunk/i, 'the style\'s forbidden list should reach the single-clip task');
  });

  // cleanDirect on the single-clip path adds nothing either.
  await withHermeticWorkspace({ render: false }, async (cwd, requests) => {
    const result = await executeGenerateVideo(
      { type: 'generate_video', prompt: story, duration: 5, ratio: '9:16', resolution: '480p', cleanDirect: true } as never,
      { cwd, permissionMode: 'full-access', sessionId: 'style-single-raw', locale: 'zh-CN', requestWorkspaceSwitch: async () => true } as never,
    );
    assert.equal((result as { ok: boolean }).ok, true, String((result as { output: string }).output));
    assert.doesNotMatch(JSON.stringify(videoTaskBodies(requests)), /赛博朋克/, 'cleanDirect keeps the prompt the user\'s own');
  });
}

async function main(): Promise<void> {
  libraryChecks();
  matchChecks();
  silenceChecks();
  routeChecks();
  conditionalPrincipleChecks();
  structureChecks();
  compactChecks();
  blockChecks();
  await pipelineChecks();
  await singleClipPipelineChecks();
  console.log('saga style enhancement smoke: ok');
}

await main();
