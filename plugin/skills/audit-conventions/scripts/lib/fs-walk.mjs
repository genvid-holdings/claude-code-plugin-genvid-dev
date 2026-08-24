// Shared file-walking helpers used by migrate.mjs and hygiene checks.

import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';

export async function listFiles(repoRoot, sub, predicate) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && predicate(entry.name)) {
        out.push(relative(repoRoot, full).split('\\').join('/'));
      }
    }
  }
  await walk(join(repoRoot, sub));
  return out;
}

// Recursively list *.md files under <repoRoot>/<sub>, returned repo-relative.
export async function listMarkdown(repoRoot, sub) {
  return listFiles(repoRoot, sub, (name) => name.endsWith('.md'));
}

// Recursively list files matching `predicate` under each of <repoRoot>/<sub> for
// every sub in `subs`, returning the de-duplicated union as sorted repo-relative
// posix paths. Overlapping roots yield each file once; a root that does not exist
// contributes nothing rather than throwing.
export async function listUnder(repoRoot, subs, predicate) {
  const seen = new Set();
  for (const sub of subs) {
    for (const file of await listFiles(repoRoot, sub, predicate)) {
      seen.add(file);
    }
  }
  return [...seen].sort();
}
