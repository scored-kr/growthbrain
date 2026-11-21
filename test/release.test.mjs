import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {validateExtension} from '../scripts/validate-extension.mjs';
test('release gate accepts the current manifest and rejects privilege expansion, inline code, stale browser code and secret-shaped assets',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gb-release-'));t.after(()=>rm(root,{recursive:true,force:true}));const ext=join(root,'extension');await cp(resolve('extension'),ext,{recursive:true});assert.equal((await validateExtension(ext)).manifestV3,true);
 const manifest=JSON.parse(await readFile(join(ext,'manifest.json'),'utf8'));await writeFile(join(ext,'manifest.json'),JSON.stringify({...manifest,host_permissions:['<all_urls>']}));await assert.rejects(validateExtension(ext),/UNEXPECTED_EXTENSION_ACCESS/);await writeFile(join(ext,'manifest.json'),JSON.stringify(manifest));
 const page=await readFile(join(ext,'app.html'),'utf8');await writeFile(join(ext,'app.html'),page+'<script>alert(1)</script>');await assert.rejects(validateExtension(ext),/NONLOCAL_SCRIPT/);await writeFile(join(ext,'app.html'),page);
 const module=await readFile(join(ext,'account-auth.js'),'utf8');await writeFile(join(ext,'account-auth.js'),module+'\n// stale');await assert.rejects(validateExtension(ext),/STALE_BROWSER_MODULE/);await writeFile(join(ext,'account-auth.js'),module);
 await writeFile(join(ext,'unsafe.js'),'-----BEGIN PRIVATE KEY-----');await assert.rejects(validateExtension(ext),/POSSIBLE_SECRET/);
});

test('user archives omit new internal files and retain product source, build inputs and notices', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gb-release-source-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const repo = join(root, 'repo');
  execFileSync('git', ['clone', '--quiet', '--local', '--no-hardlinks', resolve('.'), repo]);
  const run = (command, ...args) => execFileSync(command, args, {cwd: repo, encoding: 'utf8'});
  await mkdir(join(repo, 'scripts/proposed'), {recursive: true});
  for (const name of ['package-release.py', 'release_files.py', 'build-windows-installer.py',
    'package-account-config.py', 'proposed/account-sync-v1.sql', 'proposed/account-sync-catalog.sha256']) {
    await cp(resolve('scripts', name), join(repo, 'scripts', name));
  }
  await writeFile(join(repo, 'docs/private-revenue-targets.json'), '{"internal":true}');
  await writeFile(join(repo, 'extension/reviewer-example.js'), '// Internal review fixture');
  await writeFile(join(repo, 'vendor/reviewer-example.py'), '# Developer example');
  await mkdir(join(repo, 'dist'), {recursive: true});
  await cp(join(repo, 'extension/account-auth.js'), join(repo, 'dist/account-auth.js'));
  run('git', 'add', 'scripts', 'docs', 'extension', 'vendor');
  run('git', '-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Release fixture');

  const make = dir => JSON.parse(run('python3', 'scripts/package-release.py', join(root, dir)).trim().split('\n').at(-1));
  const release = make('first');
  make('second');
  for (const filename of [...release.files, 'manifest.json']) {
    assert.deepEqual(await readFile(join(root, 'first', filename)), await readFile(join(root, 'second', filename)));
  }
  const [extension, source] = release.files.map(file => join(root, 'first', file));
  const extensionFiles = JSON.parse(run('python3', '-c',
    'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', extension));
  assert.ok(extensionFiles.includes('manifest.json'));
  assert.ok(!extensionFiles.includes('reviewer-example.js'));

  const contents = run('tar', '-tzf', source).trim().split('\n').map(p => p.replace(/^growth-brain\//, ''));
  const files = contents.filter(p => p && !p.endsWith('/'));
  assert.deepEqual(files.filter(p => p.startsWith('extension/')).map(p => p.slice(10)).sort(), extensionFiles.sort());
  assert.deepEqual(files.filter(p => p.startsWith('docs/')).sort(),
    ['docs/local-inference.md', 'docs/web-mcp.md', 'docs/windows-test-guide.md']);
  assert.ok(!files.some(p => /^(vendor|\.agents|\.github|test)\//.test(p)));
  for (const path of ['package-lock.json', 'src/engine.ts', 'scripts/build-browser-modules.mjs',
    'scripts/build-windows-installer.py', 'scripts/release_files.py', 'scripts/package-account-config.py',
    'scripts/proposed/account-sync-v1.sql', 'scripts/proposed/account-sync-catalog.sha256', 'windows/native/com.growthbrain.local.json',
    'windows/setup/app.manifest', 'integrations/codex/growth-brain/SKILL.md', 'integrations/windows-route/NOTICE']) {
    assert.ok(files.includes(path), 'Missing product input: ' + path);
  }
});
