package main

import (
	"errors"
	"path/filepath"
	"syscall"
	"unicode/utf16"

	"golang.org/x/sys/windows/registry"
)

const (
	regPath    = `SOFTWARE\Google\Chrome\NativeMessagingHosts\com.growthbrain.local`
	ownerName  = "GrowthBrainRegistration"
	ownerValue = "GrowthBrain Windows native host v1"
)

var conflict = errors.New("existing native registration preserved")

// Compare the complete REG_SZ, including the terminator. User edits or appended
// data make the entry ineligible for removal.
func matchesValue(key registry.Key, name, expected string) bool {
	text := append(utf16.Encode([]rune(expected)), 0)
	buf := make([]byte, len(text)*2)
	n, kind, err := key.GetValue(name, buf)
	if err != nil || kind != registry.SZ || n != len(buf) {
		return false
	}
	for i, u := range text {
		if buf[i*2] != byte(u) || buf[i*2+1] != byte(u>>8) {
			return false
		}
	}
	return true
}

func exactRegistration(key registry.Key, manifest string) bool {
	info, err := key.Stat()
	return err == nil && info.SubKeyCount == 0 && info.ValueCount == 2 &&
		matchesValue(key, "", manifest) && matchesValue(key, ownerName, ownerValue)
}

func missing(err error) bool {
	return errors.Is(err, registry.ErrNotExist) || errors.Is(err, syscall.ERROR_PATH_NOT_FOUND)
}

func registration(manifest string, install bool) error {
	return registerAt(regPath, manifest, install)
}

func registerAt(path, manifest string, install bool) error {
	const view = registry.WOW64_32KEY
	// Never shadow an unrelated host in either machine view or user view.
	if install {
		for _, machineView := range []uint32{view, registry.WOW64_64KEY} {
			key, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.READ|machineView)
			if err == nil {
				key.Close()
				return conflict
			}
			if !missing(err) {
				return err
			}
		}
		other, err := registry.OpenKey(registry.CURRENT_USER, path, registry.READ|registry.WOW64_64KEY)
		if err == nil {
			// HKCU Software views can alias.
			matches := exactRegistration(other, manifest)
			other.Close()
			if !matches {
				return conflict
			}
		} else if !missing(err) {
			return err
		}
	}
	key, err := registry.OpenKey(registry.CURRENT_USER, path, registry.READ|view)
	if missing(err) {
		if !install {
			return nil
		}
		key, exists, err := registry.CreateKey(registry.CURRENT_USER, path, registry.WRITE|view)
		if err != nil {
			return err
		}
		defer key.Close()
		if exists {
			return conflict
		} // Concurrent registration.
		if err := key.SetStringValue(ownerName, ownerValue); err != nil {
			return err
		}
		return key.SetStringValue("", manifest)
	}
	if err != nil {
		return err
	}
	defer key.Close()
	if !exactRegistration(key, manifest) {
		// An install that never opted into browser capture can still be removed
		// when an unrelated host exists. Never unlink a modified owned entry.
		if !install && !matchesValue(key, ownerName, ownerValue) && !matchesValue(key, "", manifest) {
			return nil
		}
		return conflict
	}
	if install {
		return nil
	}
	parent, err := registry.OpenKey(registry.CURRENT_USER, filepath.Dir(path), registry.WRITE|view)
	if err != nil {
		return err
	}
	defer parent.Close()
	return registry.DeleteKey(parent, filepath.Base(path))
}
