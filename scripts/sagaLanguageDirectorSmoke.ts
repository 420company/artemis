import assert from 'node:assert/strict';
import {
  buildDeterministicEnglishVisualPrompt,
  detectTextLanguage,
  extractSagaDialogueLines,
  normalizeSagaPromptForVideoGeneration,
} from '../src/tools/visual/sagaLanguageDirector.js';

async function main(): Promise<void> {
  assert.equal(detectTextLanguage('你终于来了'), 'Mandarin Chinese');
  assert.equal(detectTextLanguage('あなたを待っていた'), 'Japanese');
  assert.equal(detectTextLanguage('기다리고 있었어'), 'Korean');
  assert.equal(detectTextLanguage('Je suis ici, mon amour'), 'French');
  assert.equal(detectTextLanguage('Estoy aquí, corazón'), 'Spanish');
  assert.equal(detectTextLanguage('Sono qui, amore'), 'Italian');
  assert.equal(detectTextLanguage('I am here'), 'English');

  const text = '一个中国女孩看着镜头。对白：“你终于来了。” 旁白：“雨还在下。” 字幕：“三年后”。 dialogue: “Estoy aquí, corazón” voiceover: “Je suis ici, mon amour”';
  const lines = extractSagaDialogueLines(text);
  assert.equal(lines.length, 5, 'should extract marked multilingual dialogue/voiceover/subtitle lines');
  assert.deepEqual(lines.map((line) => line.use), ['spoken_dialogue', 'voiceover', 'subtitle', 'spoken_dialogue', 'voiceover']);
  assert.deepEqual(lines.map((line) => line.language), ['Mandarin Chinese', 'Mandarin Chinese', 'Mandarin Chinese', 'Spanish', 'French']);

  const prompt = buildDeterministicEnglishVisualPrompt({ originalText: text, dialogueLines: lines, subtitleMode: 'always' });
  assert.match(prompt, /Generation instruction language: English/);
  assert.match(prompt, /Chinese/);
  assert.match(prompt, /Dialogue handling:/);
  assert.match(prompt, /Detected languages: Mandarin Chinese, Spanish, French/);
  assert.match(prompt, /Render speech in the original language with matching lip-sync/);
  assert.match(prompt, /Render readable on-screen subtitles\/captions/);
  assert.match(prompt, /User brief \(source material to render\):/);
  // Each dialogue line must appear exactly once in the prompt — only inside
  // the user brief, never re-listed as a numbered "exact text:" map.
  for (const line of lines) {
    const occurrences = prompt.split(line.text).length - 1;
    assert.equal(occurrences, 1, `dialogue "${line.text}" should appear exactly once, got ${occurrences}`);
  }
  assert.doesNotMatch(prompt, /exact text:/);
  assert.doesNotMatch(prompt, /matching lip movement;/);
  assert.doesNotMatch(prompt, /Saga Visual Director Language Normalization/);

  const normalized = await normalizeSagaPromptForVideoGeneration({ cwd: process.cwd(), text, enableLlmRewrite: false, subtitleMode: 'off' });
  assert.equal(normalized.generationLanguage, 'en');
  assert.equal(normalized.usedLlmRewrite, false);
  assert.equal(normalized.dialogueLines.length, 5);
  assert.match(normalized.generationText, /Dialogue handling:/);
  assert.match(normalized.generationText, /Keep dialogue\/voiceover as audio only/);
  for (const line of lines) {
    const occurrences = normalized.generationText.split(line.text).length - 1;
    assert.equal(occurrences, 1, `normalized: dialogue "${line.text}" should appear exactly once, got ${occurrences}`);
  }

  // --- marker-aware extraction regression tests ---

  // Markdown-bold marker (** ... **:) is recognized.
  const markdownBriefSnippet = '剧情段落。\n**对白（约 14 秒，马拉喀什段，极轻低语）**: "我一直在找一个人。"\n更多剧情。';
  const markdownLines = extractSagaDialogueLines(markdownBriefSnippet);
  assert.equal(markdownLines.length, 1, 'markdown-bold marker should be detected');
  assert.equal(markdownLines[0].text, '我一直在找一个人。');
  assert.equal(markdownLines[0].marker, '对白');
  assert.equal(markdownLines[0].use, 'spoken_dialogue');

  // Bare quoted design/concept refs without sentence-final punctuation must
  // NOT be misclassified as dialogue.
  const designRefSnippet = '参考: "Parts Unknown" 风格。不是简化版"中国街道"也不是 "霓虹城市"。歌词副标题: "It was just two lovers / sittin\' in the car"。';
  const designRefLines = extractSagaDialogueLines(designRefSnippet);
  assert.equal(designRefLines.length, 0, `design refs should NOT count as dialogue, got: ${JSON.stringify(designRefLines.map((l) => l.text))}`);

  // Bare quoted CJK sentence WITH sentence-final punct still falls through
  // greedy fallback (so unmarked Chinese dialogue isn't lost entirely).
  const bareCJKSentence = '她说道 "我在这里。"';
  const bareCJKLines = extractSagaDialogueLines(bareCJKSentence);
  assert.equal(bareCJKLines.length, 1);
  assert.equal(bareCJKLines[0].text, '我在这里。');

  // Ellipsis-terminated lines are recognized as dialogue.
  const ellipsisSnippet = '对白: "走了好远好远..."';
  const ellipsisLines = extractSagaDialogueLines(ellipsisSnippet);
  assert.equal(ellipsisLines.length, 1);
  assert.equal(ellipsisLines[0].text, '走了好远好远...');

  console.log('saga language director smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
