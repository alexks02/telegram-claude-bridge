import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyDirFor } from '../src/sessions.js';

test('historyDirFor turns a project path into the CLI slug', () => {
  const dir = historyDirFor('/Users/you/code/my-app');
  assert.ok(dir.endsWith('-Users-you-code-my-app'), dir);
});

test('historyDirFor replaces every non-word char with a dash', () => {
  const dir = historyDirFor('/a.b/c-d');
  assert.ok(dir.endsWith('-a-b-c-d'), dir);
});
