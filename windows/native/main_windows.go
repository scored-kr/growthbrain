// Growth Brain's per-user Chrome native messaging launcher.
package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

const manifestName = "com.growthbrain.local.json"

//go:embed com.growthbrain.local.json
var expectedManifest []byte

func run() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	dir := filepath.Dir(exe)
	manifest := filepath.Join(dir, manifestName)
	if len(os.Args) == 2 && os.Args[1] == "--unregister" {
		return registration(manifest, false)
	}
	data, err := os.ReadFile(manifest)
	if err != nil || !bytes.Equal(data, expectedManifest) {
		return errors.New("modified native host manifest")
	}
	if len(os.Args) == 2 && os.Args[1] == "--register" {
		return registration(manifest, true)
	}
	var host struct {
		Origins []string `json:"allowed_origins"`
	}
	if json.Unmarshal(data, &host) != nil || len(host.Origins) != 1 || len(os.Args) < 2 || os.Args[1] != host.Origins[0] {
		return errors.New("extension origin refused")
	}
	profile, err := os.UserCacheDir()
	if err != nil || !filepath.IsAbs(profile) {
		return errors.New("missing user profile")
	}
	cmd := exec.Command(filepath.Join(dir, "node.exe"), filepath.Join(dir, "dist", "native-host.js"), host.Origins[0])
	cmd.Dir = dir
	cmd.Stdin, cmd.Stdout = os.Stdin, os.Stdout
	id := strings.TrimSuffix(strings.TrimPrefix(host.Origins[0], "chrome-extension://"), "/")
	cmd.Env = append(os.Environ(), "GROWTH_BRAIN_EXTENSION_ID="+id, "GROWTH_BRAIN_SOCKET="+filepath.Join(profile, "GrowthBrain", "active", "memory.sock"))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Run()
}

func main() {
	if run() != nil {
		// Chrome reserves stdout for native framing; never print messages or data.
		os.Exit(1)
	}
}
