"""Read-only qualification of the candidate RPC surface on the pinned project."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SCRIPT = Path(__file__).resolve()
CONTRACT = SCRIPT.parent / "proposed" / "account-sync-v1.sql"
QUERY = SCRIPT.parent / "proposed" / "inspect-sync-catalog.sql"
EXPECTED = SCRIPT.parent / "proposed" / "account-sync-catalog.sha256"
spec = importlib.util.spec_from_file_location("inspection", SCRIPT.with_name("inspect-supabase-schema.py"))
inspection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspection)


def fingerprint(catalog):
    encoded = json.dumps(catalog, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def inspect(env):
    child_env = inspection.connection(env)
    psql = shutil.which("psql", path=env.get("PATH", ""))
    if not psql:
        raise inspection.Blocked("PSQL_CLIENT_REQUIRED")
    # Stable schema qualification in pg_get_constraintdef / function argument rendering.
    sql = (b"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=pg_catalog;\n"
           + QUERY.read_bytes() + b"\nROLLBACK;")
    try:
        result = subprocess.run([psql, "-X", "-w", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
                                input=sql, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=child_env, timeout=25, check=False)
    except subprocess.TimeoutExpired:
        raise inspection.Blocked("DATABASE_INSPECTION_TIMEOUT") from None
    if result.returncode or len(result.stdout) > 2 * 1024 * 1024:
        raise inspection.Blocked("SYNC_CONTRACT_INSPECTION_FAILED")
    try:
        report = json.loads(result.stdout)
        if report["readOnly"] is not True or not isinstance(report["catalog"], dict):
            raise ValueError()
        actual = fingerprint(report["catalog"])
    except (KeyError, TypeError, ValueError):
        raise inspection.Blocked("INVALID_CATALOG_RESPONSE") from None
    return {
        "kind": "growthbrain-sync-catalog",
        "projectRef": inspection.PROJECT,
        "contract": "growthbrain.sync.v1",
        "contractSha256": hashlib.sha256(CONTRACT.read_bytes()).hexdigest(),
        "catalogSha256": actual,
        "readOnlyVerified": True,
        "catalogVerified": actual == EXPECTED.read_text().strip(),
        "applicationRowsRead": False,
    }


if __name__ == "__main__":
    try:
        if len(sys.argv) != 1:
            raise inspection.Blocked("ENVIRONMENT_BINDINGS_ONLY")
        result = inspect(os.environ)
    except inspection.Blocked as error:
        result = {"catalogVerified": False, "reason": str(error)}
    except Exception:
        result = {"catalogVerified": False, "reason": "INSPECTION_FAILED"}
    print(json.dumps(result))
    sys.exit(0 if result["catalogVerified"] else 1)
