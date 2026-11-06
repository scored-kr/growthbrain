"""CLI guards with an isolated synthetic psql process; no real credentials/network."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/inspect-supabase-schema.py'
spec = importlib.util.spec_from_file_location('inspector', SCRIPT)
inspector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspector)


def catalog():
    return {'kind': 'catalog', 'readOnly': True, 'database': 'postgres', 'tableLimitReached': False,
            'tables': [{'name': 'vault_blobs', 'rlsEnabled': True, 'rlsForced': False,
                        'columnCount': 1, 'columns': [{'name': 'ciphertext', 'type': 'bytea'}],
                        'policyCount': 1, 'policies': [{'name': 'owner_only', 'truncated': False}],
                        'indexCount': 0, 'indexes': [], 'constraintCount': 0, 'constraints': [],
                        'triggerCount': 0, 'triggers': []}]}


class InspectorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='gb-schema-guard-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        ca = self.root / 'ca.pem'; ca.write_text('synthetic CA, never used on a network')
        self.secret = 'synthetic_password_do_not_echo'
        self.env = {'PATH': str(self.root), 'GROWTH_BRAIN_DB_CA_FILE': str(ca),
                    'GROWTH_BRAIN_SUPABASE_DB_URL': f'postgresql://audit_user:{self.secret}@db.{inspector.PROJECT}.supabase.co/postgres',
                    'PGSSLMODE': 'disable', 'PGOPTIONS': '-c default_transaction_read_only=off',
                    'PGSERVICE': 'unrelated', 'IGN8T_API_KEY': 'unrelated-secret'}

    def run_cli(self, env=None):
        result = subprocess.run([sys.executable, str(SCRIPT)], env=self.env if env is None else env,
                                capture_output=True, text=True, timeout=5)
        self.assertNotIn(self.secret, result.stdout + result.stderr)
        self.assertNotIn('unrelated-secret', result.stdout + result.stderr)
        return result, json.loads(result.stdout)

    def fake_psql(self, fail=False):
        path = self.root / 'psql'
        output = json.dumps(catalog()) + '\n' + json.dumps({'kind': 'migration', 'present': True})
        code = f'''#!{sys.executable}
import os,sys
query=sys.stdin.read()
assert sys.argv[1:]==['-X','-w','-q','-A','-t','-v','ON_ERROR_STOP=1']
assert 'READ ONLY' in query and query.rstrip().endswith('ROLLBACK;')
assert os.environ['PGHOST']=='db.{inspector.PROJECT}.supabase.co'
assert os.environ['PGSSLMODE']=='verify-full'
assert 'default_transaction_read_only=on' in os.environ['PGOPTIONS']
assert os.environ['PGPASSWORD']=={self.secret!r}
assert 'PGSERVICE' not in os.environ and 'IGN8T_API_KEY' not in os.environ
assert not any(os.environ['PGPASSWORD'] in arg for arg in sys.argv)
'''
        code += "print(os.environ['PGPASSWORD'],file=sys.stderr);sys.exit(1)\n" if fail else f"print({output!r})\n"
        path.write_text(code); path.chmod(0o700)

    def test_missing_binding_and_client_fail_closed(self):
        result, report = self.run_cli({})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report['missing'], [inspector.CONNECTION_VARIABLE])
        result, report = self.run_cli()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report['reason'], 'PSQL_CLIENT_REQUIRED')

    def test_target_and_tls_configuration_cannot_be_redirected(self):
        valid = self.env[inspector.CONNECTION_VARIABLE]
        for value in [valid.replace(inspector.PROJECT, 'differentproject'), valid + '?sslmode=disable',
                      valid.replace('.supabase.co/', '.supabase.co.evil/'), valid.replace('/postgres', '/other'),
                      valid + '#fragment', valid.replace('@db.', '@127.0.0.1/#db.')]:
            with self.subTest(case=value.replace(self.secret, '[synthetic]')):
                result, report = self.run_cli({**self.env, inspector.CONNECTION_VARIABLE: value})
                self.assertEqual(result.returncode, 1)
                self.assertEqual(report['reason'], 'INVALID_OR_UNSUPPORTED_DB_TARGET')

    def test_sanitized_subprocess_and_inspection_are_never_reuse_approval(self):
        self.fake_psql()
        result, report = self.run_cli()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(report['status'], 'review_required')
        self.assertTrue(report['readOnlyVerified'])
        for key in ['readyToReuse', 'tenantIsolationVerified', 'ciphertextOnlyStorageVerified', 'applicationRowsRead']:
            self.assertFalse(report[key])
        self.fake_psql(fail=True)
        result, report = self.run_cli()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report['reason'], 'DATABASE_CONNECTION_OR_READ_ONLY_QUERY_FAILED')

    def test_catalog_gaps_and_oversized_or_invalid_responses_do_not_pass(self):
        for field, value, reason in [('readOnly', False, 'READ_ONLY_SESSION_NOT_VERIFIED'),
                                    ('tableLimitReached', True, 'CATALOG_LIMIT_REACHED')]:
            data = catalog(); data[field] = value
            raw = json.dumps(data) + '\n' + json.dumps({'kind': 'migration', 'present': True})
            if field == 'readOnly':
                with self.assertRaisesRegex(inspector.Blocked, reason): inspector.assess(raw)
            else:
                self.assertIn(reason, inspector.assess(raw)['reasons'])
        data = catalog(); data['tables'][0]['rlsEnabled'] = False
        report = inspector.assess(json.dumps(data) + '\n' + json.dumps({'kind': 'migration', 'present': False}))
        self.assertEqual(report['reasons'], ['TARGET_MIGRATION_NOT_CONFIRMED', 'RLS_OR_POLICY_MISSING'])
        for output in ['not-json', '{}', 'x' * (2 * 1024 * 1024 + 1)]:
            with self.assertRaises(inspector.Blocked): inspector.assess(output)


if __name__ == '__main__':
    unittest.main(verbosity=2)
