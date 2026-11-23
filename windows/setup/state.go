package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const receipt = ".growthbrain-installed.json"
const product = "scored-kr/growthbrain/windows-x64/v1"

type inventory struct {
	Product string            `json:"product"`
	Files   map[string]string `json:"files"`
}

type fileAccessDenied struct {
	action string
	cause  error
}

func (e *fileAccessDenied) Unwrap() error { return e.cause }

func (e *fileAccessDenied) Error() string {
	target := ""
	var pathErr *fs.PathError
	if errors.As(e.cause, &pathErr) && pathErr.Path != "" {
		target = fmt.Sprintf(" ‘%s’에 대한", filepath.Base(pathErr.Path))
	}
	return e.action + target + " 접근이 거부되었습니다.\n\n사용 중인 보안 프로그램의 검사 기록을 확인하세요. 격리된 항목이 있으면 그대로 두세요."
}

func explainAccessDenied(action string, err error) error {
	if errors.Is(err, fs.ErrPermission) {
		return &fileAccessDenied{action, err}
	}
	return err
}

func checksum(r io.Reader) (string, error) {
	h := sha256.New()
	if _, err := io.Copy(h, r); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func normal(path string, directory bool) error {
	s, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if s.Mode()&os.ModeSymlink != 0 || reparse(s) || (directory && !s.IsDir()) || (!directory && !s.Mode().IsRegular()) {
		return errors.New("일반 파일 또는 폴더가 아닌 설치 경로가 있습니다. 기존 파일을 보존했습니다.")
	}
	return nil
}

func verifyTree(root string) (result error) {
	defer func() { result = explainAccessDenied("설치 파일의 무결성을 확인하는 중", result) }()
	if err := normal(root, true); err != nil {
		return err
	}
	record := filepath.Join(root, receipt)
	if err := normal(record, false); err != nil {
		return err
	}
	b, err := os.ReadFile(record)
	if err != nil {
		return err
	}
	var inv inventory
	if json.Unmarshal(b, &inv) != nil || inv.Product != product || inv.Files["GrowthBrain.exe"] == "" {
		return errors.New("Growth Brain 설치 기록을 확인할 수 없습니다.")
	}
	dirs := map[string]bool{".": true}
	for path := range inv.Files {
		if !fs.ValidPath(path) || !filepath.IsLocal(path) || strings.ContainsAny(path, "\\:") {
			return errors.New("설치 기록의 경로가 올바르지 않습니다.")
		}
		for dir := filepath.ToSlash(filepath.Dir(path)); !dirs[dir]; dir = filepath.ToSlash(filepath.Dir(dir)) {
			dirs[dir] = true
		}
	}
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		rel, e := filepath.Rel(root, path)
		if e != nil {
			return e
		}
		rel = filepath.ToSlash(rel)
		if e = normal(path, d.IsDir()); e != nil {
			return e
		}
		if d.IsDir() {
			if !dirs[rel] {
				return fmt.Errorf("추가된 폴더를 보존했습니다: %s", rel)
			}
			return nil
		}
		if rel == receipt {
			return nil
		}
		expected, ok := inv.Files[rel]
		if !ok {
			return fmt.Errorf("추가된 파일을 보존했습니다: %s", rel)
		}
		f, e := os.Open(path)
		if e != nil {
			return e
		}
		actual, e := checksum(f)
		f.Close()
		if e != nil {
			return e
		}
		if actual != expected {
			return fmt.Errorf("수정된 파일을 보존했습니다: %s", rel)
		}
		delete(inv.Files, rel)
		return nil
	})
	if err != nil {
		return err
	}
	if len(inv.Files) != 0 {
		return errors.New("설치 파일 일부가 없습니다. 기존 설치 폴더를 보존했습니다.")
	}
	return nil
}

func extract(z *zip.Reader, dst string) error {
	for _, item := range z.File {
		name := item.Name
		if !fs.ValidPath(name) || !filepath.IsLocal(name) || strings.ContainsAny(name, "\\:") || !item.Mode().IsRegular() {
			return errors.New("설치 파일 경로를 확인할 수 없습니다.")
		}
		path := filepath.Join(dst, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		src, err := item.Open()
		if err != nil {
			f.Close()
			return err
		}
		_, err = io.Copy(f, src)
		src.Close()
		closeErr := f.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

// app.previous is the last complete installation while a directory switch is in progress.
// A path is retired only after its inventory exactly matches its contents.
func recoverSwitch(base string) error {
	prev := filepath.Join(base, "app.previous")
	current := filepath.Join(base, "app")
	if _, err := os.Lstat(prev); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	if err := verifyTree(prev); err != nil {
		return err
	}
	if _, err := os.Lstat(current); os.IsNotExist(err) {
		return os.Rename(prev, current)
	} else if err != nil {
		return err
	}
	if err := verifyTree(current); err != nil {
		return err
	}
	return os.RemoveAll(prev)
}

func install(base string, payload *zip.Reader) error {
	if err := recoverSwitch(base); err != nil {
		return err
	}
	current := filepath.Join(base, "app")
	prev := filepath.Join(base, "app.previous")
	_, err := os.Lstat(current)
	exists := err == nil
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if exists {
		if err := verifyTree(current); err != nil {
			return err
		}
	}
	tmp, err := os.MkdirTemp(base, ".install-")
	if err != nil {
		return explainAccessDenied("설치 폴더를 준비하는 중", err)
	}
	defer os.RemoveAll(tmp) // private staging directory created by this invocation
	if err = extract(payload, tmp); err != nil {
		return explainAccessDenied("설치 파일을 준비하는 중", err)
	}
	if err = verifyTree(tmp); err != nil {
		return err
	}
	if exists {
		if err = os.Rename(current, prev); err != nil {
			return err
		}
	}
	if err = os.Rename(tmp, current); err != nil {
		if exists {
			if restore := os.Rename(prev, current); restore != nil {
				return errors.Join(err, restore)
			}
		}
		return err
	}
	if exists {
		return recoverSwitch(base)
	}
	return nil
}

func removeApp(base string, before func(string) error) error {
	if err := recoverSwitch(base); err != nil {
		return err
	}
	current := filepath.Join(base, "app")
	if err := verifyTree(current); err != nil {
		return err
	}
	if err := before(current); err != nil {
		return err
	}
	// Renaming first prevents partial removal from looking like an available application.
	// A unique tombstone leaves unrelated or interrupted earlier removals untouched.
	tomb, err := os.MkdirTemp(base, ".remove-")
	if err != nil {
		return err
	}
	moved := filepath.Join(tomb, "app")
	if err = os.Rename(current, moved); err != nil {
		os.Remove(tomb)
		return err
	}
	return os.RemoveAll(tomb)
}
