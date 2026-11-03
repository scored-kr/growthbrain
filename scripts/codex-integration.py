#!/usr/bin/env python3
"""Install/upgrade/remove only owned Codex integration files. No keys or hooks."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

# Exact shipped bytes from 8bf573d; arbitrary edits are never treated as an upgrade source.
LEGACY_SKILL_HASHES = {'8cbc5b620a99e5425636598156a059d96155133c37caddd40109db7b6e00df84'}

parser = argparse.ArgumentParser()
parser.add_argument('action', choices=['install', 'upgrade', 'remove'])
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
source_bytes = source.read_bytes()

def run(*command):
    return subprocess.run([args.codex, 'mcp', *command], capture_output=True, text=True)

# Capture configuration only to compare this entry; never dump existing credentials.
existing = run('get', 'growth_brain', '--json')
server = None
if existing.returncode == 0:
    try:
        configuration = json.loads(existing.stdout)
        server = configuration['transport']
        transport_defaults = {'type':'stdio', 'env_vars':[], 'cwd':None}
        expected_transport = {**transport_defaults, 'command':node, 'args':[str(entry)],
                              'env':{'GROWTH_BRAIN_SOCKET':str(args.socket)}}
        defaults = {'name':'growth_brain', 'enabled':True, 'disabled_reason':None,
                    'enabled_tools':None, 'disabled_tools':None,
                    'startup_timeout_sec':None, 'tool_timeout_sec':None}
        actual = {**defaults, **configuration, 'transport':{**transport_defaults, **server}}
        expected = {**defaults, 'transport':expected_transport}
    except (ValueError, KeyError, TypeError):
        sys.exit('Could not safely read the MCP configuration. Nothing changed.')
    # Includes extra env, cwd, tool filters, timeouts and unknown future fields.
    if actual != expected:
        sys.exit('A modified or unrelated growth_brain MCP entry exists. Nothing changed.')
elif 'No MCP server named' not in existing.stderr:
    sys.exit('Could not safely determine the existing MCP configuration. Nothing changed.')

if args.skill_dir.is_symlink() or target.is_symlink():
    sys.exit('Skill destination is a symlink. Nothing changed.')
if (args.skill_dir.exists() and not args.skill_dir.is_dir()) or (target.exists() and not target.is_file()):
    sys.exit('Skill destination is not a regular directory/file. Nothing changed.')
installed_bytes = target.read_bytes() if target.exists() else None
if installed_bytes is not None and installed_bytes != source_bytes:
    if hashlib.sha256(installed_bytes).hexdigest() not in LEGACY_SKILL_HASHES:
        sys.exit('A different or user-edited growth-brain skill exists. Nothing changed.')
    if args.action == 'install':
        sys.exit('A known older skill is installed. Run upgrade with the same options. Nothing changed.')
if args.skill_dir.exists() and set(args.skill_dir.iterdir()) - {target}:
    sys.exit('Skill directory contains unrelated files. Nothing changed.')

if args.action == 'upgrade':
    if server is None or installed_bytes is None:
        sys.exit('Upgrade requires an existing owned MCP entry and skill. Run install first. Nothing changed.')
    if installed_bytes != source_bytes:
        fd, temporary = tempfile.mkstemp(prefix='.growth-brain-upgrade-', dir=args.skill_dir)
        try:
            with os.fdopen(fd, 'wb') as output:
                output.write(source_bytes)
                output.flush()
                os.fsync(output.fileno())
            if target.is_symlink() or target.read_bytes() != installed_bytes:
                sys.exit('Skill changed during upgrade; original file preserved.')
            os.replace(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)
    print('Owned Growth Brain skill upgraded. MCP settings unchanged. Restart Codex to load it; actual invocation remains to be verified.')
elif args.action == 'install':
    if server is None:
        result = run('add', 'growth_brain', '--env', 'GROWTH_BRAIN_SOCKET='+str(args.socket), '--', node, str(entry))
        if result.returncode:
            sys.exit('Codex MCP registration failed; no skill installed.')
    args.skill_dir.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        try:
            with target.open('xb') as output:
                output.write(source_bytes)
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
