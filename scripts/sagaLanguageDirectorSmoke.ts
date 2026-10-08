import assert from 'node:assert/strict';
import {
  buildDeterministicEnglishVisualPrompt,
  detectTextLanguage,
  extractSagaDialogueLines,
  normalizeSagaPromptForVideoGeneration,
  parseSpokenLine,
  relocateDialogueCues,
} from '../src/tools/visual/sagaLanguageDirector.js';

function spokenOf(text: string, knownSpeakers?: string[]): string[] {
  return extractSagaDialogueLines(text, { knownSpeakers }).map((line) => line.text);
}

async function spokenLineCleanup(): Promise<void> {
  // Speaker names and stage directions inside the quotes are not spoken.
  assert.deepEqual(spokenOf('他大喊:"方天豪：（豪迈大笑）今天谁也别想走！"'), ['今天谁也别想走！']);
  assert.deepEqual(spokenOf('对白：“方天豪：（豪迈大笑）今天谁也别想走！”'), ['今天谁也别想走！']);
  assert.deepEqual(spokenOf('**对白（低沉）**：“林夏:(轻声) 我等你很久了。”'), ['我等你很久了。']);
  // Multi-word Latin names.
  assert.deepEqual(spokenOf('dialogue: "Cold Moon: (whispering) We leave at dawn!"'), ['We leave at dawn!']);
  // Plain lines are unchanged.
  assert.deepEqual(spokenOf('旁白：“很多年以后，他才明白。”'), ['很多年以后，他才明白。']);
  // Over-strip cases: none of these prefixes or parentheticals is a speaker or a direction.
  assert.deepEqual(spokenOf('对白：“注意：前方有危险！”'), ['注意：前方有危险！']);
  assert.deepEqual(spokenOf('对白：“10:30 我们出发！”'), ['10:30 我们出发！']);
  assert.deepEqual(spokenOf('She says: "Listen: the bridge is out!"'), ['Listen: the bridge is out!']);
  assert.deepEqual(spokenOf('对白：“我（们）一起走吧。”'), ['我（们）一起走吧。']);
  assert.deepEqual(spokenOf('dialogue: "I will be there (I promise)!"'), ['I will be there (I promise)!']);
  // A known name is removed even without a direction; an unknown one is kept.
  assert.deepEqual(spokenOf('对白：“方天豪：走吧！”', ['方天豪']), ['走吧！']);
  assert.deepEqual(spokenOf('对白：“方天豪：走吧！”'), ['方天豪：走吧！']);
  // A name seen once as "Name: (direction)" is known for the rest of the brief.
  assert.deepEqual(
    spokenOf('对白：“方天豪：（冷笑）你来了。” 对白：“方天豪：走吧！”'),
    ['你来了。', '走吧！'],
  );
  // A trailing direction after the sentence ends, and a direction between the colon and the quote.
  assert.deepEqual(spokenOf('对白：“今天谁也别想走！（拍桌）”'), ['今天谁也别想走！']);
  assert.deepEqual(spokenOf('对白：（低声）“你终于来了。”'), ['你终于来了。']);
  // A quote that is only a direction is not speech: it loses its quotes.
  assert.deepEqual(parseSpokenLine('（沉默）'), { spoken: '', cues: ['沉默'] });
  assert.equal(relocateDialogueCues('他抬头。“（叹气）”'), '他抬头。（叹气）');
  assert.deepEqual(spokenOf('对白：“（叹气）”'), []);
  // A second speaker inside one quote becomes a line of its own.
  assert.equal(
    relocateDialogueCues('“方天豪：（大笑）走！李四：（冷笑）你走不了。”'),
    '（方天豪，大笑）“走！”（李四，冷笑）“你走不了。”',
  );
  assert.deepEqual(spokenOf('对白：“方天豪：（大笑）走！李四：（冷笑）你走不了。”'), ['走！', '你走不了。']);
  // Abbreviations never split a speaker; a direction after a sentence ends is removed anywhere.
  assert.equal(relocateDialogueCues('dialogue: "Dr. Smith: (sighs) We are out of time."'), 'dialogue: (Dr. Smith, sighs) "We are out of time."');
  assert.equal(relocateDialogueCues('"Yes! (laughs) Absolutely! (smiles)"'), '(laughs, smiles) "Yes! Absolutely!"');
  // Conservative cases stay as written.
  assert.equal(relocateDialogueCues('"I met Dr. (Jane) Smith yesterday."'), '"I met Dr. (Jane) Smith yesterday."');
  assert.equal(relocateDialogueCues('“快跑！注意：（压低声音）别回头。”'), '“快跑！注意：（压低声音）别回头。”', '注意 is not a speaker');
  assert.equal(relocateDialogueCues('他在墙上写下“（未完待续）”。'), '他在墙上写下“（未完待续）”。', 'on-screen text keeps its quotes');
  // 「」 quotes, and kana / Hangul speaker names.
  assert.equal(relocateDialogueCues('「田中：（笑）行こう！」'), '（田中，笑）「行こう！」');
  assert.equal(relocateDialogueCues('“ミク：（笑顔）ありがとう！”'), '（ミク，笑顔）“ありがとう！”');
  assert.equal(relocateDialogueCues('“김철수: (웃으며) 가자!”'), '（김철수，웃으며）“가자!”');
  // ASCII quotes that cannot be paired safely are left alone.
  for (const ambiguous of [
    'He pulls a 6" blade. "Drop it!" (gunshot) Everyone freezes. "Who fired?"',
    '他拿起一张5"照片。"别动！"（枪声）众人回头。"谁开的枪？"',
    '"She said "hi" (laughs) and left."',
  ]) {
    assert.equal(relocateDialogueCues(ambiguous), ambiguous, ambiguous);
  }
  assert.deepEqual(spokenOf('他拿起一张5"照片。"别动！"（枪声）众人回头。'), [], 'an odd number of ASCII quotes on a line yields no guessed dialogue');
  assert.deepEqual(parseSpokenLine('方天豪：（豪迈大笑）今天谁也别想走！'), {
    spoken: '今天谁也别想走！',
    speaker: '方天豪',
    cues: ['豪迈大笑'],
  });

  // The brief itself keeps the speaker and the direction, outside the quotes.
  assert.equal(
    relocateDialogueCues('[0-5秒] 码头。对白：“方天豪：（豪迈大笑）今天谁也别想走！”'),
    '[0-5秒] 码头。对白：（方天豪，豪迈大笑）“今天谁也别想走！”',
  );
  assert.equal(
    relocateDialogueCues('dialogue: "Cold Moon: (whispering) We leave at dawn!"'),
    'dialogue: (Cold Moon, whispering) "We leave at dawn!"',
  );
  const untouched = '对白：“注意：前方有危险！” 对白：“10:30 我们出发！” 参考 "Parts Unknown"';
  assert.equal(relocateDialogueCues(untouched), untouched);

  const normalized = await normalizeSagaPromptForVideoGeneration({
    cwd: process.cwd(),
    text: '[0-5秒] 码头夜景。对白：“方天豪：（豪迈大笑）今天谁也别想走！”',
    enableLlmRewrite: false,
  });
  assert.deepEqual(normalized.dialogueLines.map((line) => line.text), ['今天谁也别想走！']);
  assert.match(normalized.originalText, /（方天豪，豪迈大笑）“今天谁也别想走！”/);
  assert.doesNotMatch(normalized.generationText, /“方天豪：/);
  assert.match(normalized.originalText, /^\[0-5秒\]/, 'timecodes must survive the relocation');
}

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
  assert.match(prompt, /Only these marked lines are spoken: “你终于来了。” \(Mandarin Chinese, spoken\); “雨还在下。” \(Mandarin Chinese, voiceover, no lip-sync\); “三年后” \(Mandarin Chinese, on-screen subtitle\); “Estoy aquí, corazón” \(Spanish, spoken\); “Je suis ici, mon amour” \(French, voiceover, no lip-sync\)\. Other quoted text is not speech\./);
  assert.match(prompt, /Speak each line in its original language with matching lip-sync/);
  assert.match(prompt, /Render readable on-screen subtitles\/captions/);
  assert.match(prompt, /User brief \(source material to render\):/);
  // Each dialogue line appears in the brief and once in the list of marked
  // lines, never in a numbered "exact text:" map.
  for (const line of lines) {
    const occurrences = prompt.split(line.text).length - 1;
    assert.equal(occurrences, 2, `dialogue "${line.text}" should appear in the brief and the marked-line list, got ${occurrences}`);
  }
  assert.doesNotMatch(prompt, /exact text:/);
  assert.doesNotMatch(prompt, /matching lip movement;/);
  assert.doesNotMatch(prompt, /Saga Visual Director Language Normalization/);

  const normalized = await normalizeSagaPromptForVideoGeneration({ cwd: process.cwd(), text, enableLlmRewrite: false, subtitleMode: 'off' });
  assert.equal(normalized.generationLanguage, 'en');
  assert.equal(normalized.usedLlmRewrite, false);
  assert.equal(normalized.dialogueLines.length, 5);
  assert.match(normalized.generationText, /Dialogue handling:/);
  assert.match(normalized.generationText, /Dialogue and voiceover are audio only/);
  for (const line of lines) {
    const occurrences = normalized.generationText.split(line.text).length - 1;
    assert.equal(occurrences, 2, `normalized: dialogue "${line.text}" should appear in the brief and the marked-line list, got ${occurrences}`);
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

  // Guide §3.2: a bare quote is not dialogue, even a whole sentence; a
  // speech verb with a colon is a marker.
  assert.equal(extractSagaDialogueLines('她回头。"我在这里。"').length, 0, 'a bare quoted sentence is not dialogue');
  assert.deepEqual(spokenOf('她低声说："我在这里。"'), ['我在这里。']);
  assert.deepEqual(spokenOf('She whispers: "I\'ve waited, we\'d said so."'), ["I've waited, we'd said so."], 'apostrophes stay inside the line');
  assert.deepEqual(spokenOf('**对白（French, intimate）**: "Je t\'ai attendu si longtemps."'), ["Je t'ai attendu si longtemps."]);
  assert.deepEqual(spokenOf('**line**: "I\'m back."'), ["I'm back."]);
  assert.deepEqual(spokenOf('周屿：“（轻笑）我回来了。”'), ['我回来了。'], 'a speaker name opening a line marks dialogue');
  assert.deepEqual(spokenOf('歌词：“It was just two lovers”\n招牌写着“霓虹城市”\n标题：“重逢”'), [], 'lyrics, signs and titles are never dialogue');
  const none = buildDeterministicEnglishVisualPrompt({ originalText: '霓虹招牌写着"霓虹城市"。', subtitleMode: 'auto' });
  assert.match(none, /There is no dialogue/);

  // Ellipsis-terminated lines are recognized as dialogue.
  const ellipsisSnippet = '对白: "走了好远好远..."';
  const ellipsisLines = extractSagaDialogueLines(ellipsisSnippet);
  assert.equal(ellipsisLines.length, 1);
  assert.equal(ellipsisLines[0].text, '走了好远好远...');

  await spokenLineCleanup();

  console.log('saga language director smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
