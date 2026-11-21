# Local Supabase integration tests

Run from the repository root with Python 3, a Linux Docker engine and access to the public container registry.

```sh
python3 test/local-supabase/run.py python3 test/local-supabase/verify.py
```

This starts a new Supabase PostgreSQL 15.8 cluster, GoTrue 2.197.0 and PostgREST 14.18. The harness pins the Linux amd64 images by digest, applies the repository's proposed account sync SQL to the empty database, and runs the test command. The optional `--postgres17` argument selects the smaller official PostgreSQL 17.12 image. In that mode, the harness creates the Supabase database roles and auth schema that GoTrue needs before GoTrue applies its own migrations.

The containers share a private loopback interface. The host publishes a random loopback HTTP port for the duration of the test command. No host directory is mounted in a container. Disposable email accounts auto-confirm in GoTrue and use password login. The test asserts the behavior of the signed access tokens through PostgREST, account isolation, concurrent writes, quota rejection, purge and stale device rejection. It also compares the checked-in catalog fingerprint under a repeatable-read, read-only PostgreSQL transaction. The harness removes its containers and volatile database when the command finishes.

For a two-device product run, install the repository dependencies and build the application first.

```sh
npm ci
npm run build
python3 test/local-supabase/run.py node --test test/local-supabase/product.test.mjs
```

The two-device test starts independent product processes with separate data directories. Its test transport forwards product requests to the loopback gateway and can drop a response before or after PostgREST commits. The scoped MCP checks use the product server and local OAuth clients. Public relay operation and the ChatGPT and Claude web interfaces require separate testing.

The child command receives the local HTTP address in `GB_TEST_SUPABASE_ORIGIN` and the disposable database container name in `GB_TEST_SUPABASE_DATABASE_CONTAINER`. It can inspect its own test rows through the local PostgreSQL socket as `supabase_admin`. The source of the test schema is [the repository candidate](../../scripts/proposed/account-sync-v1.sql). The deployed Growth Brain schema still requires the operator's separate catalog report.
