package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

const ownerMarker = "Growth Brain desktop owner v1\n"

var ownerFile *os.File
var alreadyRunning = errors.New("DESKTOP_ALREADY_OPEN")

// One account owner per Windows profile, including different Terminal Services
// sessions. No child may touch credentials before acquiring this kernel handle.
func acquireDesktop() (*os.File, bool, error) {
	directory := os.Getenv("LOCALAPPDATA")
	if !filepath.IsAbs(directory) {
		return nil, false, errors.New("LOCAL_PROFILE_REQUIRED")
	}
	path := filepath.Join(directory, ".growthbrain-desktop-owner.v1")
	flags := uint32(syscall.FILE_FLAG_OPEN_REPARSE_POINT | syscall.FILE_ATTRIBUTE_HIDDEN)
	open := func(mode uint32) (syscall.Handle, error) {
		return syscall.CreateFile(wide(path), syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, mode, flags, 0)
	}
	h, e := open(syscall.CREATE_NEW)
	created := e == nil
	if errors.Is(e, syscall.ERROR_FILE_EXISTS) || errors.Is(e, syscall.ERROR_ALREADY_EXISTS) {
		h, e = open(syscall.OPEN_EXISTING)
	}
	if e != nil {
		if errors.Is(e, syscall.Errno(32)) {
			e = alreadyRunning
		}
		return nil, false, e
	}
	f := os.NewFile(uintptr(h), path)
	var info syscall.ByHandleFileInformation
	if e := syscall.GetFileInformationByHandle(h, &info); e != nil || info.FileAttributes&(syscall.FILE_ATTRIBUTE_DIRECTORY|syscall.FILE_ATTRIBUTE_REPARSE_POINT) != 0 || info.NumberOfLinks != 1 {
		f.Close()
		return nil, false, errors.New("UNSAFE_PROFILE_FILE")
	}
	if created {
		if _, e = f.WriteString(ownerMarker + "0"); e == nil {
			e = f.Sync()
		}
		if e != nil {
			f.Close()
			return nil, false, e
		}
		return f, false, nil
	}
	b, e := io.ReadAll(io.LimitReader(f, int64(len(ownerMarker)+2)))
	if e != nil || (string(b) != ownerMarker+"0" && string(b) != ownerMarker+"1") {
		f.Close()
		return nil, false, errors.New("UNRECOGNIZED_PROFILE_FILE")
	}
	return f, b[len(b)-1] == '1', nil
}

// Persist the user's explicit choice before an operation that can block on a
// network request. The OS may lock, disconnect or end the process in the meantime.
func rememberLock(required bool) error {
	flag := byte('0')
	if required {
		flag = '1'
	}
	if _, e := ownerFile.WriteAt([]byte{flag}, int64(len(ownerMarker))); e != nil {
		return e
	}
	return ownerFile.Sync()
}
