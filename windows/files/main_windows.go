// The storage engine invokes this private helper for Win32 operations unavailable
// in Node's fs API. DPAPI operations exchange bytes through private pipes.
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var invalid = errors.New("unsafe private path")

type account struct {
	user       *windows.SID
	profile    string
	descriptor *windows.SECURITY_DESCRIPTOR
}

func currentAccount() (*account, error) {
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil {
		return nil, err
	}
	profile, err := token.GetUserProfileDirectory()
	if err != nil {
		return nil, err
	}
	sid := user.User.Sid
	// No inherited permissions. Children inherit the same three trusted principals.
	sd, err := windows.SecurityDescriptorFromString("O:" + sid.String() + "D:P(A;OICI;FA;;;" + sid.String() + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if err != nil {
		return nil, err
	}
	return &account{sid, filepath.Clean(profile), sd}, nil
}

func (a *account) trusted(sid *windows.SID) bool {
	return sid != nil && (sid.Equals(a.user) || sid.IsWellKnown(windows.WinLocalSystemSid) || sid.IsWellKnown(windows.WinBuiltinAdministratorsSid))
}

// Ancestors may allow reads. Reject rights that let another account replace the
// directory or change its ACL or children. Private leaves also disallow reads.
func (a *account) checkACL(path string, private bool, requireInheritance bool) error {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil || !a.trusted(owner) {
		return invalid
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil || acl.AceCount == 0 {
		return invalid
	}
	hasChildRule := false
	for i := uint16(0); i < acl.AceCount; i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, uint32(i), &ace); err != nil {
			return err
		}
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return invalid
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if a.trusted(sid) {
			if sid.Equals(a.user) && ace.Header.AceFlags&(windows.OBJECT_INHERIT_ACE|windows.CONTAINER_INHERIT_ACE|windows.NO_PROPAGATE_INHERIT_ACE) == 3 {
				hasChildRule = true
			}
			continue
		}
		// CREATOR OWNER, inherit-only, applies to the owner of the newly created
		// child. It grants no access to this directory or to other accounts.
		if sid.IsWellKnown(windows.WinCreatorOwnerSid) && ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 {
			continue
		}
		const readAndExecute = windows.FILE_GENERIC_READ | windows.FILE_GENERIC_EXECUTE | windows.GENERIC_READ | windows.GENERIC_EXECUTE
		if private || uint32(ace.Mask) & ^uint32(readAndExecute) != 0 {
			return invalid
		}
	}
	if requireInheritance && !hasChildRule {
		return invalid
	}
	return nil
}

func (a *account) inspect(path string, directory, private, create, exclusive bool) error {
	volume := filepath.VolumeName(path)
	if len(volume) != 2 || volume[1] != ':' || strings.ContainsAny(path[2:], ":/") || filepath.Clean(path) != path {
		return invalid
	}
	root, err := windows.UTF16PtrFromString(volume + "\\")
	if err != nil || windows.GetDriveType(root) != windows.DRIVE_FIXED {
		return invalid
	}
	var fs [32]uint16
	if err := windows.GetVolumeInformation(root, nil, 0, nil, nil, nil, &fs[0], uint32(len(fs))); err != nil {
		return err
	}
	if !strings.EqualFold(windows.UTF16ToString(fs[:]), "NTFS") {
		return invalid
	}
	rel, err := filepath.Rel(a.profile, path)
	if err != nil || rel == "." || !filepath.IsLocal(rel) {
		return invalid
	}
	for _, name := range strings.Split(rel, "\\") {
		if strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") {
			return invalid
		}
	}
	// Walk from the physical drive down. Reject junctions, including on the
	// profile itself. ACL validation starts at the system-managed profile root.
	var chain []string
	for p := path; filepath.Dir(p) != p; p = filepath.Dir(p) {
		chain = append(chain, p)
	}
	inside := false
	for i := len(chain) - 1; i >= 0; i-- {
		p := chain[i]
		inside = inside || strings.EqualFold(p, a.profile)
		w, err := windows.UTF16PtrFromString(p)
		if err != nil {
			return err
		}
		attributes, err := windows.GetFileAttributes(w)
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) && inside && create && directory {
			sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: a.descriptor}
			err = windows.CreateDirectory(w, &sa)
			if err != nil && (!errors.Is(err, windows.ERROR_ALREADY_EXISTS) || exclusive && i == 0) {
				return err
			}
			attributes, err = windows.GetFileAttributes(w)
		} else if err == nil && i == 0 && exclusive {
			return windows.ERROR_ALREADY_EXISTS
		}
		if err != nil {
			return err
		}
		if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || (attributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0) != (i > 0 || directory) {
			return invalid
		}
		if inside {
			if err = a.checkACL(p, i == 0 && private, i == 0 && private && directory); err != nil {
				return err
			}
		}
	}
	return nil
}

