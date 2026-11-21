package main

import (
	"bufio"
	"encoding/json"
	"io"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type child struct {
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	stdout   *bufio.Scanner
	sequence int
	exited   chan struct{}
}

func startChild() (*child, error) {
	path, err := os.Executable()
	if err != nil {
		return nil, err
	}
	root := filepath.Dir(path)
	cmd := exec.Command(filepath.Join(root, "node.exe"), filepath.Join(root, "dist", "desktop-controller.js"))
	cmd.Dir = root
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	// Start the bundled runtime without Node's process-wide injection/debug flags.
	for _, v := range os.Environ() {
		k, _, _ := strings.Cut(v, "=")
		if strings.HasPrefix(strings.ToUpper(k), "NODE_") || strings.HasPrefix(strings.ToUpper(k), "GROWTH_BRAIN_") {
			continue
		}
		cmd.Env = append(cmd.Env, v)
	}
	input, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		input.Close()
		output.Close()
		return nil, err
	}
	reader := bufio.NewScanner(output)
	reader.Buffer(make([]byte, 4096), 2*1024*1024)
	c := &child{cmd: cmd, stdin: input, stdout: reader, exited: make(chan struct{})}
	go func() { cmd.Wait(); close(c.exited) }()
	return c, nil
}
func (c *child) execute(q command) reply {
	c.sequence++
	q = maps.Clone(q)
	q["id"] = c.sequence
	if err := json.NewEncoder(c.stdin).Encode(q); err == nil && c.stdout.Scan() {
		if r, ok := decodeReply(c.stdout.Bytes(), c.sequence); ok {
			return r
		}
	}
	return reply{Error: "DEVICE_UNAVAILABLE"}
}
func (c *child) close() {
	c.stdin.Close()
	select {
	case <-c.exited:
	case <-time.After(10 * time.Second):
		c.cmd.Process.Kill()
		<-c.exited
	}
}
