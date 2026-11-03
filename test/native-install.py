import json,subprocess,tempfile
from pathlib import Path
with tempfile.TemporaryDirectory(prefix='gb-native-installer-') as directory:
 base=Path(directory);manifest=base/'manifests';launcher=base/'launcher'
 args=['--extension-id','a'*32,'--manifest-dir',str(manifest),'--launcher',str(launcher),'--socket',str(base/'memory.sock')]
 def run(action):return subprocess.run(['python','scripts/native-integration.py',action,*args],capture_output=True,text=True)
 assert run('install').returncode==0;assert run('install').returncode==0
 p=manifest/'com.growthbrain.local.json';data=json.loads(p.read_text());assert data['allowed_origins']==['chrome-extension://'+'a'*32+'/']
 unrelated=manifest/'other.json';unrelated.write_text('preserve')
 original=launcher.read_text();launcher.write_text('user modified')
 assert run('remove').returncode!=0;assert p.exists()
 launcher.write_text(original);assert run('remove').returncode==0;assert unrelated.read_text()=='preserve'
 assert run('remove').returncode==0
 print('Native installer exact origin, idempotence, user edits and unrelated manifests preserved.')
