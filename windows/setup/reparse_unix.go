//go:build !windows

package main

import "os"

func reparse(os.FileInfo) bool { return false }
