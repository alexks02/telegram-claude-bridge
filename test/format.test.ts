import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainLine, shortenPath, extractAttachments } from '../src/format.js';

test('plainLine strips markdown and collapses newlines', () => {
  const out = plainLine('**bold** and `code`\nsecond line', 200);
  assert.ok(!out.includes('**'), 'asterisks removed');
  assert.ok(!out.includes('`'), 'backticks removed');
  assert.ok(out.includes('bold') && out.includes('second line'));
  assert.ok(!out.includes('\n'), 'newlines collapsed');
});

test('plainLine respects the budget', () => {
  const out = plainLine('x'.repeat(500), 50);
  assert.ok(out.length <= 51, `got ${out.length}`);
});

test('shortenPath keeps the file name and trims the middle', () => {
  const out = shortenPath('/a/b/c/d/e/f/filter-by-activity.spec.ts', 30);
  assert.ok(out.endsWith('filter-by-activity.spec.ts'), out);
  assert.ok(out.length <= 31, `got ${out.length}`);
});

test('extractAttachments pulls SEND lines out of the reply', () => {
  const { text, attachments } = extractAttachments('the answer\nSEND: out/shot.png | grid was empty');
  assert.equal(text.trim(), 'the answer');
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].path, 'out/shot.png');
  assert.equal(attachments[0].caption, 'grid was empty');
});

test('extractAttachments leaves a plain reply untouched', () => {
  const { text, attachments } = extractAttachments('just text, no files');
  assert.equal(text, 'just text, no files');
  assert.equal(attachments.length, 0);
});
