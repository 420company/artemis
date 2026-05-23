import assert from 'node:assert/strict';
import { findProvidedTurnaroundInputForTest, isLikelyProvidedTurnaroundReferenceForTest } from '../src/tools/visual/superVisualMode.js';
import { buildSagaConstitution } from '../src/tools/visual/sagaNarrative.js';
import { shouldBypassSuperVisualForIdentitySourceForTest } from '../src/tools/generateLongVideo.js';

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
  // The Saga identity-source menu's pick = the system's behaviour. Filename
  // heuristics are a SECONDARY signal — they cannot override the user's
  // explicit choice. Regression: a user uploaded testgirl.png after picking
  // option 1 ("我有角色三视图"), and the system still ran Image-2 to regenerate
  // a turnaround because the filename did not contain "turnaround / 三视图".
  assert.equal(
    findProvidedTurnaroundInputForTest(
      ['/Users/goat/Desktop/testgirl.png'],
      ['/Users/goat/Desktop/testgirl.png'],
      undefined,
      'turnaround',
    ),
    '/Users/goat/Desktop/testgirl.png',
    'identitySource="turnaround" must trust the user\'s menu pick regardless of filename',
  );
  assert.equal(
    findProvidedTurnaroundInputForTest(
      ['/Users/goat/Desktop/testgirl.png'],
      ['/Users/goat/Desktop/testgirl.png'],
      undefined,
      'character_image',
    ),
    undefined,
    'identitySource="character_image" must NOT short-circuit Image-2 — the user wanted a generated turnaround',
  );
  assert.equal(
    findProvidedTurnaroundInputForTest(
      ['/Users/goat/Desktop/some-photo.png'],
      ['/Users/goat/Desktop/some-photo.png'],
    ),
    undefined,
    'without identitySource, plain-named files fall back to legacy filename heuristic (no turnaround keyword → not treated as turnaround)',
  );
  assert.equal(
    findProvidedTurnaroundInputForTest(
      ['/tmp/cached/0001.png'],
      ['/Users/goat/Desktop/my-character-turnaround.png'],
    ),
    '/tmp/cached/0001.png',
    'filename heuristic still works as a back-up signal when identitySource is absent',
  );
  assert.equal(
    shouldBypassSuperVisualForIdentitySourceForTest('turnaround'),
    false,
    'explicit user-supplied turnaround should enter Super Visual bridge mode without regenerating the turnaround',
  );
  assert.equal(
    shouldBypassSuperVisualForIdentitySourceForTest('direct_image'),
    true,
    'direct image mode should bypass Super Visual generation',
  );
  assert.equal(
    shouldBypassSuperVisualForIdentitySourceForTest('character_image'),
    false,
    'character photo mode should still use Super Visual to build a turnaround',
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
