"""Run a test command against fresh Supabase Postgres/Auth/PostgREST containers.
Only a loopback HTTP prefix adapter is published. No host data, remote project,
auth secret or existing container can be supplied to this harness.
"""

import contextlib
import http.client
import http.server
import io
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
PG = "public.ecr.aws/supabase/postgres@sha256:caae3d066f437332d593011e3e7ecf78ab005ce9b89378efd53f97f0410563ad"
PG17 = "public.ecr.aws/docker/library/postgres@sha256:526f86d93c6ea08fd3f1fe5605650cacc781b2c6013169a0ad8f42c7d3d84f32"
FLATTENED_PG = "growthbrain-test/postgres:15.8.1.085-flat"
AUTH = "public.ecr.aws/supabase/gotrue@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b"
REST = "public.ecr.aws/supabase/postgrest@sha256:c7cd7e265a85b05248abf53f4473fcec7e327c282d0bd0cf60f1551996d09fcf"
MAX_BYTES = 18 * 1024 * 1024


def command(args, data=b"", extra_env=None, timeout=40):
    return subprocess.run(
        args,
        input=data,
        capture_output=True,
        timeout=timeout,
        env={**os.environ, **(extra_env or {})},
    )


def sql(container, statement):
    result = command(
        [
            "docker",
            "exec",
            "-i",
            container,
            "psql",
            "-X",
            "-v",
            "ON_ERROR_STOP=1",
            "-qAt",
            "-U",
            "supabase_admin",
            "-d",
            "postgres",
        ],
        statement.encode(),
    )
    if result.returncode:
        raise RuntimeError("Disposable PostgreSQL query failed")
    return result.stdout.decode().strip()


class Reply:
    def __init__(self, data):
        self.stream = io.BytesIO(data)

    def makefile(self, mode):
        return self.stream


def upstream(container, port, method, path, body=b"", headers=None):
    # Docker shares only the three containers' private loopback network. Pipe
    # HTTP bytes over stdin/stdout so JWTs and passwords never become argv.
    if not (
        path.startswith("/")
        and path.isascii()
        and all(ord(c) > 32 and ord(c) < 127 for c in path)
    ):
        raise ValueError("Invalid path")
    lines = [
        f"{method} {path} HTTP/1.1",
        f"Host: localhost:{port}",
        "Connection: close",
        f"Content-Length: {len(body)}",
        "Accept: application/json",
        "Content-Type: application/json",
    ]
    if headers and headers.get("Authorization"):
        token = headers["Authorization"]
        if len(token) > 16384 or "\r" in token or "\n" in token:
            raise ValueError("Invalid authorization")
        lines.append("Authorization: " + token)
    raw = ("\r\n".join(lines) + "\r\n\r\n").encode("ascii") + body
    result = command(
        [
            "docker",
            "exec",
            "-i",
            container,
            "bash",
            "-c",
            'exec 3<>/dev/tcp/127.0.0.1/"$1" || exit 1; cat >&3; cat <&3',
            "relay",
            str(port),
        ],
        raw,
        timeout=25,
    )
    if result.returncode:
        raise RuntimeError("Local upstream unavailable")
    response = http.client.HTTPResponse(Reply(result.stdout))
    response.begin()
    payload = response.read(MAX_BYTES + 1)
    if len(payload) > MAX_BYTES:
        raise ValueError("Response too large")
    return (
        response.status,
        response.getheader("content-type", "application/json"),
        payload,
    )


def handler(container):
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def forward(self):
            try:
                routes = {"/auth/v1": 9999, "/rest/v1": 3000}
                prefix = next(
                    (p for p in routes if self.path.startswith(p + "/")), None
                )
                length = int(self.headers.get("Content-Length", 0))
                if (
                    prefix is None
                    or length < 0
                    or length > MAX_BYTES
                    or self.headers.get("Transfer-Encoding")
                ):
                    self.send_error(400)
                    return
                status, content_type, data = upstream(
                    container,
                    routes[prefix],
                    self.command,
                    self.path[len(prefix) :],
                    self.rfile.read(length),
                    self.headers,
                )
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except (
                OSError,
                ValueError,
                RuntimeError,
                StopIteration,
                subprocess.SubprocessError,
                http.client.HTTPException,
            ):
                self.send_error(502)

        do_GET = do_POST = do_PUT = do_DELETE = forward

    return Handler


def wait_until(check, name, seconds=90):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except (
            OSError,
            RuntimeError,
            http.client.HTTPException,
            subprocess.SubprocessError,
        ):
            pass
        time.sleep(0.5)
    raise RuntimeError("Disposable " + name + " startup failed")


