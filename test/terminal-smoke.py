"""Actual local terminal flow, using synthetic data and an unlogged random passphrase."""
import errno
import json
import os
from pathlib import Path
import pty
import re
import secrets
import select
import subprocess
import tempfile
import time

with tempfile.TemporaryDirectory(prefix='gb-terminal-') as directory:
    password = secrets.token_urlsafe(32)
    master, slave = pty.openpty()
    child = subprocess.Popen(['node', 'dist/cli.js', 'init', directory], stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    transcript = ''
    pending = ''
    def until(marker):
        global transcript, pending
        deadline = time.monotonic()+10
        while marker not in pending:
            if time.monotonic() > deadline:
                raise AssertionError('Terminal did not reach expected prompt: '+marker)
            readable, _, _ = select.select([master], [], [], .2)
            if readable:
                data = os.read(master,65536).decode('utf-8',errors='replace')
                pending += data
                transcript += data
        index = pending.index(marker)+len(marker)
        result, pending = pending[:index], pending[index:]
        return result
    def send(text): os.write(master,(text+'\r').encode())
    try:
        until('Local vault passphrase'); until(': '); send(password)
        until('Confirm passphrase: ');send(password)
        until('Type CONNECT');until(': ');send('CONNECT')
        until('growth-brain> ');send('project')
        until('Project name: ');send('Terminal synthetic project')
        result=until('growth-brain> ')
        project=re.search(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}",result).group()
        send('propose');until('preference: ');send(project)
        until('tone): ');send('tone')
        until('Value: ');send('TERMINAL_SYNTHETIC_MEMORY')
        until('or Enter: ');send('')
        result=until('growth-brain> ')
        candidate=re.search(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}",result).group()
        send('correct');until('Selected project UUID: ');send(project)
        until('Candidate UUID: ');send(candidate)
        until('Corrected value (remains pending): ');send('TERMINAL_CORRECTED_MEMORY')
        until('Correction reason: ');send('Human clarification')
        until('Enter cancels: ');send('SAVE')
        result=until('growth-brain> ')
        candidate=re.search(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}",result).group()
        send('review');until('Candidate UUID: ');send(candidate)
        until('Enter cancels: ');send('APPROVE')
        result=until('growth-brain> ');assert "active" in result
        send('retire');until('Selected project UUID: ');send(project)
        until('Active memory UUID: ');send(candidate)
        until('Retirement reason: ');send('No longer applicable')
        until('stop using this memory: ');send('RETIRE')
        result=until('growth-brain> ');assert 'retired' in result
        assert 'TERMINAL_SYNTHETIC_MEMORY' not in Path(directory,'vault.json').read_text()
        send('delete-all');until('Type DELETE to confirm: ');send('DELETE')
        assert child.wait(timeout=10)==0
        assert not Path(directory,'vault.json').exists()
        assert password not in transcript, 'Passphrase appeared in terminal output'
        print(json.dumps({'terminal_init_unlock_consent_propose_correct_review_retire_delete': 'passed', 'secret_echo': False}))
    finally:
        if child.poll() is None:
            child.terminate();child.wait(timeout=10)
        os.close(master)