// The vault owner process receives a non-inheritable delete-on-close handle.
// Windows drops the lock when that process dies even after an unclean shutdown.
func sessionHandle(path string, release string) error {
	parent, err := windows.OpenProcess(windows.PROCESS_DUP_HANDLE, false, uint32(os.Getppid()))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(parent)
	if release != "" {
		raw, err := strconv.ParseUint(release, 10, strconv.IntSize)
		if err != nil {
			return err
		}
		var inspected windows.Handle
		if err = windows.DuplicateHandle(parent, windows.Handle(raw), windows.CurrentProcess(), &inspected, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
			return err
		}
		defer windows.CloseHandle(inspected)
		buf := make([]uint16, 32768)
		n, err := windows.GetFinalPathNameByHandle(inspected, &buf[0], uint32(len(buf)), 8) // FILE_NAME_OPENED
		if err != nil || n >= uint32(len(buf)) || !strings.EqualFold(strings.TrimPrefix(windows.UTF16ToString(buf[:n]), `\\?\`), path) {
			return invalid
		}
		var copy windows.Handle
		if err = windows.DuplicateHandle(parent, windows.Handle(raw), windows.CurrentProcess(), &copy, 0, false, windows.DUPLICATE_SAME_ACCESS|windows.DUPLICATE_CLOSE_SOURCE); err != nil {
			return err
		}
		return windows.CloseHandle(copy)
	}
	w, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(w, windows.DELETE|windows.GENERIC_WRITE|windows.FILE_READ_ATTRIBUTES, 0, nil, windows.CREATE_NEW, windows.FILE_FLAG_DELETE_ON_CLOSE|windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	var remote windows.Handle
	if err = windows.DuplicateHandle(windows.CurrentProcess(), handle, parent, &remote, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		return err
	}
	_, err = fmt.Fprint(os.Stdout, uint64(remote))
	return err
}

func run(args []string) error {
	if len(args) == 1 && (args[0] == "protect-session" || args[0] == "unprotect-session") {
		return protectSession(args[0] == "protect-session", os.Stdin, os.Stdout)
	}
	if len(args) < 2 {
		return invalid
	}
	op, path := args[0], args[1]
	if op == "release" && len(args) == 3 && filepath.Base(path) == "vault.lock" {
		return sessionHandle(path, args[2])
	}
	a, err := currentAccount()
	if err != nil {
		return err
	}
	switch op {
	case "directory", "new-directory":
		return a.inspect(path, true, true, true, op == "new-directory")
	case "private-file", "public-file":
		return a.inspect(path, false, op == "private-file", false, false)
	case "lock":
		if filepath.Base(path) != "vault.lock" {
			return invalid
		}
		if err = a.inspect(filepath.Dir(path), true, true, false, false); err != nil {
			return err
		}
		return sessionHandle(path, "")
	case "move", "replace":
		if len(args) != 3 || !strings.EqualFold(filepath.Dir(path), filepath.Dir(args[2])) {
			return invalid
		}
		if err = a.inspect(filepath.Dir(path), true, true, false, false); err != nil {
			return err
		}
		if err = a.inspect(path, false, true, false, false); err != nil {
			return err
		}
		if err = a.inspect(args[2], false, true, false, false); err != nil && !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			return err
		}
		from, err := windows.UTF16PtrFromString(path)
		if err != nil {
			return err
		}
		to, err := windows.UTF16PtrFromString(args[2])
		if err != nil {
			return err
		}
		flags := uint32(windows.MOVEFILE_WRITE_THROUGH)
		if op == "replace" {
			flags |= windows.MOVEFILE_REPLACE_EXISTING
		}
		return windows.MoveFileEx(from, to, flags)
	}
	return invalid
}
func main() {
	err := run(os.Args[1:])
	if err == nil {
		return
	}
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) || errors.Is(err, windows.ERROR_FILE_EXISTS) {
		os.Exit(2)
	}
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
		os.Exit(3)
	}
	os.Exit(1)
}
