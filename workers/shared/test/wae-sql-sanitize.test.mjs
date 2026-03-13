import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeWaeSqlValue } from '../wae-sql-sanitize.mjs';

test('sanitizeWaeSqlValue passes through safe alphanumeric values', () => {
  assert.equal(sanitizeWaeSqlValue('myService'), 'myService');
  assert.equal(sanitizeWaeSqlValue('prod-us-east-1'), 'prod-us-east-1');
  assert.equal(sanitizeWaeSqlValue('web_frontend'), 'web_frontend');
});

test('sanitizeWaeSqlValue allows dots, colons, at-signs, and slashes', () => {
  assert.equal(sanitizeWaeSqlValue('host.example.com'), 'host.example.com');
  assert.equal(sanitizeWaeSqlValue('user@host'), 'user@host');
  assert.equal(sanitizeWaeSqlValue('2024-01-15T10:30:00'), '2024-01-15T10:30:00');
  assert.equal(sanitizeWaeSqlValue('path/to/file'), 'path/to/file');
});

test('sanitizeWaeSqlValue strips single quotes (SQL injection)', () => {
  assert.equal(sanitizeWaeSqlValue("'; DROP TABLE alerts; --"), ' DROP TABLE alerts --');
});

test('sanitizeWaeSqlValue strips parentheses and semicolons', () => {
  assert.equal(sanitizeWaeSqlValue('value; SELECT * FROM users'), 'value SELECT  FROM users');
});

test('sanitizeWaeSqlValue strips backticks and dollar signs', () => {
  assert.equal(sanitizeWaeSqlValue('`admin`'), 'admin');
  assert.equal(sanitizeWaeSqlValue('$variable'), 'variable');
});

test('sanitizeWaeSqlValue returns empty string for all-special input', () => {
  assert.equal(sanitizeWaeSqlValue("'\"();"), '');
});

test('sanitizeWaeSqlValue preserves spaces', () => {
  assert.equal(sanitizeWaeSqlValue('hello world'), 'hello world');
});
