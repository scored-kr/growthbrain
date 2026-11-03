#!/usr/bin/env python3
"""Merge/remove only this product's Codex MCP and skill. No keys or hooks are installed."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('action', choices=['install', 'remove'])
parser.add_argument('--skill-dir', type=Path, default=Path.home()/'.agents/skills/growth-brain')
parser.add_argument('--socket', type=Path, default=Path.home()/'.local/share/growth-brain/memory.sock')
parser.add_argument('--codex', default='codex')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
source = root/'integrations/codex/growth-brain/SKILL.md'
target = args.skill_dir/'SKILL.md'
entry = root/'dist/mcp.js'
node = shutil.which('node')
if not node or not entry.is_file():
    sys.exit('Run npm ci and npm run build first.')

def run(*command):
    return subprocess.run([args.codex, 'mcp', *command], capture_output=True, text=True)

# Capture configuration only to compare this entry; never dump existing credentials.
existing = run('get', 'growth_brain', '--json')
server = None
if existing.returncode == 0:
    server = json.loads(existing.stdout).get('transport', {})
    if (server.get('command') != node or server.get('args') != [str(entry)] or
        server.get('env', {}).get('GROWTH_BRAIN_SOCKET') != str(args.socket)):
        sys.exit('An unrelated growth_brain MCP entry exists. Nothing changed.')
elif 'No MCP server named' not in existing.stderr:
    sys.exit('Could not safely determine the existing MCP configuration. Nothing changed.')

if args.skill_dir.is_symlink() or target.is_symlink():
    sys.exit('Skill destination is a symlink. Nothing changed.')
if target.exists() and target.read_bytes() != source.read_bytes():
    sys.exit('A different growth-brain skill exists. Nothing changed.')
if args.skill_dir.exists() and set(args.skill_dir.iterdir()) - {target}:
    sys.exit('Skill directory contains unrelated files. Nothing changed.')

if args.action == 'install':
    if server is None:
        result = run('add', 'growth_brain', '--env', 'GROWTH_BRAIN_SOCKET='+str(args.socket), '--', node, str(entry))
        if result.returncode:
            sys.exit('Codex MCP registration failed; no skill installed.')
    args.skill_dir.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        try:
            with target.open('xb') as output:
                output.write(source.read_bytes())
        except FileExistsError:
            sys.exit('Skill destination changed during installation; inspect before retrying.')
    print('Growth Brain MCP and skill registered. Restart Codex if needed; unlock the local vault yourself. Actual invocation remains to be verified.')
else:
    if server is not None and run('remove', 'growth_brain').returncode:
        sys.exit('Could not remove the owned MCP entry; skill preserved.')
    if target.exists():
        target.unlink()
        args.skill_dir.rmdir()
    print('Owned Growth Brain MCP and skill removed. Vault, other MCP servers and other skills preserved.')
