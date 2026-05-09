import { buildDreamBridgeText } from '../src/services/dreamComposer.js';
import { notifyDreamFinished } from '../src/services/dreamNotifications.js';
import type { DreamEntry } from '../src/services/dreamStore.js';

const entry: DreamEntry = {
  id: 'dream-locale-smoke',
  createdAt: '2026-05-09T00:00:00.000Z',
  mdPath: '/tmp/artemis-dream.md',
  imagePath: '/tmp/artemis-dream.png',
  trigger: 'manual',
  preview: 'A silver key crossed a quiet bridge.',
};

const englishDream = [
  '# Silver Bridge',
  '',
  'A silver key crossed a quiet bridge while the workspace breathed under soft moonlight.',
  '',
  '### What I learned',
  '- Keep the image restrained and coherent.',
].join('\n');

const bridgeText = buildDreamBridgeText(englishDream, entry, 'en');
for (const expected of ['My journal: ', 'Dream image: ']) {
  if (!bridgeText.includes(expected)) {
    throw new Error(`Expected English bridge label ${expected} in: ${bridgeText}`);
  }
}
for (const expected of ['artemis-dream.md', 'artemis-dream.png']) {
  if (!bridgeText.includes(expected)) {
    throw new Error(`Expected local dream link label ${expected} in: ${bridgeText}`);
  }
}
for (const forbidden of ['/tmp/artemis-dream.md', '/tmp/artemis-dream.png', 'artemis-dream.md/tmp/']) {
  if (bridgeText.includes(forbidden)) {
    throw new Error(`Dream bridge text leaked or dirtied a local path ${forbidden}: ${bridgeText}`);
  }
}
for (const forbidden of ['我的日记', '梦境画面', '：']) {
  if (bridgeText.includes(forbidden)) {
    throw new Error(`English bridge text leaked Chinese marker ${forbidden}: ${bridgeText}`);
  }
}

const originalRandom = Math.random;
Math.random = () => 0;
try {
  await notifyDreamFinished({ ok: true, entry, bridgesPushed: 0 }, 'en');
  await notifyDreamFinished({ ok: false, reason: 'no provider configured' }, 'en');
} finally {
  Math.random = originalRandom;
}

console.log('dream locale smoke ok');
