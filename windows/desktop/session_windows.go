package main

import (
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

var wts = syscall.NewLazyDLL("wtsapi32.dll")

const sessionChanged = 0x8002

type sessionGate struct {
	mu         sync.Mutex
	active     bool
	generation uint64
	proc       *child
}

var desktopSession sessionGate
var uiGeneration uint64
var suppressResume bool

// The monitor has its own OS thread. A blocked native file dialog, confirmation
// box, controller RPC or main-window message pump cannot delay loss of access.
func (g *sessionGate) change(active bool) {
	g.mu.Lock()
	if g.active == active && g.generation != 0 {
		g.mu.Unlock()
		return
	}
	g.active = active
	g.generation++
	c := g.proc
	g.proc = nil
	g.mu.Unlock()
	if c != nil {
		// Revocation must take effect even during a blocked network operation.
		// Windows releases private broker sockets and process-owned file handles.
		c.cmd.Process.Kill()
		c.stdin.Close()
	}
	if !active {
		popup, _, _ := user.NewProc("GetLastActivePopup").Call(mainWindow)
		if popup != 0 && popup != mainWindow {
			post.Call(popup, 0x10, 0, 0)
		}
	}
	post.Call(mainWindow, sessionChanged, 0, 0)
}
func (g *sessionGate) snapshot() (uint64, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.generation, g.active
}
func (g *sessionGate) attach(e uint64, c *child) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.active || g.generation != e {
		return false
	}
	g.proc = c
	return true
}
func (g *sessionGate) shutdown() {
	g.mu.Lock()
	c := g.proc
	g.proc = nil
	g.active = false
	g.mu.Unlock()
	if c != nil {
		c.close()
	}
}
func sessionAvailable() bool {
	e, active := desktopSession.snapshot()
	return active && uiGeneration == e
}
func applySession() {
	generation, active := desktopSession.snapshot()
	if generation == uiGeneration {
		return
	}
	uiGeneration = generation
	clearPrivate()
	s = state{}
	queued = nil
	pending = nil
	busy = false
	offline = false
	known = false
	legacyMode = false
	form = "login"
	controller = nil
	notice = ""
	if !active {
		render(true)
		put(banner, "Windows 세션이 잠겨 있거나 세션 보호 상태를 확인할 수 없습니다.")
		return
	}
	c, err := startChild()
	if err != nil {
		offline = true
		render(true)
		return
	}
	if !desktopSession.attach(generation, c) {
		c.close()
		return
	}
	controller = c
	render(true)
	if suppressResume {
		dispatch(command{"op": "status"})
	} else {
		dispatch(command{"op": "accountResume"})
	}
}

// Query this session rather than inferring it from a foreground window or an
// unlock notification. Windows 10+ reports WTSActive=0 and unlocked flags=1.
func activeWindowsSession() bool {
	var data *uint32
	var size uint32
	r, _, _ := wts.NewProc("WTSQuerySessionInformationW").Call(0, 0xffffffff, 25, uintptr(unsafe.Pointer(&data)), uintptr(unsafe.Pointer(&size)))
	if r == 0 || data == nil {
		return false
	}
	defer wts.NewProc("WTSFreeMemory").Call(uintptr(unsafe.Pointer(data)))
	if size < 20 {
		return false
	}
	words := unsafe.Slice(data, 5)
	return words[0] == 1 && words[3] == 0 && words[4] == 1
}
func startSessionMonitor() func() {
	ready := make(chan uintptr, 1)
	done := make(chan struct{})
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(done)
		registered := false
		// A lock event is authoritative. A later polling result cannot undo it;
		// only an actual connect/logon/unlock event plus a positive query can.
		guard := sessionGuard{}
		callback := syscall.NewCallback(func(h uintptr, m uint32, w, l uintptr) uintptr {
			switch m {
			case 0x2b1:
				guard.notify(w)
				desktopSession.change(guard.usable(registered, activeWindowsSession()))
				return 0
			case 0x113:
				if !registered {
					v, _, _ := wts.NewProc("WTSRegisterSessionNotification").Call(h, 0)
					registered = v != 0
				}
				desktopSession.change(guard.usable(registered, activeWindowsSession()))
				return 0
			case 0x10:
				user.NewProc("DestroyWindow").Call(h)
				return 0
			case 2:
				if registered {
					wts.NewProc("WTSUnRegisterSessionNotification").Call(h)
				}
				user.NewProc("PostQuitMessage").Call(0)
				return 0
			}
			r, _, _ := defWindow.Call(h, uintptr(m), w, l)
			return r
		})
		class := wide("GrowthBrainSessionObserver")
		wc := windowClass{Proc: callback, Instance: instance, Name: class}
		wc.Size = uint32(unsafe.Sizeof(wc))
		user.NewProc("RegisterClassExW").Call(uintptr(unsafe.Pointer(&wc)))
		h, _, _ := createWindow.Call(0, ptr(class), 0, 0, 0, 0, 0, 0, 0, 0, instance, 0)
		runtime.KeepAlive(class)
		ready <- h
		if h == 0 {
			desktopSession.change(false)
			return
		}
		send.Call(h, 0x113, 0, 0)
		user.NewProc("SetTimer").Call(h, 1, 2000, 0)
		var m msg
		for {
			v, _, _ := user.NewProc("GetMessageW").Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
			if int32(v) <= 0 {
				break
			}
			user.NewProc("DispatchMessageW").Call(uintptr(unsafe.Pointer(&m)))
		}
	}()
	h := <-ready
	return func() {
		if h != 0 {
			post.Call(h, 0x10, 0, 0)
			<-done
		}
		desktopSession.shutdown()
	}
}
