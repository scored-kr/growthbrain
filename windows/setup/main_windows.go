package main

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

var payloadSHA, payloadSize string
var user32 = syscall.NewLazyDLL("user32.dll")

func message(body string, style uintptr) int {
	caption, _ := syscall.UTF16PtrFromString("Growth Brain 설치")
	msg, _ := syscall.UTF16PtrFromString(body)
	v, _, _ := user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(msg)), uintptr(unsafe.Pointer(caption)), style|0x10000)
	return int(v)
}

func loadPayload() (*os.File, *zip.Reader, error) {
	path, err := os.Executable()
	if err != nil {
		return nil, nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	closeError := func(e error) (*os.File, *zip.Reader, error) { f.Close(); return nil, nil, e }
	st, err := f.Stat()
	if err != nil {
		return closeError(err)
	}
	size, err := strconv.ParseInt(payloadSize, 10, 64)
	if err != nil || size <= 0 || size >= st.Size() {
		return closeError(errors.New("설치 파일 크기가 올바르지 않습니다."))
	}
	data := io.NewSectionReader(f, st.Size()-size, size)
	digest, err := checksum(data)
	if err != nil {
		return closeError(err)
	}
	if digest != payloadSHA {
		return closeError(errors.New("설치 파일이 손상되었습니다. 설치 파일을 다시 받아주세요."))
	}
	z, err := zip.NewReader(data, size)
	if err != nil {
		return closeError(err)
	}
	return f, z, nil
}

// Use absolute system program locations, not the user's current directory or PATH.
func hidden(path string, args ...string) *exec.Cmd {
	cmd := exec.Command(path, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd
}

const shortcutScript = `
$ErrorActionPreference = 'Stop'
$folder = [Environment]::GetFolderPath('Programs')
if (-not $folder) { throw 'Missing Start Menu' }
$link = Join-Path $folder 'Growth Brain.lnk'
$creator = New-Object -ComObject WScript.Shell
if (Test-Path -LiteralPath $link) {
  $item = Get-Item -Force -LiteralPath $link
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Shortcut conflict' }
  $s = $creator.CreateShortcut($link)
  if ($s.TargetPath -ne $env:GB_APP_TARGET -or $s.Arguments -ne '' -or $s.Description -ne 'Growth Brain desktop') { throw 'Shortcut conflict' }
  if ($env:GB_LINK_MODE -eq 'remove') { [IO.File]::Delete($link) }
} elseif ($env:GB_LINK_MODE -eq 'install') {
  $temp = Join-Path $folder (('GrowthBrain-' + [guid]::NewGuid()) + '.lnk')
  try {
    $s = $creator.CreateShortcut($temp)
    $s.TargetPath = $env:GB_APP_TARGET
    $s.Description = 'Growth Brain desktop'
    $s.WorkingDirectory = [IO.Path]::GetDirectoryName($env:GB_APP_TARGET)
    $s.Save()
    [IO.File]::Move($temp, $link)
  } finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
}
`

func shortcut(mode, app string) error {
	ps := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	cmd := hidden(ps, "-NoProfile", "-NonInteractive", "-Command", shortcutScript)
	cmd.Env = append(os.Environ(), "GB_APP_TARGET="+app, "GB_LINK_MODE="+mode)
	if err := cmd.Run(); err != nil {
		return errors.New("시작 메뉴 바로 가기를 확인할 수 없습니다. 기존 바로 가기 및 조직 정책을 확인한 뒤 설치 파일을 다시 실행하세요.")
	}
	return nil
}

func prepare() (string, error) {
	data := os.Getenv("LOCALAPPDATA")
	if !filepath.IsAbs(data) {
		return "", errors.New("사용자의 로컬 앱 폴더를 찾을 수 없습니다.")
	}
	if err := normal(data, true); err != nil {
		return "", err
	}
	programs := filepath.Join(data, "Programs")
	if err := os.Mkdir(programs, 0700); err != nil && !os.IsExist(err) {
		return "", err
	}
	if err := normal(programs, true); err != nil {
		return "", err
	}
	base := filepath.Join(programs, "GrowthBrain")
	marker := filepath.Join(base, ".growthbrain-setup-owner")
	err := os.Mkdir(base, 0700)
	if err == nil {
		err = os.WriteFile(marker, []byte(product), 0600)
	} else if os.IsExist(err) {
		if err = normal(base, true); err != nil {
			return "", err
		}
		if err = normal(marker, false); err != nil {
			return "", errors.New("같은 이름의 기존 폴더를 보존했습니다. 설치 소유 정보를 확인할 수 없습니다.")
		}
		var bytes []byte
		bytes, err = os.ReadFile(marker)
		if err == nil && string(bytes) != product {
			err = errors.New("기존 설치 폴더의 소유 정보를 확인할 수 없습니다.")
		}
	}
	return base, err
}

func run() error {
	f, z, err := loadPayload()
	if err != nil {
		return err
	}
	defer f.Close()
	if len(os.Args) == 3 && os.Args[1] == "--smoke-test" {
		tmp := os.Args[2]
		if !filepath.IsAbs(tmp) {
			return errors.New("absolute temporary path required")
		}
		if e := os.Mkdir(tmp, 0700); e != nil {
			return e
		}
		return install(tmp, z)
	}
	if len(os.Args) == 2 && os.Args[1] == "--smoke-test" {
		tmp, e := os.MkdirTemp("", "gb-setup-smoke-")
		if e != nil {
			return e
		}
		defer os.RemoveAll(tmp)
		for range 2 {
			if e = install(tmp, z); e != nil {
				return e
			}
		}
		if e = hidden(filepath.Join(tmp, "app", "node.exe"), "-e", "if (process.platform!=='win32'||Number(process.versions.node.split('.')[0])<24) process.exit(1)").Run(); e != nil {
			return e
		}
		return removeApp(tmp, func(string) error { return nil })
	}
	if len(os.Args) != 1 {
		return errors.New("지원하지 않는 설치 옵션입니다.")
	}
	choice := message("설치하거나 업데이트하려면 [예]를 선택하세요.\n이미 설치한 앱을 제거하려면 [아니요]를 선택하세요.\n\n설치하거나 제거하기 전에 Growth Brain 창을 닫으세요.", 3|0x20)
	if choice != 6 && choice != 7 {
		return nil
	}
	if choice == 7 && message("Growth Brain 앱을 제거할까요? 암호화 금고와 백업은 기기에 보존됩니다.", 4|0x24|0x100) != 6 {
		return nil
	}
	base, err := prepare()
	if err != nil {
		return err
	}
	lockName := filepath.Join(base, ".setup.lock")
	lockPath, err := syscall.UTF16PtrFromString(lockName)
	if err != nil {
		return err
	}
	// CREATE_NEW never overwrites a pre-existing lock file. Windows removes our lock on process exit.
	lock, err := syscall.CreateFile(lockPath, syscall.GENERIC_WRITE|0x10000, 0, nil, syscall.CREATE_NEW, 0x04000000, 0)
	if err != nil {
		return errors.New("다른 설치가 진행 중이거나 설치 경로에 접근할 수 없습니다.")
	}
	defer syscall.CloseHandle(lock)
	app := filepath.Join(base, "app", "GrowthBrain.exe")
	if err = shortcut("check", app); err != nil {
		return err
	}
	if choice == 7 {
		if err = removeApp(base, func(path string) error {
			if err := hidden(filepath.Join(path, "NativeHost.exe"), "--unregister").Run(); err != nil {
				return errors.New("브라우저 연결 등록이 변경됐거나 해제할 수 없습니다. 기존 설치를 보존했습니다.")
			}
			return shortcut("remove", app)
		}); err != nil {
			return err
		}
		message("앱을 제거했습니다. 금고는 사용자 폴더에 보존되어 있습니다.", 0x40)
		return nil
	}
	if err = install(base, z); err != nil {
		return err
	}
	if err = shortcut("install", app); err != nil {
		return err
	}
	if message("설치가 끝났습니다. 지금 Growth Brain을 열까요? 시작 메뉴에서도 열 수 있습니다.", 4|0x40) == 6 {
		cmd := exec.Command(app)
		cmd.Dir = filepath.Dir(app)
		return cmd.Start()
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		if len(os.Args) == 1 {
			message("작업을 마치지 못했습니다.\n\n"+strings.TrimSpace(fmt.Sprint(err)), 0x10)
		}
		os.Exit(1)
	}
}
