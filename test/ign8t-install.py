import importlib.util
from pathlib import Path
import tempfile
import tomllib
import unittest

spec = importlib.util.spec_from_file_location('ign8t_install', Path(__file__).resolve().parents[1]/'scripts/ign8t-integration.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class IntegrationTests(unittest.TestCase):
    def test_preserve_and_idempotence(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'config.toml'
            initial = '# keep comments\nmodel = "existing"\n[mcp_servers.other]\ncommand = "other"\n'
            path.write_text(initial)
            module.update(path, 'install')
            installed = path.read_bytes()
            self.assertTrue(installed.startswith(initial.encode()))
            self.assertIn('IGN8T_API_KEY', tomllib.loads(installed.decode())['mcp_servers']['ign8t']['env_vars'])
            module.update(path, 'install')
            self.assertEqual(path.read_bytes(), installed)
            module.update(path, 'remove')
            self.assertEqual(path.read_text(), initial)
            module.update(path, 'remove')
            self.assertEqual(path.read_text(), initial)

    def test_modified_and_unowned_refused(self):
        variants = [module.BLOCK.replace('"npx"', '"custom"'), module.BLOCK+'[mcp_servers.ign8t.extra]\nx = true\n', module.BLOCK.replace(module.BEGIN, ''), '[mcp_servers.ign8t]\ncommand="existing"\n', 'invalid = [']
        for value in variants:
            with self.subTest(value=value), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp)/'config.toml'; path.write_text(value)
                for action in ['install', 'remove']:
                    with self.assertRaises(ValueError): module.update(path, action)
                    self.assertEqual(path.read_text(), value)

    def test_symlink_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            original = Path(tmp)/'original'; original.write_text('# keep\n')
            path = Path(tmp)/'config.toml'; path.symlink_to(original)
            with self.assertRaises(ValueError): module.update(path, 'install')
            self.assertEqual(original.read_text(), '# keep\n')

unittest.main()
