"""Write the licenses of modules linked into the Windows route build."""
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
template = '{{if and .Module (not .Module.Main)}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Dir}}{{end}}'
for line in go('list', '-mod=readonly', '-tags=ts_omit_logtail', '-deps', '-f', template, '.').splitlines():
    name, version, folder = line.split('|')
    records[name + ' ' + version] = Path(folder)
records['Go standard library (' + go('env','GOVERSION') + ')'] = Path(go('env', 'GOROOT'))

def is_notice(file):
    return file.is_file() and file.name.upper().split('.')[0] in {'LICENCE', 'LICENSE', 'COPYING', 'NOTICE', 'COPYRIGHT'}

sections = []
for name, folder in sorted(records.items()):
    paths = sorted(p for p in folder.iterdir() if is_notice(p))
    if not paths:
        raise SystemExit('No license file found for ' + name)
    for path in paths:
        sections += [name + ' — ' + path.name, path.read_text(encoding='utf-8').strip()]
Path(sys.argv[1]).write_text('\n\n'.join(sections) + '\n', encoding='utf-8')
