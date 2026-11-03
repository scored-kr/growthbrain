#!/usr/bin/env python3
"""Merge only Growth Brain lifecycle hooks; never changes client trust or approval policy."""
import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import sys
import tempfile

parser=argparse.ArgumentParser()
parser.add_argument('action',choices=['install','remove'])
parser.add_argument('--client',choices=['codex','claude-code'],required=True)
parser.add_argument('--config',type=Path)
parser.add_argument('--socket',type=Path,default=Path.home()/'.local/share/growth-brain/memory.sock')
args=parser.parse_args()
path=args.config or Path.home()/('.codex/hooks.json' if args.client=='codex' else '.claude/settings.json')
entry=Path(__file__).resolve().parents[1]/'dist/agent-hook-cli.js'
node=shutil.which('node')
if not node or not entry.is_file():sys.exit('Run npm ci and npm run build first. Nothing changed.')
if path.is_symlink() or path.parent.is_symlink():sys.exit('Symlinked configuration refused. Nothing changed.')
original=path.read_bytes() if path.exists() else None
try:
    data=json.loads(original) if original else {}
    if not isinstance(data,dict) or not isinstance(data.get('hooks',{}),dict):raise ValueError()
except (ValueError,TypeError):sys.exit('Invalid hook configuration. Nothing changed.')
command=shlex.join([node,str(entry),args.client,'--socket',str(args.socket)])
handler={'type':'command','command':command,'timeout':8}
# No matcher: UserPromptSubmit and Stop have different matching rules across clients.
owned={'hooks':[handler]}
hooks=data.setdefault('hooks',{})
for event in ['SessionStart','UserPromptSubmit','Stop']:
    groups=hooks.get(event,[])
    if not isinstance(groups,list):sys.exit('Unknown hook configuration. Nothing changed.')
    # Refuse an edited installation instead of duplicating or replacing it.
    for group in groups:
        if not isinstance(group,dict) or not isinstance(group.get('hooks'),list):sys.exit('Unknown hook group. Nothing changed.')
        for h in group['hooks']:
            if isinstance(h,dict) and 'agent-hook-cli.js' in h.get('command','') and group!=owned:
                sys.exit('A modified Growth Brain hook exists. Nothing changed.')
    if args.action=='install':
        if owned not in groups:hooks[event]=[*groups,owned]
    else:
        kept=[g for g in groups if g!=owned]
        if kept:hooks[event]=kept
        else:hooks.pop(event,None)
if not hooks:data.pop('hooks',None)
if args.action=='remove' and original is None:
    print('No owned hooks to remove.');sys.exit(0)
encoded=(json.dumps(data,ensure_ascii=False,indent=2)+'\n').encode()
if original!=encoded:
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd,temporary=tempfile.mkstemp(prefix='.growth-brain-hooks-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as out:out.write(encoded);out.flush();os.fsync(out.fileno())
        if path.is_symlink() or (path.read_bytes() if path.exists() else None)!=original:sys.exit('Configuration changed concurrently. Nothing replaced.')
        os.replace(temporary,path)
    finally:Path(temporary).unlink(missing_ok=True)
print('Owned hooks '+('registered' if args.action=='install' else 'removed')+'. Other settings preserved. No hook trust or approvals changed.')
if args.action=='install':
    print('Use the local vault terminal agent-bind to consent for an exact workspace. Restart the client and review hooks in its supported UI. Registration alone is not execution evidence.')
