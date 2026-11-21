package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func fixture(t *testing.T, version string, corrupt bool) *zip.Reader {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	inv := inventory{Product: product, Files: map[string]string{}}
	for name, content := range map[string]string{"GrowthBrain.exe": version, "dist/test.js": "script-" + version} {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprint(f, content)
		inv.Files[name] = fmt.Sprintf("%x", sha256.Sum256([]byte(content)))
	}
	if corrupt {
		inv.Files["dist/test.js"] = "00"
	}
	b, _ := json.Marshal(inv)
	f, _ := w.Create(receipt)
	f.Write(b)
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	z, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	return z
}
func TestInstallUpdateRemovePreservesNeighbors(t *testing.T) {
	base := t.TempDir()
	neighbor := filepath.Join(base, "vault.json")
	if err := os.WriteFile(neighbor, []byte("existing"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{"1", "1", "2"} {
		if err := install(base, fixture(t, v, false)); err != nil {
			t.Fatal(err)
		}
		b, _ := os.ReadFile(filepath.Join(base, "app", "GrowthBrain.exe"))
		if string(b) != v {
			t.Fatal("incorrect app version")
		}
	}
	if err := removeApp(base, func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(base, "app")); !os.IsNotExist(err) {
		t.Fatal("app was not removed")
	}
	b, _ := os.ReadFile(neighbor)
	if string(b) != "existing" {
		t.Fatal("unrelated data changed")
	}
}
func TestPreserveOnConflict(t *testing.T) {
	for _, conflict := range []string{"modified", "additional", "folder", "failed-registration", "bad-update", "unowned", "interrupted"} {
		t.Run(conflict, func(t *testing.T) {
			base := t.TempDir()
			if err := install(base, fixture(t, "1", false)); err != nil {
				t.Fatal(err)
			}
			app := filepath.Join(base, "app")
			file := filepath.Join(app, "dist", "test.js")
			var err error
			switch conflict {
			case "modified":
				os.WriteFile(file, []byte("user edit"), 0600)
			case "additional":
				os.WriteFile(filepath.Join(app, "user-note"), []byte("note"), 0600)
			case "folder":
				os.Mkdir(filepath.Join(app, "empty-directory"), 0700)
			case "unowned":
				os.Remove(filepath.Join(app, receipt))
			case "failed-registration":
				err = removeApp(base, func(string) error { return errors.New("conflict") })
				if err == nil {
					t.Fatal("remove accepted")
				}
				if e := verifyTree(app); e != nil {
					t.Fatal(e)
				}
				return
			case "bad-update":
				err = install(base, fixture(t, "2", true))
				if err == nil {
					t.Fatal("corrupted update accepted")
				}
				if e := verifyTree(app); e != nil {
					t.Fatal(e)
				}
				b, _ := os.ReadFile(file)
				if string(b) != "script-1" {
					t.Fatal("lost prior version")
				}
				return
			case "interrupted":
				if err = os.Rename(app, filepath.Join(base, "app.previous")); err != nil {
					t.Fatal(err)
				}
				if err = recoverSwitch(base); err != nil {
					t.Fatal(err)
				}
				if err = verifyTree(app); err != nil {
					t.Fatal(err)
				}
				return
			}
			if e := install(base, fixture(t, "2", false)); e == nil {
				t.Fatal("replaced conflicted app")
			}
			if e := removeApp(base, func(string) error { return nil }); e == nil {
				t.Fatal("removed conflicted app")
			}
			b, e := os.ReadFile(file)
			if e != nil {
				t.Fatal(e)
			}
			if conflict == "modified" && string(b) != "user edit" {
				t.Fatal("changed user edit")
			}
		})
	}
}

// Run the real bundled inventory and directory switch on build hosts before distributing a package.
func TestBundledLifecycle(t *testing.T) {
	path := os.Getenv("GROWTH_BRAIN_TEST_INSTALLER")
	if path == "" {
		t.Skip("no packaged EXE supplied")
	}
	z, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer z.Close()
	base := t.TempDir()
	for range 2 {
		if err := install(base, &z.Reader); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"GrowthBrain.exe", "NativeHost.exe", "node.exe", "growth-brain-route.exe", "dist/growthbrain-files.exe"} {
		f, err := os.Open(filepath.Join(base, "app", filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		var header [2]byte
		_, err = f.Read(header[:])
		f.Close()
		if err != nil || string(header[:]) != "MZ" {
			t.Fatalf("missing Windows executable: %s", name)
		}
	}
	notices, err := os.ReadFile(filepath.Join(base, "app", "licenses", "THIRD-PARTY-NOTICES.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(notices, []byte("zstd/internal/xxhash/LICENSE.txt\n\nCopyright (c) 2016 Caleb Spare")) {
		t.Fatal("missing xxhash package attribution for the bundled zstd implementation")
	}
	if err := removeApp(base, func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
}