def run(args, native_pg=False):
    account_id = "gb-sb-" + secrets.token_hex(6)
    db = account_id + "-db"
    password = secrets.token_urlsafe(32)
    jwt = secrets.token_urlsafe(48)
    with contextlib.ExitStack() as cleanup:

        def start(name, image, net, env, options=()):
            cmd = [
                "docker",
                "run",
                "--detach",
                "--name",
                name,
                "--network",
                net,
                "--label",
                "growthbrain.test=" + account_id,
                *options,
            ]
            for key in env:
                cmd.extend(["--env", key])
            result = command([*cmd, image], extra_env=env, timeout=600)
            if result.returncode:
                raise RuntimeError("Unable to start disposable " + name)
            cleanup.callback(command, ["docker", "rm", "-f", "-v", name])

        # A locally flattened copy of this exact image avoids quadratic storage
        # on Docker hosts using the VFS driver. The normal path uses its digest.
        source = command(
            [
                "docker",
                "image",
                "inspect",
                "--format",
                '{{ index .Config.Labels "growthbrain.test.upstream" }}',
                FLATTENED_PG,
            ]
        )
        pg = FLATTENED_PG if source.stdout.decode().strip() == PG else PG
        start(
            db,
            PG17 if native_pg else pg,
            "none",
            {
                "POSTGRES_USER": "supabase_admin",
                "POSTGRES_PASSWORD": password,
                "PGPASSWORD": password,
                "POSTGRES_DB": "postgres",
                "JWT_SECRET": jwt,
                "JWT_EXP": "3600",
            },
            ["--tmpfs", "/var/lib/postgresql/data:rw,size=768m"],
        )
        wait_until(lambda: sql(db, "select 1;") == "1", "PostgreSQL")
        # Wait for the permanent postmaster: initdb uses a temporary socket
        # server before it runs the Supabase image's role and schema migrations.
        wait_until(
            lambda: (
                command(
                    [
                        "docker",
                        "exec",
                        db,
                        "pg_isready",
                        "-h",
                        "127.0.0.1",
                        "-p",
                        "5432",
                    ]
                ).returncode
                == 0
            ),
            "database TCP",
        )
        if native_pg:
            # GoTrue owns and migrates auth.users, auth.uid() and the auth schema.
            # These bootstrap roles mirror Supabase's local database entrypoint.
            sql(
                db,
                """create role postgres;
                       create role anon nologin;
                       create role authenticated nologin;
                       create role authenticator noinherit login;
                       create role supabase_auth_admin noinherit login;
                       grant anon, authenticated to authenticator;
                       create schema auth authorization supabase_auth_admin;
                       alter role supabase_auth_admin set search_path=auth;
                       grant usage on schema auth to anon, authenticated;""",
            )
        sql(
            db,
            r"""\getenv local_password POSTGRES_PASSWORD
ALTER ROLE supabase_auth_admin PASSWORD :'local_password';
ALTER ROLE authenticator PASSWORD :'local_password';
""",
        )
        auth_url = "http://127.0.0.1:9999"
        start(
            account_id + "-auth",
            AUTH,
            "container:" + db,
            {
                "GOTRUE_API_HOST": "127.0.0.1",
                "GOTRUE_API_PORT": "9999",
                "API_EXTERNAL_URL": auth_url,
                "GOTRUE_DB_DRIVER": "postgres",
                "GOTRUE_DB_DATABASE_URL": f"postgres://supabase_auth_admin:{password}@127.0.0.1:5432/postgres",
                "GOTRUE_SITE_URL": "http://127.0.0.1",
                "GOTRUE_JWT_SECRET": jwt,
                "GOTRUE_JWT_AUD": "authenticated",
                "GOTRUE_JWT_DEFAULT_GROUP_NAME": "authenticated",
                "GOTRUE_JWT_EXP": "3600",
                "GOTRUE_EXTERNAL_EMAIL_ENABLED": "true",
                "GOTRUE_MAILER_AUTOCONFIRM": "true",
                "GOTRUE_DISABLE_SIGNUP": "false",
                "GOTRUE_RATE_LIMIT_EMAIL_SENT": "100",
                "GOTRUE_RATE_LIMIT_TOKEN_REFRESH": "1000",
            },
        )
        wait_until(lambda: upstream(db, 9999, "GET", "/health")[0] == 200, "Auth")
        sql(db, (ROOT / "scripts/proposed/account-sync-v1.sql").read_text())
        start(
            account_id + "-rest",
            REST,
            "container:" + db,
            {
                "PGRST_DB_URI": f"postgres://authenticator:{password}@127.0.0.1:5432/postgres",
                "PGRST_DB_SCHEMAS": "public",
                "PGRST_DB_ANON_ROLE": "anon",
                "PGRST_JWT_SECRET": jwt,
                "PGRST_SERVER_HOST": "127.0.0.1",
                "PGRST_SERVER_PORT": "3000",
            },
        )
        wait_until(lambda: upstream(db, 3000, "GET", "/")[0] == 200, "PostgREST")
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler(db))
        cleanup.callback(server.server_close)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        cleanup.callback(server.shutdown)
        origin = "http://127.0.0.1:" + str(server.server_address[1])
        print("Isolated Supabase ready (PostgreSQL + GoTrue + PostgREST).", flush=True)
        env = {
            **os.environ,
            "GB_TEST_SUPABASE_ORIGIN": origin,
            "GB_TEST_SUPABASE_DATABASE_CONTAINER": db,
        }
        return subprocess.run(args, env=env, cwd=ROOT).returncode


if __name__ == "__main__":
    args = sys.argv[1:]
    native_pg = args[:1] == ["--postgres17"]
    if native_pg:
        args = args[1:]
    if not args:
        sys.exit(
            "Usage: python3 test/local-supabase/run.py [--postgres17] <test command> [args...]"
        )
    try:
        sys.exit(run(args, native_pg))
    except (RuntimeError, subprocess.SubprocessError) as e:
        sys.exit(str(e))
