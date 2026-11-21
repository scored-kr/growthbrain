"""Behavioral checks for the isolated local Supabase created by run.py."""

import base64
import concurrent.futures
import hashlib
import http.client
import json
import os
import re
import secrets
import subprocess
import uuid

from run import ROOT, sql


def check():
    origin = os.environ.get("GB_TEST_SUPABASE_ORIGIN", "")
    db = os.environ.get("GB_TEST_SUPABASE_DATABASE_CONTAINER", "")
    local = re.fullmatch(r"http://127\.0\.0\.1:([0-9]{1,5})", origin)
    if (
        not local
        or not 0 < int(local[1]) < 65536
        or not db.startswith("gb-sb-")
        or not db.endswith("-db")
    ):
        raise ValueError("Run inside disposable local harness")
    # Check container isolation/ownership before using its local test admin connection.
    info = json.loads(
        subprocess.check_output(
            ["docker", "inspect", "--format", "{{json .HostConfig.NetworkMode}}", db]
        )
    )
    label = subprocess.check_output(
        [
            "docker",
            "inspect",
            "--format",
            '{{index .Config.Labels "growthbrain.test"}}',
            db,
        ],
        text=True,
    ).strip()
    if info != "none" or label + "-db" != db:
        raise ValueError("Expected a private harness container")

    def request(path, data=None, token=None, method="POST"):
        body = json.dumps(data).encode() if data is not None else None
        headers = {"content-type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        conn = http.client.HTTPConnection("127.0.0.1", int(local[1]), timeout=35)
        try:
            conn.request(method, path, body, headers)
            res = conn.getresponse()
            text = res.read()
            return res.status, json.loads(text) if text else {}
        finally:
            conn.close()

    def rpc(name, token, payload):
        return request("/rest/v1/rpc/growthbrain_sync_v1_" + name, payload, token)

    def user():
        data = {
            "email": uuid.uuid4().hex + "@example.test",
            "password": secrets.token_urlsafe(32),
        }
        status, signup = request("/auth/v1/signup", data)
        assert status in (200, 201) and signup.get("access_token"), (
            f"local signup (HTTP {status}, {signup.get('error_code')})"
        )
        status, auth = request("/auth/v1/token?grant_type=password", data)
        assert status == 200 and auth.get("access_token"), "password login"
        token = auth["access_token"]
        status, identity = request("/auth/v1/user", token=token, method="GET")
        assert (
            status == 200
            and identity["email"] == data["email"]
            and identity.get("email_confirmed_at")
        ), "verified two accounts"
        return token, str(uuid.UUID(identity["id"]))

    def box(size):
        def encode(n):
            return base64.b64encode(secrets.token_bytes(n)).decode()

        return {"iv": encode(12), "tag": encode(16), "ciphertext": encode(size)}

    def payload(parent=None, seq=1, key=None):
        return {
            "version": 1,
            "vaultId": key or str(uuid.uuid4()),
            "sequence": seq,
            "parentRevision": parent,
            "body": box(96),
            "wrapped": box(32),
        }

    def checked(name, ok):
        if not ok:
            raise AssertionError(name)
        checks[name] = True

    checks = {}
    a, aid = user()
    b, bid = user()
    checked("distinctVerifiedSupabaseAccounts", aid != bid)
    denied = [
        rpc(op, None, args)[0]
        for op, args in [
            ("status", {}),
            ("read", {}),
            ("write", {"expected_revision": None, "payload": payload()}),
            ("purge", {"expected_revision": None}),
        ]
    ]
    checked("anonymousReadWritePurgeDenied", all(c in (401, 403) for c in denied))
    first = payload()

    def create(_):
        return rpc("write", a, {"expected_revision": None, "payload": first})

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        pair = list(pool.map(create, range(2)))
    checked("simultaneousCreateCAS", sorted(r[0] for r in pair) == [200, 409])
    revision = next(r[1]["revision"] for r in pair if r[0] == 200)
    checked("ownerReadsOwnEnvelope", rpc("read", a, {})[1]["payload"] == first)
    checked("otherAccountCannotRead", rpc("read", b, {})[1]["payload"] is None)
    checked(
        "otherAccountCannotWriteWithForeignRevision",
        rpc("write", b, {"expected_revision": revision, "payload": payload(revision)})[
            0
        ]
        == 409,
    )
    checked(
        "otherAccountCannotPurgeForeignRevision",
        rpc("purge", b, {"expected_revision": revision})[0] == 409,
    )
    checked(
        "foreignOwnerArgumentRejected",
        rpc("read", b, {"owner_id": aid})[0] in (400, 404),
    )
    checked(
        "privateTableNotInRESTSchema",
        request("/rest/v1/snapshots", token=b, method="GET")[0] in (403, 404),
    )
    checked(
        "plaintextFieldsRejected",
        rpc(
            "write",
            a,
            {
                "expected_revision": revision,
                "payload": {
                    **payload(revision, 2, first["vaultId"]),
                    "text": "DO NOT STORE",
                },
            },
        )[0]
        == 400,
    )
    sql(
        db,
        f"insert into growthbrain_sync_v1_private.storage_limits values ('{aid}',100);",
    )
    checked(
        "quotaRejectedWith413",
        rpc(
            "write",
            a,
            {
                "expected_revision": revision,
                "payload": payload(revision, 2, first["vaultId"]),
            },
        )[0]
        == 413,
    )
    checked(
        "quotaRejectionPreservesSnapshot", rpc("read", a, {})[1]["payload"] == first
    )
    b_payload = payload()
    checked(
        "independentAccountWrite",
        rpc("write", b, {"expected_revision": None, "payload": b_payload})[0] == 200,
    )
    status, purged = rpc("purge", a, {"expected_revision": revision})
    checked(
        "purgeChangesEpochAndDeletesCiphertext",
        status == 200
        and purged["revision"] != revision
        and purged["bytes"] == 0
        and sql(
            db,
            f"select payload is null from growthbrain_sync_v1_private.snapshots where owner_id='{aid}'",
        )
        == "t",
    )
    checked(
        "staleUploadRejectedAfterPurge",
        rpc(
            "write",
            a,
            {
                "expected_revision": revision,
                "payload": payload(revision, 2, first["vaultId"]),
            },
        )[0]
        == 409,
    )
    checked("purgePreservesOtherAccount", rpc("read", b, {})[1]["payload"] == b_payload)
    # Restore this synthetic account's test allowance before creating its new vault.
    sql(
        db,
        f"delete from growthbrain_sync_v1_private.storage_limits where owner_id='{aid}'",
    )
    recreated = payload(purged["revision"])
    checked(
        "sameAccountCanStartFreshAfterPurge",
        rpc(
            "write", a, {"expected_revision": purged["revision"], "payload": recreated}
        )[0]
        == 200
        and rpc("read", a, {})[1]["payload"] == recreated,
    )
    dashboard = json.loads(
        sql(
            db,
            "begin read only;"
            + (ROOT / "scripts/inspect-supabase-dashboard.sql").read_text()
            + "rollback;",
        )
    )
    checked(
        "readOnlyDashboardSeesFourCandidateSignatures",
        all(dashboard["syncV1"]["rpcSignaturePresent"].values()),
    )
    report = json.loads(
        sql(
            db,
            "begin isolation level repeatable read read only;set local search_path=pg_catalog;"
            + (ROOT / "scripts/proposed/inspect-sync-catalog.sql").read_text()
            + "rollback;",
        )
    )
    expected = (
        (ROOT / "scripts/proposed/account-sync-catalog.sha256").read_text().strip()
    )
    actual = hashlib.sha256(
        json.dumps(
            report["catalog"], sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode()
    ).hexdigest()
    checked(
        "readOnlyCatalogFingerprintMatches", report["readOnly"] and actual == expected
    )
    return {
        "environment": "disposable-local-supabase-core",
        "postgres": sql(db, "show server_version"),
        "genuineAuth": "GoTrue v2.197.0 (auto-confirm on test emails)",
        "genuineRest": "PostgREST v14.18",
        "schema": "repository candidate, no deployed schema imported",
        "checks": checks,
        "catalogFingerprintMatchesReviewedCandidate": actual == expected,
        "readonlyCatalogSha256": actual,
        "productionQualified": False,
    }


if __name__ == "__main__":
    print(json.dumps(check(), indent=2))
