#!/usr/bin/env python3
"""Preserving user-scoped Claude Code MCP/skill registration; no auth or hook trust edits."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

p=argparse.ArgumentParser()
p.add_argument('action',choices=['install','upgrade','remove'])
p.add_argument('--config',type=Path,default=Path.home()/'.claude.json')
p.add_argument('--skill-dir',type=Path,default=Path.home()/'.claude/skills/growth-brain')
p.add_argument('--socket',type=Path,default=Path.home()/'.local/share/growth-brain/memory.sock')
a=p.parse_args();root=Path(__file__).resolve().parents[1];entry=root/'dist/mcp.js';target=a.skill_dir/'SKILL.md'
node=shutil.which('node')
if not node or not entry.is_file():sys.exit('Build Growth Brain first. Nothing changed.')
if any(x.is_symlink() for x in [a.config,a.config.parent,a.skill_dir,target]):sys.exit('Symlink destination refused. Nothing changed.')
source=(root/'integrations/codex/growth-brain/SKILL.md').read_bytes()
original=a.config.read_bytes() if a.config.exists() else None
try:
    data=json.loads(original) if original else {};servers=data.get('mcpServers',{})
    if not isinstance(data,dict) or not isinstance(servers,dict):raise ValueError()
except (ValueError,AttributeError):sys.exit('Unknown MCP configuration. Nothing changed.')
owned={'type':'stdio','command':node,'args':[str(entry)],'env':{'GROWTH_BRAIN_SOCKET':str(a.socket)}}
if 'growth_brain' in servers and servers['growth_brain']!=owned:sys.exit('Modified Growth Brain MCP entry. Nothing changed.')
if target.exists() and not target.is_file():sys.exit('Modified Growth Brain skill. Nothing changed.')
installed=target.read_bytes() if target.exists() else None
if installed is not None and installed!=source:
    if hashlib.sha256(installed).hexdigest()!='fcaeb51c45ff344ae1b9892cac02083b4c104e7c870890e04ec6ae63b523925f':sys.exit('Modified Growth Brain skill. Nothing changed.')
    if a.action=='install':sys.exit('Known older skill; run upgrade. Nothing changed.')
if a.skill_dir.exists() and (not a.skill_dir.is_dir() or set(a.skill_dir.iterdir())-{target}):sys.exit('Unrelated skill files. Nothing changed.')
if a.action=='upgrade':
    if installed is None or servers.get('growth_brain')!=owned:sys.exit('Upgrade requires an owned MCP and skill. Nothing changed.')
    if installed!=source:
        fd,temp=tempfile.mkstemp(prefix='.growth-brain-upgrade-',dir=a.skill_dir)
        try:
            with os.fdopen(fd,'wb') as f:f.write(source);f.flush();os.fsync(f.fileno())
            if target.is_symlink() or target.read_bytes()!=installed:sys.exit('Skill changed. Nothing replaced.')
            os.replace(temp,target)
        finally:Path(temp).unlink(missing_ok=True)
    print('Owned Claude Code skill upgraded; MCP settings preserved. Restart the client.')
    sys.exit(0)
if a.action=='install':servers['growth_brain']=owned;data['mcpServers']=servers
else:
    servers.pop('growth_brain',None)
    if servers:data['mcpServers']=servers
    else:data.pop('mcpServers',None)
encoded=(json.dumps(data,ensure_ascii=False,indent=2)+'\n').encode()
if original!=encoded and (a.action=='install' or original is not None):
    a.config.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd,temp=tempfile.mkstemp(prefix='.growth-brain-mcp-',dir=a.config.parent)
    try:
        with os.fdopen(fd,'wb') as f:f.write(encoded);f.flush();os.fsync(f.fileno())
        if a.config.is_symlink() or (a.config.read_bytes() if a.config.exists() else None)!=original:sys.exit('Configuration changed. Nothing replaced.')
        os.replace(temp,a.config)
    finally:Path(temp).unlink(missing_ok=True)
if a.action=='install':
    a.skill_dir.mkdir(parents=True,exist_ok=True)
    if not target.exists():
        with target.open('xb') as f:f.write(source)
else:
    if target.exists():target.unlink();a.skill_dir.rmdir()
print('Owned Claude Code integration '+('registered' if a.action=='install' else 'removed')+'. Other settings preserved. Restart and verify the client connection; no live model flow was implied.')
