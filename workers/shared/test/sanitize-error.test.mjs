import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeErrorMessage } from '../sanitize-error.mjs';

test('sanitizeErrorMessage passes through Forbidden errors', () => {
  assert.equal(sanitizeErrorMessage(new Error('Forbidden')), 'Forbidden');
});

test('sanitizeErrorMessage passes through validation errors', () => {
  assert.equal(sanitizeErrorMessage(new Error('Invalid token')), 'Invalid token');
  assert.equal(sanitizeErrorMessage(new Error('Not found')), 'Not found');
  assert.equal(sanitizeErrorMessage(new Error('name is required')), 'name is required');
  assert.equal(sanitizeErrorMessage(new Error('email is required')), 'email is required');
  assert.equal(sanitizeErrorMessage(new Error('password must be at least 10 characters')), 'password must be at least 10 characters');
  assert.equal(sanitizeErrorMessage(new Error('Rate limit exceeded')), 'Rate limit exceeded');
});

test('sanitizeErrorMessage passes through query guardrail errors', () => {
  assert.equal(
    sanitizeErrorMessage(new Error('search requires a service filter for phrase queries')),
    'search requires a service filter for phrase queries'
  );
  assert.equal(
    sanitizeErrorMessage(new Error('search limited to 14 days for token queries')),
    'search limited to 14 days for token queries'
  );
});

test('sanitizeErrorMessage sanitizes internal errors', () => {
  assert.equal(
    sanitizeErrorMessage(new Error('D1_ERROR: SQLITE_CONSTRAINT: UNIQUE constraint failed')),
    'Internal server error'
  );
  assert.equal(
    sanitizeErrorMessage(new Error('TypeError: Cannot read properties of undefined')),
    'Internal server error'
  );
  assert.equal(
    sanitizeErrorMessage(new Error('R2 bucket operation failed: network timeout')),
    'Internal server error'
  );
});

test('sanitizeErrorMessage handles string input', () => {
  assert.equal(sanitizeErrorMessage('some internal trace'), 'Internal server error');
});

test('sanitizeErrorMessage passes through Too many errors', () => {
  assert.equal(sanitizeErrorMessage(new Error('Too many requests')), 'Too many requests');
});

test('sanitizeErrorMessage passes through Maximum limit errors', () => {
  assert.equal(sanitizeErrorMessage(new Error('Maximum 50 lookup tables allowed')), 'Maximum 50 lookup tables allowed');
});

test('sanitizeErrorMessage passes through Unsupported errors', () => {
  assert.equal(sanitizeErrorMessage(new Error('Unsupported query type')), 'Unsupported query type');
});

test('sanitizeErrorMessage passes through Missing errors', () => {
  assert.equal(sanitizeErrorMessage(new Error('Missing required field')), 'Missing required field');
});

test('sanitizeErrorMessage passes through Cannot errors', () => {
  assert.equal(sanitizeErrorMessage(new Error('Cannot delete default dashboard')), 'Cannot delete default dashboard');
});

test('sanitizeErrorMessage passes through ppl errors', () => {
  assert.equal(sanitizeErrorMessage(new Error('ppl parse error: unexpected token')), 'ppl parse error: unexpected token');
});

test('sanitizeErrorMessage passes through scope errors', () => {
  assert.equal(sanitizeErrorMessage(new Error('index "foo" outside role scope')), 'index "foo" outside role scope');
});
