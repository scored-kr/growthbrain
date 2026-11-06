"""Real PTY recovery lifecycle; synthetic credentials are kept out of test output."""
import json, os, pty, secrets, select, subprocess, tempfile, time
from pathlib import Path

class Terminal:
    def __init__(self, *args):
        self.master, slave = pty.openpty()
        self.child = subprocess.Popen(['node', 'dist/cli.js', *map(str,args)], stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        self.pending = self.transcript = ''
    def until(self, marker):
        deadline = time.monotonic()+12
        while marker not in self.pending:
            if time.monotonic()>deadline: raise AssertionError('Expected terminal prompt did not arrive: '+marker)
            ready,_,_=select.select([self.master],[],[],.1)
            if ready:
                try: text=os.read(self.master,65536).decode('utf8',errors='replace')
                except OSError: raise AssertionError('Terminal ended before expected prompt') from None
                self.pending+=text;self.transcript+=text
        index=self.pending.index(marker)+len(marker)
        result,self.pending=self.pending[:index],self.pending[index:]
        return result
    def send(self,text): os.write(self.master,(text+'\r').encode())
    def password(self,value,confirm=False):
        self.until('never send this to an AI): ');self.send(value)
        if confirm: self.until('Confirm passphrase: ');self.send(value)
    def connect(self): self.until('or press Enter to close: ');self.send('CONNECT');self.until('growth-brain> ')
    def finish(self):
        assert self.child.wait(timeout=12)==0
        os.close(self.master)
    def cleanup(self):
        if self.child.poll() is None: self.child.terminate();self.child.wait(timeout=10)

with tempfile.TemporaryDirectory(prefix='gb-recovery-terminal-') as temp:
    root=Path(temp);vault=root/'vault';recovered=root/'recovered';key_file=root/'offline'/'vault.recovery';backup=root/'backup.enc'
    password,new_password=secrets.token_urlsafe(32),secrets.token_urlsafe(32)
    terminals=[]
    def start(*args):
        terminal=Terminal(*args);terminals.append(terminal);return terminal
    try:
        t=start('init',vault);t.password(password,True);t.connect()
        t.send('project');t.until('Project name: ');t.send('PTY_RECOVERY_PROJECT');t.until('growth-brain> ')
        t.send('lock');t.finish()
        t=start('recovery',vault);t.password(password)
        t.until('Enter cancels: ');t.send('ISSUE')
        t.until('separate private directory: ');t.send(str(key_file))
        t.until('Export a NEW encrypted backup now');t.finish()
        assert not (vault/'memory.sock').exists()
        t=start('serve',vault);t.password(password);t.connect()
        t.send('storage-upgrade');t.until('Type UPGRADE to switch storage: ');t.send('UPGRADE');t.until('growth-brain> ')
        assert json.loads((vault/'vault.json').read_text())['format']=='growth-brain-chunks'
        seed, checkpoint = root/'seed.delta', root/'checkpoint.json'
        t.send('storage-export');t.until('delta file path: ');t.send(str(seed));t.until('complete snapshot: ');t.send('');t.until('checkpoint JSON file path: ');t.send(str(checkpoint));t.until('growth-brain> ')
        assert 'headHash' in json.loads(checkpoint.read_text())
        t.send('project');t.until('Project name: ');t.send('PTY_INCREMENTAL_PROJECT');t.until('growth-brain> ')
        delta=root/'changes.delta'
        t.send('storage-export');t.until('delta file path: ');t.send(str(delta));t.until('complete snapshot: ');t.send(str(checkpoint));t.until('checkpoint JSON file path: ');t.send(str(root/'new-checkpoint.json'));t.until('growth-brain> ')
        t.send('backup');t.until('private directory: ');t.send(str(backup));t.until('growth-brain> ')
        t.send('lock');t.finish()
        replica=root/'replica';t=start('restore',replica,seed);t.password(password);t.connect()
        t.send('projects');assert 'PTY_INCREMENTAL_PROJECT' not in t.until('growth-brain> ')
        t.send('storage-apply');t.until('delta file path: ');t.send(str(delta));t.until('Type APPLY to import this delta: ');t.send('APPLY');t.until('growth-brain> ')
        t.send('projects');assert 'PTY_INCREMENTAL_PROJECT' in t.until('growth-brain> ')
        t.send('lock');t.finish()
        before=backup.read_bytes()
        t=start('recover',recovered,backup)
        t.until('file contents stay on this device): ');t.send(str(key_file))
        t.password(new_password,True);t.connect()
        t.send('projects');result=t.until('growth-brain> ')
        assert 'PTY_RECOVERY_PROJECT' in result
        t.send('lock');t.finish()
        assert backup.read_bytes()==before
        t=start('serve',recovered);t.password(new_password);t.connect();t.send('lock');t.finish()
        transcript=''.join(t.transcript for t in terminals)
        recovery_key=json.loads(key_file.read_text())['key']
        for secret in [password,new_password,recovery_key]:
            assert secret not in transcript, 'A synthetic credential appeared in terminal output'
        print(json.dumps({'actual_pty_recovery_issuance_backup_password_loss_restore_reopen':'passed','chunk_storage_delta':True,'secret_echo':False}))
    finally:
        for terminal in terminals: terminal.cleanup()
