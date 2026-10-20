import assert from 'node:assert/strict';
import {
  cohesionAt,
  detectFormat,
  findBoundaries,
  quoteDepths,
  splitLongform,
} from '../src/tools/visual/longformSplit.js';

/** A chapter of plausible prose, so the sizes are realistic. */
function chapter(title: string, scenes: readonly string[]): string {
  return `${title}\n\n${scenes.join('\n\n')}\n`;
}

const RAIN = '雨水顺着伞骨滴在门槛上，巷子里的石板泛着灯光。她把钥匙插进锁孔，手指冻得发僵，锁芯转了半圈就停住了。';
const DESERT = '沙丘的脊线在正午的白光里几乎看不见，骆驼的影子短得像一摊墨。商队的铃声从背后传来，一声一声砸在热风里。';

/**
 * Four kinds of text carry harder boundaries than any novel, and reading one
 * of them as prose throws those boundaries away.
 */
function formatChecks(): void {
  assert.equal(detectFormat(`${RAIN}\n\n${DESERT}`), 'prose');
  assert.equal(detectFormat('1\n00:00:01,000 --> 00:00:04,000\n她推开门\n\n2\n00:00:04,000 --> 00:00:07,000\n雨更大了'), 'subtitles');
  assert.equal(detectFormat('WEBVTT\n\n00:00.000 --> 00:04.000\n她推开门'), 'subtitles');
  assert.equal(detectFormat('INT. 公寓 - 夜\n她推开门。'), 'screenplay');
  assert.equal(detectFormat('场景一 公寓 夜\n她推开门。'), 'screenplay');
  assert.equal(detectFormat('阿雨：我回来了\n老陈：门没锁\n阿雨：外面在下雨\n老陈：伞呢\n阿雨：丢了\n'), 'dialogue');
  const verse = Array.from({ length: 12 }, (_, i) => `第${i}行很短的句子`).join('\n');
  assert.equal(detectFormat(verse), 'verse');
}

/**
 * A cut inside a quotation splits a line of dialogue in half. That is the one
 * mechanical error that always shows on screen, so it is forbidden outright.
 */
function quoteChecks(): void {
  const text = '他站起来。「我回来了。」她说。';
  const depths = quoteDepths(text);
  const inside = text.indexOf('我回来了');
  assert.ok(depths[inside]! > 0, 'inside the quotation the depth is above zero');
  assert.equal(depths[0], 0);
  assert.equal(depths[text.length], 0, 'a closed quotation comes back to zero');
  // Nested quotations.
  const nested = '她说「他喊『快走』然后跑了」。';
  const deep = quoteDepths(nested);
  assert.equal(deep[nested.indexOf('快走')], 2);
  // Straight quotes toggle, having no direction.
  const straight = 'He said "we made it home" and sat down.';
  assert.ok(quoteDepths(straight)[straight.indexOf('made')]! > 0);

  // No boundary is ever offered inside a quotation, even at a sentence end.
  const quoted = `${RAIN}「我回来了。外面在下雨。」她说。${DESERT}`;
  for (const boundary of findBoundaries(quoted)) {
    assert.equal(quoteDepths(quoted)[boundary.offset], 0, `boundary at ${boundary.offset} is inside a quotation`);
  }
}

/** Boundaries are read off the page, and the strongest one at a place wins. */
function boundaryChecks(): void {
  const book = [
    chapter('第一章 雨夜', [RAIN, RAIN]),
    '***',
    chapter('第二章 沙漠', [DESERT]),
  ].join('\n\n');
  const boundaries = findBoundaries(book);
  const chapters = boundaries.filter((boundary) => boundary.level === 'chapter');
  assert.equal(chapters.length, 1, '只有第二章是切点，第一章在开头');
  assert.match(chapters[0]!.label ?? '', /第二章/);
  assert.ok(boundaries.some((boundary) => boundary.level === 'scene-marker'), '*** 被认出来');
  // English headings and markdown too.
  assert.ok(findBoundaries(`${RAIN}\n\nChapter 2\n\n${DESERT}`).some((b) => b.level === 'chapter'));
  assert.ok(findBoundaries(`${RAIN}\n\n## 第二节\n\n${DESERT}`).some((b) => b.level === 'chapter'));
  // Never before an attribution.
  const attributed = '「我回来了。」她说道，然后关上了门。';
  assert.ok(!findBoundaries(attributed).some((b) => attributed.slice(b.offset).startsWith('她说道')));
}

/** The seam shows as a break in vocabulary, with no model involved. */
function cohesionChecks(): void {
  const text = `${RAIN.repeat(3)}${DESERT.repeat(3)}`;
  const seam = RAIN.repeat(3).length;
  const middleOfRain = Math.floor(seam / 2);
  const [atSeam, inside] = cohesionAt(text, [seam, middleOfRain]);
  assert.ok(atSeam! < inside!, `换场处的词汇重叠应更低（seam=${atSeam}, inside=${inside}）`);
  // Too little text on one side is not called a seam.
  assert.equal(cohesionAt(text, [4])[0], 1);
}

