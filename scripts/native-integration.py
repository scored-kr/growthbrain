#!/usr/bin/env python3
"""Install only the owned native host manifest and launcher; never handles vault keys."""
import argparse,json,os,re,shlex,shutil,sys
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('action',choices=['install','remove'])
p.add_argument('--extension-id',required=True)
p.add_argument('--browser',choices=['chrome','chromium'],default='chrome')
p.add_argument('--manifest-dir',type=Path)
p.add_argument('--launcher',type=Path,default=Path.home()/'.local/share/growth-brain-client/native-host')
p.add_argument('--socket',type=Path,default=Path.home()/'.local/share/growth-brain/memory.sock')
a=p.parse_args()
if not re.fullmatch('[a-p]{32}',a.extension_id):sys.exit('Expected the exact Chrome extension ID, never a wildcard.')
if sys.platform not in ['linux','darwin']:sys.exit('Native host installer currently supports Linux/macOS only.')
root=Path(__file__).resolve().parents[1];entry=root/'dist/native-host.js';node=shutil.which('node')
if not node or not entry.is_file():sys.exit('Build the project first.')
if a.manifest_dir is None:
 if sys.platform=='linux':a.manifest_dir=Path.home()/'.config'/('google-chrome' if a.browser=='chrome' else 'chromium')/'NativeMessagingHosts'
 else:a.manifest_dir=Path.home()/'Library/Application Support'/('Google/Chrome' if a.browser=='chrome' else 'Chromium')/'NativeMessagingHosts'
a.launcher=a.launcher.absolute();a.socket=a.socket.absolute()
manifest=a.manifest_dir/'com.growthbrain.local.json'
launcher='#!/bin/sh\nexport GROWTH_BRAIN_EXTENSION_ID='+shlex.quote(a.extension_id)+'\nexport GROWTH_BRAIN_SOCKET='+shlex.quote(str(a.socket))+'\nexec '+shlex.quote(node)+' '+shlex.quote(str(entry))+' "$@"\n'
payload={'name':'com.growthbrain.local','description':'Growth Brain local encrypted vault bridge','path':str(a.launcher),'type':'stdio','allowed_origins':['chrome-extension://'+a.extension_id+'/']}
for file in [manifest,a.launcher]:
 if file.is_symlink():sys.exit('Refusing a symlink destination; nothing changed.')
if manifest.exists() and json.loads(manifest.read_text())!=payload:sys.exit('Another native host configuration exists; nothing changed.')
if a.launcher.exists() and a.launcher.read_text()!=launcher:sys.exit('Another launcher exists; nothing changed.')
if a.action=='install':
 a.manifest_dir.mkdir(parents=True,exist_ok=True);a.launcher.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 if not a.launcher.exists():
  fd=os.open(a.launcher,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o700)
  with os.fdopen(fd,'w') as f:f.write(launcher)
 if not manifest.exists():
  with manifest.open('x') as f:json.dump(payload,f,indent=2)
 print('Native host registered for this extension ID only. Unlock the vault separately.')
else:
 if manifest.exists():manifest.unlink()
 if a.launcher.exists():a.launcher.unlink()
 print('Owned native host files removed. Extension settings, vault and unrelated hosts preserved.')
