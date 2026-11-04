import sys
"""Real filesystem/subprocess installer checks. Does not run either AI model."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

class AgentInstallerTest(unittest.TestCase):
    def test_both_hook_configs_merge_and_remove_without_touching_settings_or_trust(self):
        for client in ['codex','claude-code']:
            with self.subTest(client=client),tempfile.TemporaryDirectory(prefix='gb-hooks-') as directory:
                config=Path(directory)/'settings.json'
                other={'hooks':[{'type':'command','command':'user-owned-script','timeout':15}]}
                original={'hooks':{'Stop':[other]},'permissions':{'allow':['existing']},'custom':'keep'}
                config.write_text(json.dumps(original))
                def run(action):return subprocess.run([sys.executable,'scripts/agent-hooks.py',action,'--client',client,'--config',str(config)],capture_output=True,text=True)
                self.assertEqual(run('install').returncode,0);self.assertEqual(run('install').returncode,0)
                data=json.loads(config.read_text());self.assertIn(other,data['hooks']['Stop']);self.assertEqual(len(data['hooks']['Stop']),2)
                self.assertEqual(data['permissions'],original['permissions'])
                installed=config.read_bytes();data['hooks']['Stop'][-1]['hooks'][0]['timeout']=99
                config.write_text(json.dumps(data));changed=config.read_bytes()
                self.assertNotEqual(run('remove').returncode,0);self.assertNotEqual(run('install').returncode,0);self.assertEqual(config.read_bytes(),changed)
                config.write_bytes(installed);self.assertEqual(run('remove').returncode,0);self.assertEqual(run('remove').returncode,0)
                self.assertEqual(json.loads(config.read_text()),original)

    def test_claude_mcp_preserves_unrelated_auth_metadata_settings_and_skill_edits(self):
        with tempfile.TemporaryDirectory(prefix='gb-claude-install-') as directory:
            base=Path(directory);config=base/'claude.json';skill=base/'skills/growth-brain'
            original={'mcpServers':{'other':{'command':'user-owned'}},'syntheticAuthMetadata':'preserve','projects':{'/existing':{'trust':True}}}
            config.write_text(json.dumps(original))
            def run(action):return subprocess.run([sys.executable,'scripts/claude-integration.py',action,'--config',str(config),'--skill-dir',str(skill)],capture_output=True,text=True)
            self.assertEqual(run('install').returncode,0);self.assertEqual(run('install').returncode,0)
            saved=(skill/'SKILL.md').read_bytes();(skill/'SKILL.md').write_text('User edited')
            before=config.read_bytes();self.assertNotEqual(run('remove').returncode,0);self.assertNotEqual(run('upgrade').returncode,0);self.assertEqual(config.read_bytes(),before)
            (skill/'SKILL.md').write_bytes(Path('test/fixtures/codex-skill-v2.md').read_bytes())
            self.assertNotEqual(run('install').returncode,0)
            self.assertEqual(run('upgrade').returncode,0);self.assertEqual(run('upgrade').returncode,0)
            self.assertEqual((skill/'SKILL.md').read_bytes(),saved);self.assertEqual(config.read_bytes(),before)
            (skill/'SKILL.md').write_bytes(saved);self.assertEqual(run('remove').returncode,0)
            self.assertEqual(json.loads(config.read_text()),original)

if __name__=='__main__':unittest.main(verbosity=2)
