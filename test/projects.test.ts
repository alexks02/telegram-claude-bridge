import { test } from 'node:test';
import assert from 'node:assert/strict';

// projects.ts scans WORKSPACE_ROOT at import and exits if it holds no git repos,
// so point it at a throwaway workspace with one dummy repo before importing.
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ws = mkdtempSync(join(tmpdir(), 'bridge-test-'));
mkdirSync(join(ws, 'dummy', '.git'), { recursive: true });
process.env.WORKSPACE_ROOT = ws;
process.env.ALIASES = 'web:web-frontend,api:backend';

const { parseAliases, resolveProject } = await import('../src/projects.js');

const projects = [
  { name: 'backend', path: '/p/backend' },
  { name: 'web-frontend', path: '/p/web-frontend' },
  { name: 'admin-dashboard', path: '/p/admin-dashboard' },
];

test('parseAliases reads alias:directory pairs from ALIASES', () => {
  const a = parseAliases();
  assert.equal(a.web, 'web-frontend');
  assert.equal(a.api, 'backend');
});

test('resolveProject matches an exact name', () => {
  const r = resolveProject('backend', projects);
  assert.ok(r.ok && r.project.name === 'backend');
});

test('resolveProject matches an unambiguous substring', () => {
  const r = resolveProject('front', projects);
  assert.ok(r.ok && r.project.name === 'web-frontend');
});

test('resolveProject reports an ambiguous substring instead of guessing', () => {
  const r = resolveProject('a', projects); // backend, admin-dashboard, web-frontend all contain "a"
  assert.ok(!r.ok && r.reason === 'ambiguous');
});

test('resolveProject resolves an alias to its target', () => {
  const r = resolveProject('web', projects);
  assert.ok(r.ok && r.project.name === 'web-frontend');
});
