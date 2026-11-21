"""Reproducible local artifacts from a clean, committed tree. Does not publish."""
import gzip, hashlib, json, subprocess, sys, zipfile
from pathlib import Path
from release_files import EXTENSION_FILES

# Only reviewed product inputs enter the source distribution. In particular,
# adding a document or executable reference to the repository does not publish it.
SOURCE_PATHS = (
    "package.json", "package-lock.json", "tsconfig.json",
    ":(glob)src/*.ts",
    "docs/windows-test-guide.md", "docs/web-mcp.md", "docs/local-inference.md",
    "scripts/build-browser-modules.mjs", "scripts/build-windows-installer.py", "scripts/package-account-config.py",
    "scripts/proposed/account-sync-v1.sql", "scripts/proposed/account-sync-catalog.sha256",
    "scripts/release_files.py", "scripts/agent-hooks.py",
    "scripts/native-integration.py", "scripts/codex-integration.py", "scripts/claude-integration.py",
    "integrations/codex/growth-brain/SKILL.md",
    "integrations/windows-route/NOTICE", "integrations/windows-route/notices.py",
    "integrations/windows-route/go.mod", "integrations/windows-route/go.sum",
    ":(glob)integrations/windows-route/*.go",
    ":(glob)windows/desktop/*.go", ":(glob)windows/files/*.go",
    ":(glob)windows/native/*.go", ":(glob)windows/setup/*.go",
    "windows/files/go.mod", "windows/files/go.sum",
    "windows/native/go.mod", "windows/native/go.sum",
    "windows/native/com.growthbrain.local.json", "windows/native/extension-public-key.txt",
    "windows/setup/app.manifest", "windows/setup/go.mod",
)

def git(*args): return subprocess.check_output(['git',*args])
if len(sys.argv)!=2: raise SystemExit('Usage: python3 scripts/package-release.py <new-output-directory>')
if git('status','--porcelain').strip(): raise SystemExit('Release packaging requires a clean committed worktree')
subprocess.run(['node','scripts/validate-extension.mjs'],check=True)
sha=git('rev-parse','HEAD').decode().strip()
output=Path(sys.argv[1]).resolve();output.mkdir(mode=0o700,parents=True,exist_ok=False)
names = ['extension/' + name for name in EXTENSION_FILES]
archive=output/f'growth-brain-extension-{sha[:12]}.zip'
with zipfile.ZipFile(archive,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for name in names:
        info=zipfile.ZipInfo(name.removeprefix('extension/'),date_time=(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16
        z.writestr(info,git('show',f'{sha}:{name}'))
source=output/f'growth-brain-source-{sha[:12]}.tar.gz'
raw = git('archive', '--format=tar', '--prefix=growth-brain/', sha, '--', *SOURCE_PATHS, *names)
with source.open('xb') as target:
    with gzip.GzipFile(filename='',mode='wb',fileobj=target,mtime=0) as compressor: compressor.write(raw)
files=[{'name':p.name,'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in [archive,source]]
manifest={'commit':sha,'artifacts':files,'published':False,'productionDeployed':False,'installedExtensionOrLivePersonalizationVerified':False}
(output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'commit':sha,'files':[x['name'] for x in files],'output':str(output),'published':False}))
