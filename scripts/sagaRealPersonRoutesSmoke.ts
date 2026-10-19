import assert from 'node:assert/strict';
import { nsfwCapable, realPersonAllowed } from '../src/utils/visualGenerationConfig.js';
import { diffSanitize, sanitizeForVideoProvider } from '../src/tools/visual/sagaNarrative.js';

/**
 * Two routes for a real person, and which one runs is the provider's policy,
 * never a guess:
 *
 *   filtered (BytePlus's official API, whose filter is an image classifier):
 *     the person reaches the video model as an illustrated identity-only
 *     sheet, and the keyframes pull the look back to photographic.
 *   allowed (router.ai): the person goes through as they are, and the word
 *     guard stays out of the owner's wording.
 *
 * The default is "allowed", except for the providers known to filter: a wrong
 * "allowed" costs one refusal the run reports, a wrong "filtered" turns the
 * owner's real person into a cartoon and nobody finds out why.
 */
function policyChecks(): void {
  assert.equal(realPersonAllowed({ provider: 'byteplus' }), false, 'BytePlus filters real people');
  assert.equal(realPersonAllowed({ provider: 'BytePlus' }), false, 'the provider id is matched case-insensitively');
  assert.equal(realPersonAllowed({ provider: 'routerai' }), true, 'router.ai takes the person');
  assert.equal(realPersonAllowed({ provider: 'custom' }), true, 'an unknown provider is trusted, and a refusal is visible');
  // NSFW implies it, and an explicit setting wins over everything.
  assert.equal(realPersonAllowed({ provider: 'byteplus', nsfw: true }), true, 'an NSFW BytePlus slot takes the person');
  assert.equal(realPersonAllowed({ provider: 'byteplus', realPerson: true }), true, 'an explicit yes wins');
  assert.equal(realPersonAllowed({ provider: 'routerai', realPerson: false }), false, 'an explicit no wins too');
  assert.equal(realPersonAllowed({ provider: 'routerai', nsfw: true, realPerson: false }), false, 'the explicit setting beats nsfw');
}

/**
 * What a route can take is detected, not asked for: router.ai's Seedance 2.0
 * Pro does not refuse adult content, BytePlus's official API does. The flag
 * that changes how every video looks (words through as written, no Director)
 * stays the owner's own setting and is never turned on from a capability.
 */
function nsfwChecks(): void {
  assert.equal(nsfwCapable({ provider: 'routerai', model: 'dreamina-seedance-2-0-260128' }), true, 'router.ai + Seedance 2.0 takes it');
  assert.equal(nsfwCapable({ provider: 'routerai', model: 'Seedance 2.0 Pro' }), true, 'the label form is recognised too');
  assert.equal(nsfwCapable({ provider: 'routerai', model: 'dreamina-seedance-2.5' }), true, '2.5 on router as well');
  assert.equal(nsfwCapable({ provider: 'routerai', model: 'seedance-1-0-pro' }), false, 'an older model on router is not assumed');
  assert.equal(nsfwCapable({ provider: 'byteplus', model: 'dreamina-seedance-2-0-260128' }), false, 'the official API refuses it');
  assert.equal(nsfwCapable({ provider: 'byteplus', model: 'x', nsfw: true }), true, 'the owner saying so wins');
  // A route that takes adult content takes a face.
  assert.equal(realPersonAllowed({ provider: 'routerai', model: 'dreamina-seedance-2-0-260128' }), true);
}

/** The word guard itself: it keeps the meaning, and it is only words. */
function guardChecks(): void {
  const asked = '真人实拍，真实人物的脸部特写，celebrity lookalike';
  const guarded = sanitizeForVideoProvider(asked);
  assert.doesNotMatch(guarded, /真人|真实人物|celebrity lookalike/, 'the words a filter trips on are gone');
  assert.match(guarded, /实拍写实/);
  assert.match(guarded, /写实人物形象/);
  assert.match(guarded, /cinematic character/);
  // Every replacement is reported, so a run says what it changed.
  const diff = diffSanitize(asked);
  assert.ok(diff.length >= 3, `every hit is reported (got ${diff.length})`);
  for (const hit of diff) assert.ok(hit.from && hit.to, 'a hit names both sides');
  // Text with nothing to guard comes back identical.
  const plain = '夜晚街角，滑板青年，鱼眼镜头';
  assert.equal(sanitizeForVideoProvider(plain), plain);
  assert.deepEqual(diffSanitize(plain), []);
}

function main(): void {
  policyChecks();
  nsfwChecks();
  guardChecks();
  console.log('saga real-person routes smoke: ok');
}

main();
