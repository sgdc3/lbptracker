import { strict as assert } from 'node:assert';
import test from 'node:test';

test('panGainsInto matches panGains', async () => {
  const { panGains, panGainsInto } = await import('../src/voice.ts');
  const out = { left: 0, right: 0 };
  for (const p of [-1, 0, 0.25, 0.5, 0.75, 1, 2]) {
    const a = panGains(p);
    const b = panGainsInto(p, out);
    assert.equal(a.left, b.left);
    assert.equal(a.right, b.right);
  }
});
