"""Real PTY lock must finish despite a client holding a partial local request."""
import json
import os
import pty
import secrets
import select
import socket
import subprocess
import tempfile
import time
from pathlib import Path

with tempfile.TemporaryDirectory(prefix='gb-lock-') as directory:
    master, slave = pty.openpty()
    child = subprocess.Popen(['node', 'dist/cli.js', 'init', directory], stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    password = secrets.token_urlsafe(32)
    pending = ''
    transcript = ''
    peer = socket.socket(socket.AF_UNIX)
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
        peer.connect(str(Path(directory, 'memory.sock')))
        peer.sendall(b'{"method":"get_context","params":{}}')
        send('lock')
        assert child.wait(timeout=2) == 0, 'Lock did not exit successfully'
        peer.settimeout(1)
        try:
            assert peer.recv(4096) == b'', 'A closing peer received context'
        except ConnectionResetError:
            pass  # An unread partial frame may be reset instead of receiving EOF.
        assert not Path(directory, 'memory.sock').exists()
        assert not Path(directory, 'vault.lock').exists()
        assert Path(directory, 'vault.json').exists()
        assert password not in transcript
        print(json.dumps({'terminal_lock_with_partial_request': 'passed', 'secret_echo': False}))
    finally:
        peer.close()
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait()
        os.close(master)
