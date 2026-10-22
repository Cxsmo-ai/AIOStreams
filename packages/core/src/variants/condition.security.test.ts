import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VariantConditionEvaluator } from './condition.js';

test('variant expressions retain supported safe condition behavior', async () => {
  const evaluator = new VariantConditionEvaluator(
    {
      resource: 'stream',
      type: 'movie',
      id: 'tt0111161',
      userAgent: 'AIOStreams/security-test',
      query: { client: 'web' },
      headers: { 'x-test-mode': 'safe' },
    },
    { health: { 'provider-a': true }, regexes: new Map(), regexAllowed: true }
  );

  assert.equal(
    await evaluator.evaluate(
      "resource == 'stream' and type == 'movie' and query('client') == 'web' and header('x-test-mode') == 'safe' and health('provider-a') and sqrt(81) == 9"
    ),
    true
  );
  assert.equal(await evaluator.evaluate("query('missing') == ''"), true);
});
