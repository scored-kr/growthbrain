package main

import (
	"os"
	"syscall"
)

func reparse(s os.FileInfo) bool {
	a, ok := s.Sys().(*syscall.Win32FileAttributeData)
	return !ok || a.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0
}
