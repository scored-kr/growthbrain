#!/usr/bin/env python3
"""Merge an owned development MCP block; never read a key or alter other settings."""
import argparse
import os
from pathlib import Path
import sys
import tempfile
import tomllib

BEGIN = '# BEGIN Growth Brain development ign8t v1\n'
END = '# END Growth Brain development ign8t v1\n'
BLOCK = (BEGIN + '[mcp_servers.ign8t]\ncommand = "npx"\n'
         'args = ["-y", "@ign8t/mcp@latest"]\n'
         'env_vars = ["IGN8T_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"]\n'
         '[mcp_servers.ign8t.env]\nNODE_USE_ENV_PROXY = "1"\n' + END)

def update(path, action):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError('Configuration is not a regular file; nothing changed.')
    original = path.read_bytes() if path.exists() else None
    text = original.decode('utf8') if original is not None else ''
    config = tomllib.loads(text)
    owned = BLOCK in text and text.count(BEGIN) == 1 and text.count(END) == 1
    server = config.get('mcp_servers', {}).get('ign8t')
    expected = tomllib.loads(BLOCK)['mcp_servers']['ign8t']
    if (server is not None or BEGIN in text or END in text) and (not owned or server != expected):
        raise ValueError('Existing ign8t configuration is unowned or modified; nothing changed.')
    if action == 'install':
        if owned:
            return
        changed = text + ('\n' if text and not text.endswith('\n') else '') + BLOCK
    else:
        if not owned:
            return
        changed = text.replace(BLOCK, '', 1)
    tomllib.loads(changed)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.ign8t-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(changed.encode('utf8'))
            output.flush()
            os.fsync(output.fileno())
        if path.is_symlink() or (path.read_bytes() if path.exists() else None) != original:
            raise ValueError('Configuration changed during operation; nothing changed.')
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['install', 'remove'])
    parser.add_argument('--config', type=Path, default=Path(os.environ.get('CODEX_HOME', str(Path.home()/'.codex')))/'config.toml')
    args = parser.parse_args()
    try:
        update(args.config, args.action)
    except (ValueError, OSError, UnicodeError):
        sys.exit('Could not safely merge ign8t configuration. Existing files preserved; inspect locally.')
    print('Owned ign8t configuration processed. This does not verify a connection. Bind IGN8T_API_KEY in the client environment, restart the client, and run npm run doctor:ign8t.')
