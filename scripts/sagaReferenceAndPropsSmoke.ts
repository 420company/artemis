import assert from 'node:assert/strict';
import { isLikelyProvidedTurnaroundReferenceForTest } from '../src/tools/visual/superVisualMode.js';
import { buildSagaConstitution } from '../src/tools/visual/sagaNarrative.js';

async function main(): Promise<void> {
  assert.equal(
    isLikelyProvidedTurnaroundReferenceForTest('/Users/goat/Pictures/character-turnaround.png'),
    true,
    'explicit character-turnaround path should be treated as a provided turnaround',
  );
  assert.equal(
    isLikelyProvidedTurnaroundReferenceForTest('/tmp/sv-user-inputs/0001.png', 'this is the canonical three-view character turnaround sheet'),
    true,
    'cached generic image path should still be recognized when reference notes describe a turnaround',
  );

  const constitution = buildSagaConstitution({
    mode: 'character',
    modeRationale: 'smoke test',
    protagonist: {
      name: 'card player',
      type: 'character',
      confidence: 1,
      evidence: 'test',
      aliases: ['player'],
    },
    supportingCharacters: [],
    props: ['playing cards', 'mahjong tiles'],
    environments: ['card table'],
    actions: ['holds a private hand of cards'],
    relationships: ['player holds cards toward herself'],
    protagonistAccessories: [],
    worldModel: {
      identityLockedProps: ['playing cards'],
      sceneVariableProps: ['mahjong tiles'],
    },
    source: 'user-clarification',
  });

  assert.match(constitution, /TWO-SIDED PROP SEMANTICS/, 'constitution should include two-sided prop rule');
  assert.match(constitution, /readable face.*patterned back/s, 'playing cards should preserve face/back semantics');
  assert.match(constitution, /Mahjong tiles.*marked\/readable face.*unmarked\/back/s, 'mahjong tiles should preserve face/back semantics');

  console.log('saga provided-turnaround and two-sided-prop smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
