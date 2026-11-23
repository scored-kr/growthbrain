"""Build the Windows x64 test installer on Linux or Windows. No service, signing, or publication."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from release_files import EXTENSION_FILES

ROOT = Path(__file__).resolve().parents[1]
NODE_PREFIX = "node-v24.19.0-win-x64"
NODE_SHA256 = "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73"
PRODUCT = "scored-kr/growthbrain/windows-x64/v1"


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def run(args, cwd, env=None):
    subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, check=True)


def build_go(directory, dest, *, gui=False, extra_flags=(), tags=()):
    env = {**os.environ, "GOOS": "windows", "GOARCH": "amd64", "CGO_ENABLED": "0", "GOTOOLCHAIN": "local"}
    if not (directory / "go.mod").is_file():
        env["GO111MODULE"] = "off"
    flags = ["-s", "-w", "-buildid=", *extra_flags]
    if gui:
        flags.append("-H=windowsgui")
    read_only = ["-mod=readonly"] if (directory / "go.mod").exists() else []
    tag_args = ["-tags", ",".join(tags)] if tags else []
    run(["go", "build", *read_only, *tag_args, "-trimpath", "-buildvcs=false", "-ldflags", " ".join(flags), "-o", dest, "."], directory, env)


def node_runtime(app, tmp, archive):
    if not archive:
        archive = tmp / (NODE_PREFIX + ".zip")
        with urllib.request.urlopen(f"https://nodejs.org/dist/v24.19.0/{archive.name}", timeout=90) as src, archive.open("xb") as out:
            shutil.copyfileobj(src, out)
    if digest(archive) != NODE_SHA256:
        raise ValueError("Unexpected Node distribution digest")
    with zipfile.ZipFile(archive) as z:
        for source, dest in [("node.exe", "node.exe"), ("LICENSE", "Node-LICENSE.txt")]:
            with z.open(f"{NODE_PREFIX}/{source}") as src, (app / dest).open("xb") as out:
                shutil.copyfileobj(src, out)


def make_payload(tmp, archive):
    app = tmp / "app"
    app.mkdir()
    # Compile directly to a fresh tree. Untracked/stale build files never enter the installer.
    run(["node", ROOT / "node_modules/typescript/bin/tsc", "--outDir", app / "dist"], ROOT)
    run([sys.executable, ROOT / "scripts/package-account-config.py", app / "dist"], ROOT)
    for name in ["package.json", "package-lock.json"]:
        shutil.copy2(ROOT / name, app / name)
    run(["npm.cmd" if os.name == "nt" else "npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], app)
    shutil.rmtree(app / "node_modules/.bin", ignore_errors=True)
    node_runtime(app, tmp, archive)

    # Use the same reviewed files as the ZIP. A product source archive has no .git directory.
    extension = app / "extension"
    extension.mkdir()
    for filename in EXTENSION_FILES:
        source = ROOT / "extension" / filename
        if source.is_symlink() or not source.is_file():
            raise ValueError(f"Expected a regular product extension file: {filename}")
        shutil.copy2(source, extension / filename)
    shutil.copyfile(app / "dist/account-auth.js", extension / "account-auth.js")
    manifest = extension / "manifest.json"
    cfg = json.loads(manifest.read_text(encoding="utf-8"))
    cfg["key"] = (ROOT / "windows/native/extension-public-key.txt").read_text().strip()
    manifest.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")

    (app / "licenses").mkdir()
    goroot = Path(subprocess.check_output(["go", "env", "GOROOT"], text=True).strip())
    shutil.copyfile(goroot / "LICENSE", app / "licenses/Go-LICENSE.txt")
    build_go(ROOT / "windows/desktop", app / "GrowthBrain.exe", gui=True)
    build_go(ROOT / "windows/files", app / "dist/growthbrain-files.exe")
    build_go(ROOT / "windows/native", app / "NativeHost.exe")
    shutil.copy2(ROOT / "windows/native/com.growthbrain.local.json", app)
    route = ROOT / "integrations/windows-route"
    build_go(route, app / "growth-brain-route.exe", tags=("ts_omit_logtail",))
    run([sys.executable, route / "notices.py", app / "licenses/THIRD-PARTY-NOTICES.txt"], route)
    shutil.copyfile(route / "NOTICE", app / "licenses/Route-NOTICE.txt")

    inv = {}
    for path in sorted(app.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Unexpected link in payload at {path.relative_to(app)}")
        if path.is_file():
            inv[path.relative_to(app).as_posix()] = digest(path)
    (app / ".growthbrain-installed.json").write_text(json.dumps({"product": PRODUCT, "files": inv}, separators=(",", ":")), encoding="utf-8")
    payload = tmp / "payload.zip"
    with zipfile.ZipFile(payload, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for path in sorted(app.rglob("*")):
            if path.is_file():
                info = zipfile.ZipInfo(path.relative_to(app).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                with path.open("rb") as src, z.open(info, "w") as out:
                    shutil.copyfileobj(src, out)
    return payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="New setup EXE path")
    parser.add_argument("--node-zip", type=Path, help="Optional local copy of the pinned official distribution")
    args = parser.parse_args()
    out = args.output.resolve()
    if out.exists():
        raise SystemExit(f"Output already exists: {out}")
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out.parent, prefix=".gb-build-") as directory:
        tmp = Path(directory)
        payload = make_payload(tmp, args.node_zip)
        setup = tmp / "setup"
        shutil.copytree(ROOT / "windows/setup", setup)
        # Embedded asInvoker manifest keeps the Windows installer detection heuristic
        # from requesting UAC elevation even when the filename contains "Setup".
        run(["go", "run", "github.com/akavel/rsrc@v0.10.2", "-arch", "amd64", "-manifest", "app.manifest", "-o", "resource_windows_amd64.syso"], setup)
        target = tmp / "setup.exe"
        build_go(setup, target, gui=True, extra_flags=["-X", f"main.payloadSHA={digest(payload)}", "-X", f"main.payloadSize={payload.stat().st_size}"])
        with payload.open("rb") as src, target.open("ab") as f:
            shutil.copyfileobj(src, f)
        # Inspect the exact final executable and appended archive before handing it off.
        with zipfile.ZipFile(target) as z:
            if z.testzip() is not None:
                raise ValueError("Packaged archive failed verification")
        os.link(target, out)  # never overwrite, also on concurrent builds
    print(f"{digest(out)}  {out.name}")


if __name__ == "__main__":
    main()
