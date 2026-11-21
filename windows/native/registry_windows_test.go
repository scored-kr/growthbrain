package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"testing"

	"golang.org/x/sys/windows/registry"
)

func TestUserRegistration(t *testing.T) {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	path := `Software\GrowthBrainNativeTest-` + hex.EncodeToString(nonce[:])
	const manifest = `C:\Users\Test User\com.growthbrain.local.json`
	t.Cleanup(func() { registry.DeleteKey(registry.CURRENT_USER, path) })
	for _, install := range []bool{false, true, true} {
		if err := registerAt(path, manifest, install); err != nil {
			t.Fatal(err)
		}
	}
	key, err := registry.OpenKey(registry.CURRENT_USER, path, registry.ALL_ACCESS|registry.WOW64_32KEY)
	if err != nil {
		t.Fatal(err)
	}
	if err := key.SetStringValue("Preserve", "other settings"); err != nil {
		t.Fatal(err)
	}
	if err := registerAt(path, manifest, false); !errors.Is(err, conflict) {
		t.Fatal("modified registration was removed", err)
	}
	if !matchesValue(key, "Preserve", "other settings") {
		t.Fatal("unrelated setting changed")
	}
	if err := key.DeleteValue("Preserve"); err != nil {
		t.Fatal(err)
	}
	key.Close()
	for i := 0; i < 2; i++ {
		if err := registerAt(path, manifest, false); err != nil {
			t.Fatal(err)
		}
	}
}
