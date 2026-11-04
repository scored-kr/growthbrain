import { readFile, lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../vendor/skills/', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'sources.json'), 'utf8'));
const expected = new Set(['sources.json']);
for (const file of manifest.files) {
  const path = `${file.repo}/${file.path}`;
  if (!/^[\w./-]+$/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..') || expected.has(path)) throw Error('Invalid/duplicate source path');
  expected.add(path);
  if (!/^[a-f0-9]{40}$/.test(file.ref) || !/^[a-f0-9]{40}$/.test(file.sha)) throw Error('Missing pinned source');
  const stat = await lstat(join(root, path));
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`Not a regular file: ${path}`);
  const bytes = await readFile(join(root, path));
  const digest = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (bytes.length !== file.size || digest !== file.sha) throw Error(`Upstream bytes differ: ${path}`);
}
async function walk(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) await walk(join(directory, entry.name), `${path}/`);
    else if (!entry.isFile() || !expected.delete(path)) throw Error(`Unexpected source: ${path}`);
  }
}
await walk(root);
if (expected.size) throw Error('Missing source files');
for (const skill of manifest.skills) {
  const entry = manifest.files.find(f => f.repo === skill.repo && f.path === `${skill.path}/SKILL.md` && f.ref === skill.ref);
  const license = manifest.files.find(f => f.repo === skill.repo && f.ref === skill.ref && (f.path === 'LICENSE' || f.path === `${skill.path}/LICENSE.txt`));
  if (!entry || !license) throw Error('Missing skill entry or license');
}
console.log(JSON.stringify({ skills: manifest.skills.length, upstreamFiles: manifest.files.length, exactGitBlobs: true }));
