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
  assert.match(prompt, /spoken dialogue, spoken aloud with matching lip movement; language: Mandarin Chinese; exact text: “你终于来了。”/);
  assert.match(prompt, /voiceover narration; language: Mandarin Chinese; exact text: “雨还在下。”/);
  assert.match(prompt, /on-screen subtitle\/caption; language: Mandarin Chinese; exact text: “三年后”/);
  assert.match(prompt, /spoken dialogue, spoken aloud with matching lip movement; language: Spanish; exact text: “Estoy aquí, corazón”/);
  assert.match(prompt, /voiceover narration; language: French; exact text: “Je suis ici, mon amour”/);
  assert.match(prompt, /User selected subtitles/);

  const normalized = await normalizeSagaPromptForVideoGeneration({ cwd: process.cwd(), text, enableLlmRewrite: false, subtitleMode: 'off' });
  assert.equal(normalized.generationLanguage, 'en');
  assert.equal(normalized.usedLlmRewrite, false);
  assert.equal(normalized.dialogueLines.length, 5);
  assert.match(normalized.generationText, /Do not translate quoted dialogue/);
  assert.match(normalized.generationText, /User selected no subtitles/);

  console.log('saga language director smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
