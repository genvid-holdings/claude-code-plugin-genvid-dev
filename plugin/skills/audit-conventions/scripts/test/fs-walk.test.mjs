import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { listFiles, listMarkdown, listUnder } from '../lib/fs-walk.mjs';

async function withTempRepo(setup) {
  const dir = await mkdtemp(join(tmpdir(), 'fs-walk-test-'));
  try {
    await setup(dir);
    return dir;
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

async function writeRepoFile(dir, rel, content) {
  const path = join(dir, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

test('listFiles: enumerates files matching the predicate, recursively, as repo-relative posix paths', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'docs/a.md', 'a\n');
    await writeRepoFile(d, 'docs/sub/b.md', 'b\n');
    await writeRepoFile(d, 'docs/c.txt', 'c\n');
  });
  try {
    const files = await listFiles(dir, 'docs', (name) => name.endsWith('.md'));
    assert.deepEqual(files.sort(), ['docs/a.md', 'docs/sub/b.md'].sort());
    assert.ok(files.every((f) => !f.includes('\\')), 'paths must use forward slashes');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listFiles: missing subdirectory -> []', async () => {
  const dir = await withTempRepo(async () => {});
  try {
    const files = await listFiles(dir, 'nope', () => true);
    assert.deepEqual(files, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listMarkdown: recursively lists *.md files under <repoRoot>/<sub>', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'docs/a.md', 'a\n');
    await writeRepoFile(d, 'docs/nested/deep/b.md', 'b\n');
    await writeRepoFile(d, 'docs/c.json', '{}\n');
  });
  try {
    const files = await listMarkdown(dir, 'docs');
    assert.deepEqual(files.sort(), ['docs/a.md', 'docs/nested/deep/b.md'].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listMarkdown: missing docs/ dir -> []', async () => {
  const dir = await withTempRepo(async () => {});
  try {
    const files = await listMarkdown(dir, 'docs');
    assert.deepEqual(files, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listUnder: a single root matches listFiles for that root', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'docs/a.md', 'a\n');
    await writeRepoFile(d, 'docs/sub/b.md', 'b\n');
    await writeRepoFile(d, 'docs/c.txt', 'c\n');
  });
  try {
    const isMd = (name) => name.endsWith('.md');
    const union = await listUnder(dir, ['docs'], isMd);
    const single = await listFiles(dir, 'docs', isMd);
    assert.deepEqual(union, single.sort());
    assert.deepEqual(union, ['docs/a.md', 'docs/sub/b.md']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listUnder: two disjoint roots -> the sorted union of both, regardless of root order', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'docs/a.md', 'a\n');
    await writeRepoFile(d, 'plugin/skills/s/SKILL.md', 's\n');
    await writeRepoFile(d, 'elsewhere/ignored.md', 'x\n');
  });
  try {
    const files = await listUnder(dir, ['plugin', 'docs'], (name) => name.endsWith('.md'));
    assert.deepEqual(files, ['docs/a.md', 'plugin/skills/s/SKILL.md']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listUnder: overlapping roots yield each file exactly once', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'docs/a.md', 'a\n');
    await writeRepoFile(d, 'docs/decisions/0001-x.md', 'x\n');
  });
  try {
    const files = await listUnder(dir, ['docs', 'docs/decisions'], (name) => name.endsWith('.md'));
    assert.deepEqual(files, ['docs/a.md', 'docs/decisions/0001-x.md']);
    assert.equal(new Set(files).size, files.length, 'union must not repeat a file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listUnder: a non-existent root contributes nothing and does not throw', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'docs/a.md', 'a\n');
  });
  try {
    const files = await listUnder(dir, ['docs', 'nope'], (name) => name.endsWith('.md'));
    assert.deepEqual(files, ['docs/a.md']);
    const onlyMissing = await listUnder(dir, ['nope', 'also-nope'], () => true);
    assert.deepEqual(onlyMissing, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listUnder: the predicate filters across every root', async () => {
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'docs/a.md', 'a\n');
    await writeRepoFile(d, 'docs/a.json', '{}\n');
    await writeRepoFile(d, 'plugin/b.md', 'b\n');
    await writeRepoFile(d, 'plugin/b.txt', 'b\n');
  });
  try {
    const files = await listUnder(dir, ['docs', 'plugin'], (name) => name.endsWith('.md'));
    assert.deepEqual(files, ['docs/a.md', 'plugin/b.md']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listUnder: nested paths are returned repo-relative with forward slashes', async () => {
  const sep = String.fromCharCode(92); // backslash, kept out of the source as a literal
  const dir = await withTempRepo(async (d) => {
    await writeRepoFile(d, 'docs/deep/deeper/deepest/n.md', 'n\n');
  });
  try {
    const files = await listUnder(dir, ['docs'], (name) => name.endsWith('.md'));
    assert.deepEqual(files, ['docs/deep/deeper/deepest/n.md']);
    assert.ok(files.every((f) => !f.includes(sep)), 'paths must use forward slashes');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
