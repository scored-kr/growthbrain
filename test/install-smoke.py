"""Installer ownership/idempotence checks with a fake CLI; not actual Codex connection evidence."""
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

class InstallerTest(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory(prefix='gb-install-')
        self.addCleanup(temporary.cleanup)
        self.base=Path(temporary.name)
        self.state=self.base/'state.json'
        self.client=self.base/'codex'
        self.state.write_text(json.dumps({'other':{'command':'keep-original'}}))
        self.client.write_text('''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
p=Path(os.environ['GB_INSTALL_STATE']);s=json.loads(p.read_text());a=sys.argv[2:];name=a[1]
if a[0]=='get':
 if name not in s:print('No MCP server named '+name,file=sys.stderr);sys.exit(1)
 print(json.dumps(s[name]))
elif a[0]=='add':
 i=a.index('--');env=a[a.index('--env')+1].split('=',1)
 s[name]={'name':name,'enabled':True,'disabled_reason':None,'transport':{'type':'stdio','command':a[i+1],'args':a[i+2:],'env':{env[0]:env[1]},'env_vars':[],'cwd':None},'enabled_tools':None,'disabled_tools':None,'startup_timeout_sec':None,'tool_timeout_sec':None};p.write_text(json.dumps(s))
elif a[0]=='remove':s.pop(name,None);p.write_text(json.dumps(s))
''')
        self.client.chmod(0o700)
        self.env={**os.environ,'GB_INSTALL_STATE':str(self.state)}
        self.skill=self.base/'skills/growth-brain'
        self.target=self.skill/'SKILL.md'
        self.source=Path('integrations/codex/growth-brain/SKILL.md').read_bytes()
        self.legacy=Path('test/fixtures/codex-skill-v1.md').read_bytes()

    def invoke(self,action):
        return subprocess.run(['python','scripts/codex-integration.py',action,'--codex',str(self.client),'--skill-dir',str(self.skill)],env=self.env,capture_output=True,text=True)

    def succeed(self,action):
        result=self.invoke(action)
        self.assertEqual(result.returncode,0,result.stderr)

    def refused_without_changes(self,action):
        config=self.state.read_bytes()
        content=self.target.read_bytes() if self.target.exists() else None
        result=self.invoke(action)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.state.read_bytes(),config)
        self.assertEqual(self.target.read_bytes() if self.target.exists() else None,content)
        return result

    def test_install_remove_idempotence_preserves_other_entries(self):
        self.succeed('install');self.succeed('install')
        self.assertEqual(json.loads(self.state.read_text())['other'],{'command':'keep-original'})
        self.succeed('remove');self.succeed('remove')
        self.assertEqual(json.loads(self.state.read_text()),{'other':{'command':'keep-original'}})
        self.assertFalse(self.target.exists())

    def test_explicit_upgrade_of_shipped_skill_preserves_mcp_and_is_idempotent(self):
        self.succeed('install')
        self.target.write_bytes(self.legacy)
        self.refused_without_changes('install')
        config=self.state.read_bytes()
        self.succeed('upgrade');self.succeed('upgrade')
        self.assertEqual(self.target.read_bytes(),self.source)
        self.assertEqual(self.state.read_bytes(),config)
        self.assertEqual(list(self.skill.iterdir()),[self.target])
        self.succeed('remove')

    def test_user_edits_and_unknown_older_skill_are_never_replaced_or_removed(self):
        self.succeed('install')
        for content in [b'User edited skill', self.legacy+b'\nUser annotation\n']:
            self.target.write_bytes(content)
            for action in ['install','upgrade','remove']:
                with self.subTest(action=action,content=content[:20]):
                    self.refused_without_changes(action)

    def test_modified_mcp_configuration_is_preserved_in_every_action(self):
        self.succeed('install')
        original=json.loads(self.state.read_text())
        variants=[('transport','env',{'GROWTH_BRAIN_SOCKET':original['growth_brain']['transport']['env']['GROWTH_BRAIN_SOCKET'],'USER_SETTING':'preserve-me'}),
                  ('transport','env_vars',['USER_TOKEN']),('transport','cwd','/user/custom/work'),
                  ('transport','type','http'),('transport','future_field','custom'),
                  (None,'enabled',False),(None,'enabled_tools',['get_context']),
                  (None,'disabled_tools',['propose_memory']),(None,'tool_timeout_sec',90),
                  (None,'startup_timeout_sec',30),(None,'future_option',True)]
        for section,key,value in variants:
            config=json.loads(json.dumps(original));entry=config['growth_brain']
            (entry[section] if section else entry)[key]=value
            for action in ['remove','install','upgrade']:
                self.state.write_text(json.dumps(config))
                self.skill.mkdir(parents=True,exist_ok=True);self.target.write_bytes(self.source)
                with self.subTest(field=key,action=action):self.refused_without_changes(action)

    def test_symlink_and_unrelated_files_are_preserved(self):
        self.succeed('install')
        extra=self.skill/'user-notes.txt';extra.write_text('retain')
        for action in ['install','upgrade','remove']:self.refused_without_changes(action)
        self.assertEqual(extra.read_text(),'retain');extra.unlink()
        saved=self.base/'personal-skill.md';saved.write_bytes(self.source)
        self.target.unlink();self.target.symlink_to(saved)
        for action in ['install','upgrade','remove']:self.refused_without_changes(action)
        self.assertTrue(self.target.is_symlink());self.assertEqual(saved.read_bytes(),self.source)

    def test_upgrade_requires_both_existing_owned_entries(self):
        self.refused_without_changes('upgrade')
        self.succeed('install');self.target.unlink()
        self.refused_without_changes('upgrade')
        self.target.write_bytes(self.legacy)
        self.state.write_text(json.dumps({'other':{'command':'keep-original'}}))
        self.refused_without_changes('upgrade')

    def test_known_legacy_skill_can_be_removed_without_upgrade(self):
        self.succeed('install');self.target.write_bytes(self.legacy)
        self.succeed('remove')
        self.assertFalse(self.skill.exists())

    def test_failed_atomic_replacement_preserves_old_skill_and_cleans_staging(self):
        self.succeed('install');self.target.write_bytes(self.legacy)
        config=self.state.read_bytes()
        argv=['scripts/codex-integration.py','upgrade','--codex',str(self.client),'--skill-dir',str(self.skill)]
        with patch.object(sys,'argv',argv), patch.dict(os.environ,self.env), patch('os.replace',side_effect=OSError('synthetic disk failure')):
            with self.assertRaisesRegex(OSError,'synthetic disk failure'):
                runpy.run_path('scripts/codex-integration.py',run_name='__main__')
        self.assertEqual(self.target.read_bytes(),self.legacy)
        self.assertEqual(self.state.read_bytes(),config)
        self.assertEqual(list(self.skill.iterdir()),[self.target])

if __name__=='__main__':
    unittest.main(verbosity=2)
