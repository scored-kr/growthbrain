package main

import (
	"errors"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"syscall"
	"testing"
)

func TestVerificationAccessDeniedByWindowsFileACL(t *testing.T) {
	base := t.TempDir()
	if err := install(base, fixture(t, "1", false)); err != nil {
		t.Fatal(err)
	}
	app := filepath.Join(base, "app")
	dir := filepath.Join(app, "dist")
	const name = "test.js"
	path := filepath.Join(dir, name)
	account, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	root := os.Getenv("SystemRoot")
	if !filepath.IsAbs(root) {
		t.Fatal("missing absolute SystemRoot")
	}
	icacls := filepath.Join(root, "System32", "icacls.exe")
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command(icacls, args...)
		cmd.Dir = dir
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("icacls failed: %v\n%s", err, output)
		}
	}
	// Save a single relative filename so /restore targets that same file under dir.
	savedACL := filepath.Join(t.TempDir(), "original.acl")
	run(name, "/save", savedACL)
	t.Cleanup(func() {
		run(".", "/restore", savedACL)
		if err := verifyTree(app); err != nil {
			t.Fatalf("could not verify the preserved installation after restoring the ACL: %v", err)
		}
		data, err := os.ReadFile(path)
		if err != nil || string(data) != "script-1" {
			t.Fatalf("prior installed file was not preserved: %q, %v", data, err)
		}
	})
	// RD denies FILE_READ_DATA only. The owner retains the right to restore the DACL.
	run(name, "/deny", "*"+account.Uid+":(RD)")
	if _, err := os.ReadFile(path); !errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
		t.Fatalf("expected Win32 ERROR_ACCESS_DENIED while reading fixture, got %v", err)
	}
	err = install(base, fixture(t, "2", false))
	checkAccessDenied(t, err, "설치 파일의 무결성을 확인하는 중", name)
	if !errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
		t.Fatalf("lost Win32 ERROR_ACCESS_DENIED: %v", err)
	}
}
