import assert from 'node:assert/strict';
import { DesignSystem } from '../src/design/index.js';
import { DEFAULT_CONFIG } from '../src/design/config.js';
import { DESIGN_STYLES } from '../src/design/styles/index.js';

function test(name: string, fn: () => void): void {
  fn();
  console.log(`✔ ${name}`);
}

console.log('\n  featureSmoke');
console.log('  ============');

test('/design prompt uses absorbed plugin capabilities', () => {
  const prompt = DesignSystem.buildDesignWorkflowPrompt('设计一个赛博朋克产品首页');
  for (const plugin of ['logo-designer', 'kaleidoscope', 'shit-poster', 'dirty-prompt', 'color-master', 'web-spider']) {
    assert.match(prompt, new RegExp(plugin));
  }
});

test('/design prompt forbids empty links and fake controls', () => {
  const prompt = DesignSystem.buildDesignWorkflowPrompt('做一个网站');
  assert.match(prompt, /href="#"/);
  assert.match(prompt, /假按钮/);
});

test('/design style catalog exposes all 30 requested styles', () => {
  assert.equal(DEFAULT_CONFIG.supportedStyles.length, 30);
  assert.equal(Object.keys(DESIGN_STYLES).length, 30);
  assert.ok(DEFAULT_CONFIG.supportedStyles.includes('cyberpunk'));
  assert.ok(DEFAULT_CONFIG.supportedStyles.includes('dreamcore'));
});

test('/design identifies named visual styles', () => {
  assert.deepEqual(DesignSystem.identifyDesignStyles('赛博朋克首页'), ['赛博朋克']);
  assert.deepEqual(DesignSystem.identifyDesignStyles('Bauhaus Style logo'), ['包豪斯风格']);
});

test('/design optimized prompt is structured, not random prose', () => {
  const optimized = DesignSystem.optimizeDesignPrompt('做一个海报');
  for (const section of ['概念：', '输出：', '受众/任务：', '风格：', '构图：', '细节：', '相机/空间：', '禁止：', '严格性：']) {
    assert.match(optimized, new RegExp(section));
  }
});

test('/design style-specific negatives do not contradict vivid styles', () => {
  const optimized = DesignSystem.optimizeDesignPrompt('做一个孟菲斯风格糖果色产品海报');
  assert.match(optimized, /70% 孟菲斯风格/);
  assert.doesNotMatch(optimized, /无鲜艳色彩/);
  assert.doesNotMatch(optimized, /无失控高饱和色彩/);
});

test('/design motion prompts add a time-coded sequence contract', () => {
  const optimized = DesignSystem.optimizeDesignPrompt('做一个极简主义 15 秒 logo 动效视频');
  assert.match(optimized, /动效\/时间轴/);
  assert.match(optimized, /0-1s/);
  assert.match(optimized, /单一连续视觉演化/);
});

console.log('\n  ✔ All feature smoke tests passed');
