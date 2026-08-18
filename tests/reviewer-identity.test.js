import assert from 'node:assert/strict';
import test from 'node:test';

import { REVIEWER_IDS, REVIEWER_PROVIDERS } from '../hooks/scripts/lib/reviewer-ids.mjs';

test('`grok` is a canonical reviewer id bound to the `grok` provider, appended last', () => {
  assert.equal(REVIEWER_IDS.at(-1), 'grok');
  assert.equal(REVIEWER_PROVIDERS.grok, 'grok');
  assert.deepEqual(REVIEWER_IDS.slice(0, 4), [
    'claude-opus',
    'codex-review',
    'codex-adversarial',
    'agy',
  ]);
  assert.deepEqual(
    ['claude-opus', 'codex-review', 'codex-adversarial', 'agy'].map((reviewerId) => (
      REVIEWER_IDS.indexOf(reviewerId)
    )),
    [0, 1, 2, 3],
  );
});
