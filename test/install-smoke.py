"""Installer ownership/idempotence checks with a fake CLI; not actual Codex connection evidence."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

with tempfile.TemporaryDirectory(prefix='gb-install-') as directory:
    base=Path(directory); state=base/'state.json'; client=base/'codex'
    state.write_text(json.dumps({'other':{'command':'keep-original'}}))
    client.write_text('''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
p=Path(os.environ['GB_INSTALL_STATE']);s=json.loads(p.read_text());a=sys.argv[2:];name=a[1]
if a[0]=='get':
 if name not in s:print('No MCP server named '+name,file=sys.stderr);sys.exit(1)
 print(json.dumps({'transport':s[name]}))
elif a[0]=='add':
 i=a.index('--');env=a[a.index('--env')+1].split('=',1)
 s[name]={'command':a[i+1],'args':a[i+2:],'env':{env[0]:env[1]}};p.write_text(json.dumps(s))
elif a[0]=='remove':s.pop(name,None);p.write_text(json.dumps(s))
''')
    client.chmod(0o700)
    env={**os.environ,'GB_INSTALL_STATE':str(state)}
    skill=base/'skills/growth-brain'
    def run(action):
        return subprocess.run(['python','scripts/codex-integration.py',action,'--codex',str(client),'--skill-dir',str(skill)],env=env,capture_output=True,text=True)
    assert run('install').returncode==0
    assert run('install').returncode==0
    assert json.loads(state.read_text())['other']=={'command':'keep-original'}
    (skill/'SKILL.md').write_text('User edited skill')
    assert run('remove').returncode!=0
    assert 'growth_brain' in json.loads(state.read_text())
    (skill/'SKILL.md').write_bytes(Path('integrations/codex/growth-brain/SKILL.md').read_bytes())
    assert run('remove').returncode==0
    assert json.loads(state.read_text())=={'other':{'command':'keep-original'}}
    assert run('remove').returncode==0
    print('Installer merge, idempotence, modified-file refusal, and owned removal passed (fake CLI).')
