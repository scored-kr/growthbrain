package main

import (
	"os"
	"runtime"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

// OPENFILENAMEW. Keep all buffers in this call's Go frame through the modal
// dialog. OFN_DONTADDTORECENT avoids adding the recovery file to Recent Items.
type openFileName struct {
	Size                         uint32
	Owner, Instance              uintptr
	Filter, CustomFilter         *uint16
	MaxCustomFilter, FilterIndex uint32
	File                         *uint16
	MaxFile                      uint32
	FileTitle                    *uint16
	MaxFileTitle                 uint32
	InitialDir, Title            *uint16
	Flags                        uint32
	FileOffset, FileExtension    uint16
	DefaultExtension             *uint16
	CustomData, Hook             uintptr
	Template                     *uint16
	Reserved                     uintptr
	ReservedFlags, FlagsEx       uint32
}

func chooseFile(title string, recovery, saving bool) string {
	extension, description := "enc", "Growth Brain 암호화 백업"
	if recovery {
		extension, description = "recovery", "Growth Brain 복구 파일"
	}
	filter := utf16.Encode([]rune(description + "\x00*." + extension + "\x00모든 파일\x00*.*\x00\x00"))
	filename := make([]uint16, 32768)
	dialog := openFileName{Owner: mainWindow, Filter: &filter[0], FilterIndex: 1, File: &filename[0], MaxFile: uint32(len(filename)),
		Title: wide(title), DefaultExtension: wide(extension), Flags: 0x02000000 | 0x80000 | 0x10000 | 0x800 | 0x8 | 0x4}
	if home, err := os.UserHomeDir(); err == nil {
		dialog.InitialDir = wide(home)
	}
	procedure := "GetSaveFileNameW"
	if !saving {
		procedure = "GetOpenFileNameW"
		dialog.Flags |= 0x1000
	}
	dialog.Size = uint32(unsafe.Sizeof(dialog))
	library := syscall.NewLazyDLL("comdlg32.dll")
	ok, _, _ := library.NewProc(procedure).Call(uintptr(unsafe.Pointer(&dialog)))
	runtime.KeepAlive(dialog)
	runtime.KeepAlive(filter)
	if ok != 0 {
		return syscall.UTF16ToString(filename)
	}
	code, _, _ := library.NewProc("CommDlgExtendedError").Call()
	if code != 0 {
		messageBox("파일 선택", "파일 선택 창을 열지 못했습니다. 앱을 다시 실행하세요.", 0x10)
	}
	return ""
}

var selectedBackup, selectedRecovery string

func recoveryMode() string {
	if s.Exists {
		return "unlock"
	}
	choice, ok := chosen(initialMode)
	if !ok {
		return "create"
	}
	return choice.key
}
func recoveryRows(mode string) []row {
	result := ids(initialMode)
	if mode == "restore" || mode == "recover" {
		put(backupSelected, "선택한 암호화 백업: "+selectedBackup)
		result = append(result, ids(chooseBackup, backupSelected)...)
	}
	if mode == "recover" {
		put(recoverySelected, "선택한 복구 파일: "+selectedRecovery)
		result = append(result, ids(chooseRecovery, recoverySelected)...)
	}
	return result
}
func openFromForm() {
	mode := recoveryMode()
	pass := textValue(password)
	if len(utf16.Encode([]rune(pass))) < 12 || ((mode == "create" || mode == "recover") && textValue(repeat) != pass) {
		notice = "12자 이상 비밀번호를 입력하고 확인 칸이 있으면 같은 값을 넣으세요."
		render(false)
		return
	}
	q := command{"op": mode, "password": pass}
	if mode == "restore" || mode == "recover" {
		if selectedBackup == "" || (mode == "recover" && selectedRecovery == "") {
			notice = "복원에 사용할 파일을 먼저 선택하세요."
			render(false)
			return
		}
		q["backupFile"] = selectedBackup
		if mode == "recover" {
			q["recoveryFile"] = selectedRecovery
		}
		if !confirm("이 기기에 금고를 복원할까요?", "선택한 백업을 새 금고로 복원합니다. 백업에 들어 있는 프로젝트와 기억을 다시 사용할 수 있습니다.") {
			return
		}
	}
	put(password, "")
	put(repeat, "")
	dispatch(q)
}
func issueRecoveryFile() {
	pass := textValue(recoveryPassword)
	put(recoveryPassword, "")
	if len(utf16.Encode([]rune(pass))) < 12 {
		notice = "복구 파일 발급에는 현재 금고 비밀번호가 필요합니다."
		render(false)
		return
	}
	if !confirm("복구 파일을 발급할까요?", "이 파일과 발급 후 생성한 백업이 있으면 비밀번호를 몰라도 금고를 복원할 수 있습니다. 기존 복구 파일은 이전 백업을 여전히 열 수 있습니다. 새 파일을 백업과 분리해 안전하게 보관하세요.") {
		return
	}
	path := chooseFile("새 복구 파일 저장 · 백업과 별도인 개인 폴더", true, true)
	if path != "" {
		dispatch(command{"op": "issueRecovery", "password": pass, "file": path})
	}
}
