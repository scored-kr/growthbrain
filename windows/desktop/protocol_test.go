package main

import (
	"strings"
	"testing"
)

func TestSignInBrowserDestination(t *testing.T) {
	for _, url := range []string{"https://login.tailscale.com/a/abc-123_X", "https://login.tailscale.com/f/funnel?node=abc_123"} {
		if !validSignIn(url) {
			t.Error("valid link rejected")
		}
	}
	for _, url := range []string{"https://login.tailscale.com/f/funnel?node=abc&continue=evil", "https://login.tailscale.com/f/funnel?token=abc", "file:///a/secret", "https://other.example/a/id", "https://login.tailscale.com@other.example/a/id", "https://user@login.tailscale.com/a/id", "https://login.tailscale.com/a/id?next=evil", "https://login.tailscale.com/a/id#x", "https://login.tailscale.com/a/x%2Fz", "https://login.tailscale.com:8000/a/id"} {
		if validSignIn(url) {
			t.Errorf("unexpected destination %s", url)
		}
	}
}
func TestConnectionEvidenceIsSpecificToGrantAndMethod(t *testing.T) {
	s := state{}
	c := connection{ID: "selected", Provider: "chatgpt"}
	s.Web.Audit = []auditEntry{{ConnectionID: "other", Method: "get_context", Success: true}, {ConnectionID: "selected", Method: "search_memory", Success: true}, {ConnectionID: "selected", Method: "get_context", Success: false}}
	if !strings.Contains(s.connectionLabel(c), "인증 대기") {
		t.Fatal("approval represented as authenticated or invoked")
	}
	c.Connected = true
	if !strings.Contains(s.connectionLabel(c), "서비스 인증됨") {
		t.Fatal("unrelated or failed evidence used")
	}
	s.Web.Audit = append(s.Web.Audit, auditEntry{ConnectionID: c.ID, Method: "get_context", Success: true})
	if !strings.Contains(s.connectionLabel(c), "조회 확인") {
		t.Fatal("missing observed lookup")
	}
}
func TestWireFormat(t *testing.T) {
	line := []byte(`{"id":42,"ok":true,"result":{"exists":true,"unlocked":true,"web":{"state":"starting","url":null,"signInUrl":"https://login.tailscale.com/a/abcd","requests":[{"id":"r","redirectUri":"https://claude.ai/api/mcp/auth_callback","provider":"claude"}]}}}`)
	r, ok := decodeReply(line, 42)
	if !ok || !r.Result.Unlocked || r.Result.Web.Requests[0].RedirectURI == "" || !validSignIn(r.Result.Web.SignInURL) {
		t.Fatal("unexpected field mapping")
	}
	if _, ok = decodeReply(line, 41); ok {
		t.Fatal("incorrect request accepted")
	}
}

func TestSessionProtectionRequiresWorkingOSNotificationAndUnlockedSession(t *testing.T) {
	for _, loss := range []uintptr{2, 4, 6, 7} {
		g := sessionGuard{}
		if g.usable(false, true) || g.usable(true, false) {
			t.Fatal("opened despite registration or OS state failure")
		}
		g.notify(loss)
		if g.usable(true, true) {
			t.Fatalf("loss event %d undone by polling", loss)
		}
		g.notify(9)
		if g.usable(true, true) {
			t.Fatal("unrelated event reactivated trust")
		}
		g.notify(8)
		if g.usable(true, false) || !g.usable(true, true) {
			t.Fatal("unlock must recheck actual OS state")
		}
	}
}
func TestPreviewShowsEffectiveValuesAndCurrentHandoffOnly(t *testing.T) {
	line := []byte(`{"id":7,"ok":true,"result":{"unlocked":true,"account":{"signedIn":true,"sync":"synced","email":"test@example.invalid"}},"preview":{"conditions":[{"key":"format","value":"table","source":"private-original"}],"handoff":{"goal":"resume","completed":[{"claim":"checked","evidence":"private-original"}],"nextActions":["compare"]}}}`)
	reply, ok := decodeReply(line, 7)
	if !ok || !reply.Result.Account.SignedIn || reply.Preview == nil {
		t.Fatal("account wire decoding failed")
	}
	display := reply.Preview.text()
	if strings.Contains(display, "private-original") || !strings.Contains(display, "table") || !strings.Contains(display, "compare") {
		t.Fatal("bad preview disclosure or missing baseline")
	}
}
