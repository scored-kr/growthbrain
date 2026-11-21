"""Public account settings and contract review checks during packaging."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

source = Path(__file__).resolve().parents[1] / "scripts/package-account-config.py"
spec = importlib.util.spec_from_file_location("packager", source)
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class Config(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.base = Path(directory.name)
        self.dist = self.base / "dist"
        self.dist.mkdir()
        self.env = {"GROWTH_BRAIN_SUPABASE_PUBLISHABLE_KEY": "sb_publishable_" + "a" * 32}

    def test_public_only(self):
        packager.package(self.dist, {})
        self.assertEqual(list(self.dist.iterdir()), [])
        with self.assertRaises(ValueError):
            packager.package(self.dist, {"GROWTH_BRAIN_SUPABASE_PUBLISHABLE_KEY": "sb_secret_" + "a"*32})
        packager.package(self.dist, self.env)
        cfg = json.loads((self.dist / "account-service.json").read_text())
        self.assertFalse(cfg["contractVerified"])
        self.assertEqual(cfg["projectRef"], packager.PROJECT)

    def test_reports_bound_to_reviewed_database_and_isolation_checks(self):
        old_root = packager.ROOT
        self.addCleanup(setattr, packager, "ROOT", old_root)
        packager.ROOT = self.base
        proposed = self.base / "scripts/proposed"
        proposed.mkdir(parents=True)
        sql = b"test fixture"
        pin = "c" * 64
        (proposed / "account-sync-v1.sql").write_bytes(sql)
        (proposed / "account-sync-catalog.sha256").write_text(pin)
        base = {"projectRef": packager.PROJECT, "contract": packager.CONTRACT,
                "contractSha256": hashlib.sha256(sql).hexdigest(), "catalogSha256": pin}
        catalog = self.base / "catalog.json"
        catalog.write_text(json.dumps({**base, "kind": "growthbrain-sync-catalog", "readOnlyVerified": True,
                                      "catalogVerified": True, "applicationRowsRead": False}))
        self.env["GROWTH_BRAIN_SYNC_CATALOG_REPORT"] = str(catalog)
        with self.assertRaises(ValueError):
            packager.package(self.dist, self.env)
        isolation_path = self.base / "isolation.json"
        self.env["GROWTH_BRAIN_SYNC_ISOLATION_REVIEW"] = str(isolation_path)
        isolation = {**base, "kind": "growthbrain-sync-isolation-review-v1",
                     "runEvidenceSha256": "d"*64, "catalogReportSha256": hashlib.sha256(catalog.read_bytes()).hexdigest(),
                     "checks": {k: True for k in packager.CHECKS}}
        evidence = self.base / "run-evidence.json"
        evidence.write_text(json.dumps({"projectRef": packager.PROJECT, "contract": packager.CONTRACT,
                             "passed": True, "cleanupConfirmed": True, "checks": isolation["checks"]}))
        isolation["runEvidenceSha256"] = hashlib.sha256(evidence.read_bytes()).hexdigest()
        for changed in [{"runEvidenceSha256": "0"*64}, {"contractSha256": "0"*64}, {"projectRef": "other"}, {"checks": {"verifiedDistinctAccounts": True}}]:
            isolation_path.write_text(json.dumps({**isolation, **changed}))
            with self.assertRaises(ValueError):
                packager.package(self.dist, self.env)
        isolation_path.write_text(json.dumps(isolation))
        packager.package(self.dist, self.env)
        cfg = json.loads((self.dist / "account-service.json").read_text())
        self.assertTrue(cfg["contractVerified"])
        self.assertRegex(cfg["reviewSha256"], r"^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
