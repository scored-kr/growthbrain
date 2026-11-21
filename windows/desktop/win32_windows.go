// Native controls keep passwords and grants on the local desktop.
package main

import (
	"runtime"
	"syscall"
	"unsafe"
)

var (
	user         = syscall.NewLazyDLL("user32.dll")
	kernel       = syscall.NewLazyDLL("kernel32.dll")
	gdi          = syscall.NewLazyDLL("gdi32.dll")
	shell        = syscall.NewLazyDLL("shell32.dll")
	createWindow = user.NewProc("CreateWindowExW")
	defWindow    = user.NewProc("DefWindowProcW")
	send         = user.NewProc("SendMessageW")
	post         = user.NewProc("PostMessageW")
	setText      = user.NewProc("SetWindowTextW")
	enable       = user.NewProc("EnableWindow")
)

func wide(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }
func ptr(p *uint16) uintptr { return uintptr(unsafe.Pointer(p)) }
func strCall(proc *syscall.LazyProc, h uintptr, s string) uintptr {
	p := wide(s)
	r, _, _ := proc.Call(h, ptr(p))
	runtime.KeepAlive(p)
	return r
}
func messageBox(title, message string, flags uintptr) uintptr {
	p, q := wide(message), wide(title)
	r, _, _ := user.NewProc("MessageBoxW").Call(mainWindow, ptr(p), ptr(q), flags)
	runtime.KeepAlive(p)
	runtime.KeepAlive(q)
	return r
}
func confirm(title, msg string) bool {
	gen := uiGeneration
	return messageBox(title, msg, 0x134) == 6 && gen == uiGeneration && sessionAvailable()
} // YESNO, default No
func openKnown(target string) bool {
	verb, path := wide("open"), wide(target)
	v, _, _ := shell.NewProc("ShellExecuteW").Call(mainWindow, ptr(verb), ptr(path), 0, 0, 1)
	runtime.KeepAlive(verb)
	runtime.KeepAlive(path)
	return v > 32
}

type point struct{ X, Y int32 }
type rect struct{ Left, Top, Right, Bottom int32 }
type msg struct {
	Window  uintptr
	Message uint32
	W, L    uintptr
	Time    uint32
	Pos     point
	Private uint32
}
type windowClass struct {
	Size, Style                   uint32
	Proc                          uintptr
	Extra, WindowExtra            int32
	Instance, Icon, Cursor, Brush uintptr
	Menu, Name                    *uint16
	SmallIcon                     uintptr
}

var mainWindow, instance, font uintptr

func textValue(id int) string {
	h := controls[id]
	n, _, _ := user.NewProc("GetWindowTextLengthW").Call(h)
	b := make([]uint16, int(n)+1)
	user.NewProc("GetWindowTextW").Call(h, uintptr(unsafe.Pointer(&b[0])), n+1)
	return syscall.UTF16ToString(b)
}
func put(id int, v string) { strCall(setText, controls[id], v) }
func usable(id int, yes bool) {
	var b uintptr
	if yes {
		b = 1
	}
	enable.Call(controls[id], b)
}
func selection(id int) int  { i, _, _ := send.Call(controls[id], 0x147, 0, 0); return int(int32(i)) }
func selectIndex(id, i int) { send.Call(controls[id], 0x14e, uintptr(i), 0) }

var listData = map[int][]option{}

type option struct{ key, label string }

func chosen(id int) (option, bool) {
	i := selection(id)
	opts := listData[id]
	if i < 0 || i >= len(opts) {
		return option{}, false
	}
	return opts[i], true
}
func updateList(id int, opts []option, selectFirst bool) {
	current := listData[id]
	same := len(current) == len(opts)
	if same {
		for i := range current {
			if current[i] != opts[i] {
				same = false
				break
			}
		}
	}
	if same {
		return
	}
	old, had := chosen(id)
	idx := -1
	send.Call(controls[id], 0x14b, 0, 0)
	for j, o := range opts {
		p := wide(o.label)
		send.Call(controls[id], 0x143, 0, ptr(p))
		runtime.KeepAlive(p)
		if had && old.key == o.key {
			idx = j
		}
	}
	if idx < 0 && selectFirst && len(opts) > 0 {
		idx = 0
	}
	selectIndex(id, idx)
	listData[id] = opts
}
func newControl(id int, class, title string, style, ext uintptr) {
	c, t := wide(class), wide(title)
	h, _, _ := createWindow.Call(ext, ptr(c), ptr(t), 0x40000000|style, 0, 0, 1, 1, mainWindow, uintptr(id), instance, 0)
	runtime.KeepAlive(c)
	runtime.KeepAlive(t)
	if h == 0 {
		panic("CONTROL_CREATION_FAILED")
	}
	controls[id] = h
	send.Call(h, 0x30, font, 0)
}

type row struct{ id, height int }

var controls = map[int]uintptr{}
var rows []row
var scrollOffset, maxScroll int

