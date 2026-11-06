"""Read-only catalog inspection. Credentials are accepted only from safe env bindings."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import unquote, urlsplit

PROJECT = 'kcvjsvbwinlhzgmnfsji'
MIGRATION = '20261102050000'
CONNECTION_VARIABLE = 'GROWTH_BRAIN_SUPABASE_DB_URL'
SQL = Path(__file__).with_suffix('.sql')


class Blocked(Exception):
    pass


def connection(env):
    raw = env.get(CONNECTION_VARIABLE, '')
    if not raw:
        raise Blocked('MISSING_SAFE_DB_BINDING')
    try:
        uri = urlsplit(raw)
        if (uri.scheme not in ('postgres', 'postgresql') or
                uri.hostname != f'db.{PROJECT}.supabase.co' or
                uri.port not in (None, 5432) or uri.path != '/postgres' or
                uri.query or uri.fragment or not uri.password or
                not re.fullmatch(r'[a-z][a-z0-9_]{0,62}', unquote(uri.username or '')) or
                any(c in raw for c in '\r\n\t')):
            raise ValueError()
        user, password = unquote(uri.username), unquote(uri.password)
        if '\0' in password:
            raise ValueError()
    except (ValueError, TypeError):
        raise Blocked('INVALID_OR_UNSUPPORTED_DB_TARGET') from None
    root = env.get('GROWTH_BRAIN_DB_CA_FILE', '/etc/ssl/certs/ca-certificates.crt')
    if not Path(root).is_absolute() or not Path(root).is_file():
        raise Blocked('TRUSTED_DATABASE_CA_FILE_REQUIRED')
    # Ignore inherited libpq options/services/passwords that could change the
    # target, enable startup writes or disable certificate/hostname validation.
    child_env = {k: env[k] for k in ('PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy') if k in env}
    child_env.update({
        'PGHOST': uri.hostname, 'PGPORT': '5432', 'PGDATABASE': 'postgres',
        'PGUSER': user, 'PGPASSWORD': password, 'PGPASSFILE': os.devnull,
        'PGSSLMODE': 'verify-full', 'PGSSLROOTCERT': root, 'PGCONNECT_TIMEOUT': '5',
        'PGOPTIONS': '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000',
        'PSQL_HISTORY': os.devnull, 'LC_ALL': 'C',
    })
    return child_env


def assess(output):
    if len(output) > 2 * 1024 * 1024:
        raise Blocked('CATALOG_RESPONSE_TOO_LARGE')
    try:
        records = [json.loads(line) for line in output.splitlines() if line.strip()]
        if len(records) != 2:
            raise ValueError()
        catalog, migration = records
        if catalog.get('kind') != 'catalog' or migration.get('kind') != 'migration':
            raise ValueError()
        if catalog.get('readOnly') is not True or catalog.get('database') != 'postgres':
            raise Blocked('READ_ONLY_SESSION_NOT_VERIFIED')
        tables = catalog['tables']
        if not isinstance(tables, list) or len(tables) > 100 or any(not isinstance(t, dict) for t in tables):
            raise ValueError()
        for table in tables:
            if not isinstance(table.get('name'), str) or type(table.get('rlsEnabled')) is not bool:
                raise ValueError()
            for field in ('columns', 'policies', 'indexes', 'constraints', 'triggers'):
                if not isinstance(table.get(field), list) or any(not isinstance(x, dict) for x in table[field]):
                    raise ValueError()
            for field in ('columnCount', 'policyCount', 'indexCount', 'constraintCount', 'triggerCount'):
                if type(table.get(field)) is not int or table[field] < 0:
                    raise ValueError()
    except (ValueError, TypeError, KeyError, AttributeError):
        raise Blocked('INVALID_CATALOG_RESPONSE') from None
    reasons = []
    if migration.get('present') is not True:
        reasons.append('TARGET_MIGRATION_NOT_CONFIRMED')
    if not tables:
        reasons.append('NO_PUBLIC_TABLES_OBSERVED')
    if catalog.get('tableLimitReached') is not False or any(
        any(t[count] != len(t[field]) for field, count in (
            ('columns', 'columnCount'), ('policies', 'policyCount'), ('indexes', 'indexCount'),
            ('constraints', 'constraintCount'), ('triggers', 'triggerCount'))) or
        any(x.get('truncated') is not False for x in t['policies'] + t['indexes'] + t['constraints'] + t['triggers']) for t in tables
    ):
        reasons.append('CATALOG_LIMIT_REACHED')
    if any(not t['rlsEnabled'] or not t['policies'] for t in tables):
        reasons.append('RLS_OR_POLICY_MISSING')
    # Catalog flags do not establish tenant isolation or ciphertext-only storage.
    # Never unlock writes/migrations based on this report.
    return {
        'status': 'blocked' if reasons else 'review_required', 'reasons': reasons,
        'targetProject': PROJECT, 'expectedMigration': MIGRATION,
        'readOnlyVerified': True, 'migrationPresent': migration.get('present') is True,
        'catalog': catalog, 'readyToReuse': False, 'applicationRowsRead': False,
        'tenantIsolationVerified': False, 'ciphertextOnlyStorageVerified': False,
        'nextAction': 'Review observed tables, policies and ciphertext layout, then verify two account identities. Do not rerun initial SQL.',
    }


def inspect(env):
    child_env = connection(env)
    executable = shutil.which('psql', path=env.get('PATH', ''))
    if not executable:
        raise Blocked('PSQL_CLIENT_REQUIRED')
    try:
        result = subprocess.run(
            [executable, '-X', '-w', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
            input=SQL.read_bytes(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=child_env, timeout=25, check=False,
        )
    except subprocess.TimeoutExpired:
        raise Blocked('DATABASE_INSPECTION_TIMEOUT') from None
    if result.returncode:
        # libpq errors can include connection input; never echo them.
        raise Blocked('DATABASE_CONNECTION_OR_READ_ONLY_QUERY_FAILED')
    return assess(result.stdout)


def main():
    try:
        if len(sys.argv) != 1:
            raise Blocked('ENVIRONMENT_BINDINGS_ONLY')
        report = inspect(os.environ)
    except Blocked as error:
        report = {'status': 'blocked', 'reason': str(error), 'targetProject': PROJECT,
                  'readyToReuse': False, 'readOnlyVerified': False}
        if str(error) == 'MISSING_SAFE_DB_BINDING':
            report['missing'] = [CONNECTION_VARIABLE]
        report['nextAction'] = 'Use a safe secret binding and trusted psql/CA configuration on the authorized device. Never paste credentials into chat or command arguments.'
    except Exception:
        report = {'status': 'blocked', 'reason': 'INSPECTION_FAILED', 'readyToReuse': False, 'readOnlyVerified': False}
    print(json.dumps(report, ensure_ascii=False))
    return 1 if report['status'] == 'blocked' else 0


if __name__ == '__main__':
    sys.exit(main())
