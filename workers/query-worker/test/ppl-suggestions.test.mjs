import test from 'node:test';
import assert from 'node:assert/strict';

import { getPplSuggestions } from '../src/ppl-suggestions.mjs';

test('getPplSuggestions completes command prefixes', () => {
  const result = getPplSuggestions({ query: 'se' });
  assert.ok(result.suggestions.length > 0);
  assert.equal(result.suggestions[0].label, 'search');
  assert.equal(result.suggestions[0].kind, 'command');
  assert.equal(result.suggestions[0].next_query, 'search ');
});

test('getPplSuggestions suggests templates after a pipe', () => {
  const result = getPplSuggestions({ query: 'search timeout | ' });
  const labels = result.suggestions.map((item) => item.label);
  assert.ok(labels.includes('where'));
  assert.ok(labels.includes('stats'));
  assert.ok(labels.includes('timechart'));
});

test('getPplSuggestions suggests fields in where clause', () => {
  const result = getPplSuggestions({ query: 'search timeout | where ser' });
  const fieldSuggestion = result.suggestions.find((item) => item.label === 'service');
  assert.ok(fieldSuggestion);
  assert.equal(fieldSuggestion.kind, 'field');
  assert.match(fieldSuggestion.next_query, /\|\s*where\s+service=/);
});

test('getPplSuggestions boosts context terms in search stage', () => {
  const result = getPplSuggestions({
    query: 'search ',
    context: {
      topTerms: ['timeout']
    }
  });
  const top = result.suggestions[0];
  assert.equal(top.kind, 'term');
  assert.match(top.next_query, /^search timeout\b/);
});

test('getPplSuggestions respects maxItems', () => {
  const result = getPplSuggestions({
    query: 'search timeout | ',
    maxItems: 3
  });
  assert.equal(result.suggestions.length, 3);
});

