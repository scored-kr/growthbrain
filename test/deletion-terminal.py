"""Deletion failures must lock, report incomplete, and preserve recoverable data."""
import json
import os
import pty
import secrets
import select
import subprocess
import tempfile
import time
from pathlib import Path

with tempfile.TemporaryDirectory(prefix='gb-delete-failure-') as directory:
    master, slave = pty.openpty()
    child = subprocess.Popen(['node', 'dist/cli.js', 'init', directory], stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    password = secrets.token_urlsafe(32)
    pending = ''
    transcript = ''
    def until(marker):
        global pending, transcript
        deadline = time.monotonic() + 10
        while marker not in pending:
            assert time.monotonic() < deadline, 'Missing terminal prompt'
            if select.select([master], [], [], .1)[0]:
                data = os.read(master, 65536).decode(errors='replace')
                pending += data
                transcript += data
        pending = pending.split(marker, 1)[1]
    def send(value):
        os.write(master, (value + '\r').encode())
    try:
        until('Local vault passphrase'); until(': '); send(password)
        until('Confirm passphrase: '); send(password)
        until('Type CONNECT'); until(': '); send('CONNECT')
        until('growth-brain> ')
        primary = Path(directory, 'vault.json')
        original = primary.read_bytes()
        bad = Path(directory, 'pre-state-v4-' + 'f'*24 + '.enc')
        bad.write_text('{invalid'); bad.chmod(0o600)
        send('delete-all'); until('Type DELETE to confirm: '); send('DELETE')
        until('Local deletion incomplete.')
        assert child.wait(timeout=2) == 1
        assert primary.read_bytes() == original and bad.exists()
        assert not Path(directory, 'memory.sock').exists()
        assert not Path(directory, 'vault.lock').exists()
        assert password not in transcript
        assert 'migration backups deleted.' not in transcript
        print(json.dumps({'terminal_delete_failure_locks_and_reports_incomplete': 'passed', 'secret_echo': False}))
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait()
        os.close(master)