/** A chapter that fits is one chunk; the levels below are for what does not. */
function splitChecks(): void {
  const book = [
    chapter('第一章 雨夜', [RAIN, RAIN]),
    chapter('第二章 沙漠', [DESERT, DESERT]),
  ].join('\n\n');
  const chunks = splitLongform(book, { targetChars: 3000, maxChars: 6000, minChars: 100 });
  assert.equal(chunks.length, 2, '两章都装得下，就是两块');
  assert.equal(chunks[0]!.opensScene, true);
  assert.equal(chunks[0]!.closesScene, true, '下一块开新章，所以这块收完了');
  assert.equal(chunks[1]!.level, 'chapter');
  assert.match(chunks[1]!.label ?? '', /第二章/);
  // The opening heading is no boundary of its own, so chapter one would
  // otherwise be the one chunk with no title.
  assert.match(chunks[0]!.label ?? '', /第一章/);
  assert.ok(chunks[0]!.text.includes('雨水'));
  assert.ok(chunks[1]!.text.includes('沙丘'));
  // Offsets are real: slicing on them loses nothing.
  assert.ok(book.slice(chunks[1]!.startOffset).startsWith(chunks[1]!.text.slice(0, 8)));

  // A chapter too large for one call descends to the levels inside it. The
  // limits come from the text itself, so the test cannot drift out of step
  // with it: a cap at a third of the chapter must force at least three cuts.
  const huge = chapter('第一章 长夜', [RAIN.repeat(12), DESERT.repeat(12)]);
  const cap = Math.floor(huge.length / 3);
  const split = splitLongform(huge, { targetChars: Math.floor(cap * 0.7), maxChars: cap, minChars: 100 });
  assert.ok(split.length >= 3, `一章 ${huge.length} 字、上限 ${cap} 要切成 3 块以上，得到 ${split.length}`);
  for (const chunk of split) assert.ok(chunk.text.length <= cap, `每块不超过上限（${chunk.text.length} > ${cap}）`);
  // The pieces reassemble into the original, in order, with nothing lost.
  const joined = split.map((chunk) => chunk.text).join('');
  assert.ok(joined.includes('雨水') && joined.includes('沙丘'));
  assert.deepEqual([...split].sort((a, b) => a.startOffset - b.startOffset).map((c) => c.index), split.map((c) => c.index));
}

/**
 * The case the owner asked about: no chapters, no separators, no blank lines,
 * nothing but sentences. There are still legal cuts, and the vocabulary
 * decides among them.
 */
function unmarkedChecks(): void {
  const wall = `${RAIN.repeat(8)}${DESERT.repeat(8)}`;
  assert.ok(!wall.includes('\n'), 'the test text really has no structure');
  const wallCap = Math.floor(wall.length / 4);
  const chunks = splitLongform(wall, { targetChars: Math.floor(wallCap * 0.7), maxChars: wallCap, minChars: 60 });
  assert.ok(chunks.length >= 4, `${wall.length} 字、上限 ${wallCap}，只剩句末也要切成 4 块以上，得到 ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= wallCap, `${chunk.text.length} > ${wallCap}`);
    assert.equal(chunk.level === 'sentence' || chunk.index === 1, true);
  }
  // Cut mid-scene, so every piece but the first is a continuation and says so.
  assert.equal(chunks[0]!.opensScene, true);
  assert.equal(chunks[1]!.opensScene, false, '中途切出来的块必须自报是续块');
  // The cut lands at a sentence end, never mid-sentence.
  for (const chunk of chunks.slice(1)) {
    const before = wall.slice(0, chunk.startOffset);
    assert.match(before.slice(-2), /[。！？…”’」』]/, `切点落在句末（…${before.slice(-6)}）`);
  }

  // An unbroken stream with no seam at all: equal pieces, all continuations,
  // which is the long take the writing actually is.
  const monologue = '我不知道该怎么说这件事情呢也许根本就没有办法说清楚吧'.repeat(40);
  const monoCap = Math.floor(monologue.length / 5);
  const flat = splitLongform(monologue, { targetChars: Math.floor(monoCap * 0.7), maxChars: monoCap, minChars: 80 });
  assert.ok(flat.length >= 5, `没有标点也要切得出来，得到 ${flat.length} 块`);
  for (const chunk of flat) assert.ok(chunk.chars > 0 && chunk.text.length <= monoCap);
  assert.equal(flat.slice(1).every((chunk) => chunk.opensScene === false), true);
}

/** Nothing in, nothing out — and a short text is one chunk, not none. */
function edgeChecks(): void {
  assert.deepEqual(splitLongform(''), []);
  assert.deepEqual(splitLongform('   \n\n  '), []);
  const one = splitLongform(RAIN);
  assert.equal(one.length, 1);
  assert.equal(one[0]!.opensScene, true);
  assert.equal(one[0]!.closesScene, true);
  // Windows line endings and a BOM do not change the cut.
  const crlf = splitLongform(`﻿第一章\r\n\r\n${RAIN}\r\n\r\n第二章\r\n\r\n${DESERT}`, { targetChars: 2000, maxChars: 4000, minChars: 50 });
  assert.ok(crlf.length >= 2);
  for (const chunk of crlf) assert.ok(!chunk.text.includes('\r'), 'no stray carriage returns');
}

function main(): void {
  formatChecks();
  quoteChecks();
  boundaryChecks();
  cohesionChecks();
  splitChecks();
  unmarkedChecks();
  edgeChecks();
  console.log('saga longform split smoke: ok');
}

main();
