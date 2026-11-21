"""Collect module and package notices for the Windows route build."""
import os
from pathlib import Path
import subprocess
import sys

def go(*args):
    return subprocess.check_output(
        ['go', *args], cwd=Path(__file__).resolve().parent,
        env={**os.environ, 'GOOS': 'windows', 'GOARCH': 'amd64', 'CGO_ENABLED': '0'},
        text=True
    ).strip()

records = {}
template = '{{if and .Module (not .Module.Main)}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Dir}}|{{.Dir}}{{end}}'
for line in go('list', '-mod=readonly', '-tags=ts_omit_logtail', '-deps', '-f', template, '.').splitlines():
    name, version, module_dir, package_dir = line.split('|')
    root = Path(module_dir)
    relative = Path(package_dir).relative_to(root)
    # A package can inherit a separate notice anywhere below the module root.
    directories = records.setdefault((name + ' ' + version, root), set())
    directories.update((relative, *relative.parents))
goroot = Path(go('env', 'GOROOT'))
records[('Go standard library (' + go('env', 'GOVERSION') + ')', goroot)] = {Path('.')}

def is_notice(file):
    return file.is_file() and file.name.upper().split('.')[0] in {'LICENCE', 'LICENSE', 'COPYING', 'NOTICE', 'COPYRIGHT'}

sections = []
for (name, root), directories in sorted(records.items()):
    if not any(is_notice(p) for p in root.iterdir()):
        raise SystemExit('No license file found for ' + name)
    for directory in sorted(directories):
        for path in sorted(p for p in (root / directory).iterdir() if is_notice(p)):
            sections += [name + ' — ' + path.relative_to(root).as_posix(), path.read_text(encoding='utf-8').strip()]
Path(sys.argv[1]).write_text('\n\n'.join(sections) + '\n', encoding='utf-8')