type scrollInfo struct {
	Size, Mask uint32
	Min, Max   int32
	Page       uint32
	Pos, Track int32
}

func moveControls() {
	var r rect
	user.NewProc("GetClientRect").Call(mainWindow, uintptr(unsafe.Pointer(&r)))
	width, height := int(r.Right), int(r.Bottom)
	total := 14
	visible := map[int]bool{}
	for _, r := range rows {
		total += r.height + 6
		visible[r.id] = true
	}
	maxScroll = max(0, total+8-height)
	scrollOffset = min(max(0, scrollOffset), maxScroll)
	info := scrollInfo{Mask: 7, Max: int32(total + 7), Page: uint32(height), Pos: int32(scrollOffset)}
	info.Size = uint32(unsafe.Sizeof(info))
	user.NewProc("SetScrollInfo").Call(mainWindow, 1, uintptr(unsafe.Pointer(&info)), 1)
	for id, h := range controls {
		if !visible[id] {
			user.NewProc("ShowWindow").Call(h, 0)
		}
	}
	y := 14 - scrollOffset
	for _, r := range rows {
		h := controls[r.id]
		ctrlHeight := r.height
		if isCombo(r.id) {
			ctrlHeight += 180
		}
		user.NewProc("MoveWindow").Call(h, 12, uintptr(y), uintptr(max(width-24, 1)), uintptr(ctrlHeight), 1)
		user.NewProc("ShowWindow").Call(h, 5)
		y += r.height + 6
	}
}
func runApp() {
	runtime.LockOSThread()
	instance, _, _ = kernel.NewProc("GetModuleHandleW").Call(0)
	cursor, _, _ := user.NewProc("LoadCursorW").Call(0, 32512)
	class := wide("GrowthBrainVaultDesktop")
	wc := windowClass{Proc: syscall.NewCallback(windowProc), Instance: instance, Cursor: cursor, Brush: 16, Name: class}
	wc.Size = uint32(unsafe.Sizeof(wc))
	user.NewProc("RegisterClassExW").Call(uintptr(unsafe.Pointer(&wc)))
	title := wide("Growth Brain")
	mainWindow, _, _ = createWindow.Call(0, ptr(class), ptr(title), 0x00CF0000|0x00200000, 0x80000000, 0, 620, 790, 0, 0, instance, 0)
	runtime.KeepAlive(class)
	runtime.KeepAlive(title)
	if mainWindow == 0 {
		return
	}
	family := wide("Malgun Gothic")
	font, _, _ = gdi.NewProc("CreateFontW").Call(uintptr(^uintptr(15)), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, ptr(family))
	runtime.KeepAlive(family)
	createControls()
	render(true)
	user.NewProc("SetTimer").Call(mainWindow, 1, 2000, 0)
	user.NewProc("ShowWindow").Call(mainWindow, 5)
	user.NewProc("UpdateWindow").Call(mainWindow)
	stopMonitor := startSessionMonitor()
	defer stopMonitor()
	var m msg
	for {
		r, _, _ := user.NewProc("GetMessageW").Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		handled, _, _ := user.NewProc("IsDialogMessageW").Call(mainWindow, uintptr(unsafe.Pointer(&m)))
		if handled == 0 {
			user.NewProc("TranslateMessage").Call(uintptr(unsafe.Pointer(&m)))
			user.NewProc("DispatchMessageW").Call(uintptr(unsafe.Pointer(&m)))
		}
	}
	gdi.NewProc("DeleteObject").Call(font)
}
func windowProc(h uintptr, m uint32, w, l uintptr) uintptr {
	switch m {
	case sessionChanged:
		applySession()
		return 0
	case 0x111: // WM_COMMAND
		if l != 0 && controls[int(w&65535)] == l {
			handleAction(int(w&65535), int(w>>16))
			return 0
		}
	case 0x113: // WM_TIMER
		if !busy && !offline && !inModal {
			dispatch(command{"op": "status"})
		}
		return 0
	case 0x8001:
		select {
		case r := <-responses:
			if r.generation == uiGeneration && sessionAvailable() {
				finish(r.reply)
			}
		default:
		}
		return 0
	case 5:
		if len(rows) > 0 {
			moveControls()
		}
		return 0
	case 0x115:
		switch w & 65535 {
		case 0:
			scrollOffset -= 30
		case 1:
			scrollOffset += 30
		case 2:
			scrollOffset -= 240
		case 3:
			scrollOffset += 240
		case 4, 5:
			scrollOffset = int(w >> 16)
		case 6:
			scrollOffset = 0
		case 7:
			scrollOffset = maxScroll
		}
		moveControls()
		return 0
	case 0x20a:
		scrollOffset -= int(int16(w>>16)) / 120 * 75
		moveControls()
		return 0
	case 0x10:
		user.NewProc("DestroyWindow").Call(h)
		return 0
	case 2:
		user.NewProc("PostQuitMessage").Call(0)
		return 0
	}
	r, _, _ := defWindow.Call(h, uintptr(m), w, l)
	return r
}
