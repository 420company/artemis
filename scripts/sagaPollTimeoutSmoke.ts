import assert from 'node:assert/strict';
import { isPollTimeoutErrorForTest } from '../src/tools/generateLongVideo.js';

assert.equal(
  isPollTimeoutErrorForTest('generate_video: configured visual API failed: Custom video cgt-20260519055439-6gjvs did not complete within 90 polls. Last status: processing.'),
  true,
  'custom provider processing timeout must be recoverable',
);

assert.equal(
  isPollTimeoutErrorForTest('Custom video abc did not finish within 420 polls. Last status: running.'),
  true,
  'finish/running timeout must be recoverable',
);

assert.equal(
  isPollTimeoutErrorForTest('task failed: content policy violation'),
  false,
  'non-timeout failures must not be retried as queue timeouts',
);

console.log('saga poll timeout classifier smoke ok');
