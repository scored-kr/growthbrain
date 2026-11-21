"""Stage the pinned project's public Auth settings and reviewed sync qualification."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
PROJECT = "kcvjsvbwinlhzgmnfsji"
CONTRACT = "growthbrain.sync.v1"
CHECKS = {
    "verifiedDistinctAccounts", "anonymousDenied", "crossAccountReadDenied",
    "crossAccountWriteDenied", "crossAccountPurgeDenied", "staleRevisionRejected",
    "quotaEnforced", "purgePreventsStaleUpload",
}


def read_evidence(path):
    if not path.is_file() or path.stat().st_size > 65536:
        raise ValueError("Invalid qualification document")
    content = path.read_bytes()
    return json.loads(content), hashlib.sha256(content).hexdigest()


def qualify(catalog_path, isolation_path):
    sql_sha = hashlib.sha256((ROOT / "scripts/proposed/account-sync-v1.sql").read_bytes()).hexdigest()
    expected_catalog = (ROOT / "scripts/proposed/account-sync-catalog.sha256").read_text().strip()
    catalog, catalog_report_hash = read_evidence(catalog_path)
    base = {"projectRef": PROJECT, "contract": CONTRACT, "contractSha256": sql_sha,
            "catalogSha256": expected_catalog}
    if (not re.fullmatch(r"[a-f0-9]{64}", expected_catalog)
            or not all(catalog.get(k) == v for k, v in base.items())
            or catalog.get("kind") != "growthbrain-sync-catalog"
            or catalog.get("readOnlyVerified") is not True or catalog.get("catalogVerified") is not True
            or catalog.get("applicationRowsRead") is not False):
        raise ValueError("Catalog qualification does not match this build")
    isolation, isolation_hash = read_evidence(isolation_path)
    run, run_hash = read_evidence(isolation_path.with_name("run-evidence.json"))
    if (run.get("projectRef") != PROJECT or run.get("contract") != CONTRACT
            or run.get("passed") is not True or run.get("cleanupConfirmed") is not True
            or run.get("checks") != isolation.get("checks")
            or run_hash != isolation.get("runEvidenceSha256")):
        raise ValueError("Isolation runner evidence does not match")
    if (isolation.get("kind") != "growthbrain-sync-isolation-review-v1"
            or not all(isolation.get(k) == v for k, v in base.items())
            or isolation.get("catalogReportSha256") != catalog_report_hash
            or not re.fullmatch(r"[0-9a-f]{64}", isolation.get("runEvidenceSha256", ""))
            or not isinstance(isolation.get("checks"), dict)
            or not all(isolation["checks"].get(check) is True for check in CHECKS)):
        raise ValueError("Missing authorized two-account isolation review")
    # Ship only a digest pinned by the package inventory. Retain operator reports
    # with the build evidence. These reports are trusted release inputs.
    return hashlib.sha256((catalog_report_hash + isolation_hash).encode("ascii")).hexdigest()


def package(directory, env):
    value = env.get("GROWTH_BRAIN_SUPABASE_PUBLISHABLE_KEY", "")
    catalog = env.get("GROWTH_BRAIN_SYNC_CATALOG_REPORT", "")
    isolation = env.get("GROWTH_BRAIN_SYNC_ISOLATION_REVIEW", "")
    target = directory / "account-service.json"
    if target.exists() or target.is_symlink():
        raise ValueError("Refusing to overwrite account configuration")
    if not value and not catalog and not isolation:
        return
    if not re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]{18,180}", value):
        raise ValueError("Expected a Supabase publishable key")
    if bool(catalog) != bool(isolation):
        raise ValueError("Both qualification reports are required")
    config = {"projectRef": PROJECT, "publishableKey": value, "contractVerified": bool(catalog)}
    if catalog:
        config["reviewSha256"] = qualify(Path(catalog), Path(isolation))
    with target.open("x", encoding="utf-8") as output:
        json.dump(config, output)
        output.write("\n")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Expected the newly staged dist/ directory")
    try:
        package(Path(sys.argv[1]), os.environ)
    except (ValueError, TypeError, AttributeError, OSError):
        sys.exit("Cannot stage account configuration. Verify the publishable key and qualification reports.")
