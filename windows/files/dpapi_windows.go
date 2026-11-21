package main

import (
	"io"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

const maxSessionBytes = 32 * 1024

// DPAPI's default scope is the signed-in Windows user. A separate purpose
// binds blobs to this application and format. No machine-wide key is used.
func protectSession(seal bool, input io.Reader, output io.Writer) error {
	data, err := io.ReadAll(io.LimitReader(input, maxSessionBytes+1))
	defer clear(data)
	if err != nil || len(data) == 0 || len(data) > maxSessionBytes {
		return invalid
	}
	purpose := []byte("Growth Brain trusted session v1")
	entropy := windows.DataBlob{Size: uint32(len(purpose)), Data: &purpose[0]}
	from := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	var to windows.DataBlob
	if seal {
		err = windows.CryptProtectData(&from, nil, &entropy, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &to)
	} else {
		err = windows.CryptUnprotectData(&from, nil, &entropy, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &to)
	}
	runtime.KeepAlive(purpose)
	if err != nil {
		return invalid
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(to.Data)))
	bytes := unsafe.Slice(to.Data, int(to.Size))
	defer clear(bytes)
	if len(bytes) == 0 || len(bytes) > maxSessionBytes {
		return invalid
	}
	_, err = output.Write(bytes)
	return err
}
