// growth-brain-route is a per-user device helper. Its stdout is a private pipe
// to the parent, never a terminal or log. It accepts only the loopback port of
// the device's HTTPS server; public connections cannot choose a destination.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"tailscale.com/feature/buildfeatures"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
)

type event struct {
	Type   string `json:"type"`
	Code   string `json:"code,omitempty"`
	URL    string `json:"url,omitempty"`
	Origin string `json:"origin,omitempty"`
	Cert   []byte `json:"cert,omitempty"`
	Key    []byte `json:"key,omitempty"`
}

type command struct {
	StateDir string `json:"stateDir"`
	Port     int    `json:"port"`
	DeviceID string `json:"deviceId"`
	AuthKey  string `json:"authKey"`
}

var grantURL = regexp.MustCompile(`^https://login\.tailscale\.com/f/funnel\?node=[a-zA-Z0-9_-]+$`)

func main() {
	// Refuse direct terminal execution, including redirection to a regular file.
	for _, pipe := range []*os.File{os.Stdin, os.Stdout} {
		st, err := pipe.Stat()
		if err != nil || st.Mode()&(os.ModeNamedPipe|os.ModeSocket) == 0 {
			return
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	commands := make(chan command)
	go func() {
		defer func() {
			cancel()
			// Parent disappearance must stop public ingress even if a provider
			// operation is waiting internally without our cancellation context.
			time.AfterFunc(4*time.Second, func() { os.Exit(0) })
		}()
		s := bufio.NewScanner(os.Stdin)
		for s.Scan() {
			var c command
			if json.Unmarshal(s.Bytes(), &c) != nil {
				return
			}
			select {
			case commands <- c:
			case <-ctx.Done():
				return
			}
		}
	}()
	var mu sync.Mutex
	enc := json.NewEncoder(os.Stdout)
	send := func(e event) {
		mu.Lock()
		defer mu.Unlock()
		if enc.Encode(e) != nil {
			cancel()
		}
	}
	if errCode := run(ctx, commands, send); errCode != "" {
		send(event{Type: "error", Code: errCode})
		os.Exit(1)
	}
}

var deviceID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var deviceKey = regexp.MustCompile(`^tskey-auth-[A-Za-z0-9_-]{12,256}$`)

// Reuse only this installation's existing tsnet identity. An expired identity
// re-enrolls through the verified account and never offers an operator login.
func managedServer(ctx context.Context, setup command, commands <-chan command, send func(event)) (*tsnet.Server, string) {
	if !deviceID.MatchString(setup.DeviceID) {
		return nil, "ROUTE_UNAVAILABLE"
	}
	makeServer := func(key string) *tsnet.Server {
		quiet := func(string, ...any) {}
		return &tsnet.Server{Dir: setup.StateDir, Hostname: "gb-" + setup.DeviceID, AuthKey: key, Ephemeral: true, Logf: quiet, UserLogf: quiet}
	}
	_, statErr := os.Lstat(filepath.Join(setup.StateDir, "tailscaled.state"))
	if statErr == nil {
		existing := makeServer("")
		lc, err := existing.LocalClient()
		if err != nil {
			return nil, "ROUTE_UNAVAILABLE"
		}
		poll := time.NewTicker(time.Second)
		defer poll.Stop()
		for {
			st, err := lc.Status(ctx)
			if err == nil {
				switch st.BackendState {
				case "Running":
					return existing, ""
				case "NeedsMachineAuth":
					existing.Close()
					return nil, "ROUTE_POLICY_BLOCKED"
				}
				if st.BackendState == "NeedsLogin" {
					break
				}
			}
			select {
			case <-ctx.Done():
				existing.Close()
				return nil, "ROUTE_OFFLINE"
			case <-poll.C:
			}
		}
		existing.Close()
	} else if !os.IsNotExist(statErr) {
		return nil, "ROUTE_UNAVAILABLE"
	}
	send(event{Type: "enroll"})
	select {
	case <-ctx.Done():
		return nil, "ROUTE_OFFLINE"
	case grant := <-commands:
		if !deviceKey.MatchString(grant.AuthKey) || grant.Port != 0 || grant.StateDir != "" || grant.DeviceID != "" {
			return nil, "ROUTE_ENROLLMENT_UNAVAILABLE"
		}
		return makeServer(grant.AuthKey), ""
	}
}

func run(ctx context.Context, commands <-chan command, send func(event)) string {
	if buildfeatures.HasLogTail {
		return "ROUTE_UNAVAILABLE"
	}
	var setup command
	select {
	case setup = <-commands:
	case <-ctx.Done():
		return ""
	}
	if setup.StateDir == "" || setup.Port != 0 || setup.AuthKey != "" {
		return "ROUTE_UNAVAILABLE"
	}
	quiet := func(string, ...any) {}
	srv := &tsnet.Server{Dir: setup.StateDir, Hostname: "growth-brain", Logf: quiet, UserLogf: quiet}
	managed := setup.DeviceID != ""
	if managed {
		enrollCtx, cancelEnroll := context.WithTimeout(ctx, 45*time.Second)
		var code string
		srv, code = managedServer(enrollCtx, setup, commands, send)
		cancelEnroll()
		if code != "" {
			return code
		}
	}
	lc, err := srv.LocalClient()
	if err != nil {
		return "ROUTE_UNAVAILABLE"
	}
	defer srv.Close()
	authCtx, stopAuth := context.WithTimeout(ctx, 8*time.Minute)
	defer stopAuth()
	go func() {
		if managed {
			return
		}
		lastURL := ""
		timer := time.NewTicker(2 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-authCtx.Done():
				return
			case <-timer.C:
			}
			st, err := lc.Status(authCtx)
			if err != nil || st.AuthURL == "" || st.AuthURL == lastURL {
				continue
			}
			u, err := url.Parse(st.AuthURL)
			if err == nil && u.Scheme == "https" && u.Host == "login.tailscale.com" && u.User == nil && strings.HasPrefix(u.Path, "/a/") {
				lastURL = st.AuthURL
				send(event{Type: "login", URL: lastURL})
			}
		}
	}()
	st, err := srv.Up(authCtx)
	stopAuth()
	if err != nil {
		return "ROUTE_OFFLINE"
	}
	allowed := func(s *ipnstate.Status) bool {
		return s.Self != nil && len(s.CertDomains) > 0 && ipn.CheckFunnelAccess(443, s.Self) == nil
	}
	if managed && (st.Self == nil || st.Self.Tags == nil || st.Self.Tags.Len() != 1 || st.Self.Tags.At(0) != "tag:growthbrain-device") {
		return "ROUTE_POLICY_BLOCKED"
	}
	if !allowed(st) {
		if managed {
			return "ROUTE_POLICY_BLOCKED"
		}
		grantCtx, cancelGrant := context.WithTimeout(ctx, 5*time.Minute)
		defer cancelGrant()
		grant, err := lc.QueryFeature(grantCtx, "funnel")
		if err != nil || !grant.ShouldWait || !grantURL.MatchString(grant.URL) {
			return "ROUTE_POLICY_BLOCKED"
		}
		send(event{Type: "login", URL: grant.URL})
		poll := time.NewTicker(2 * time.Second)
		defer poll.Stop()
		for !allowed(st) {
			select {
			case <-grantCtx.Done():
				return "ROUTE_POLICY_BLOCKED"
			case <-poll.C:
			}
			st, err = lc.Status(grantCtx)
			if err != nil {
				return "ROUTE_OFFLINE"
			}
		}
	}
	name := strings.TrimSuffix(st.CertDomains[0], ".")
	if !strings.HasSuffix(name, ".ts.net") {
		return "ROUTE_POLICY_BLOCKED"
	}
	issue := func() bool {
		certCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		cert, key, err := lc.CertPairWithValidity(certCtx, name, 24*time.Hour)
		if err != nil {
			return false
		}
		defer clear(key)
		send(event{Type: "certificate", Origin: "https://" + name, Cert: cert, Key: key})
		return true
	}
	if !issue() {
		return "ROUTE_CERTIFICATE"
	}
	var bind command
	select {
	case <-ctx.Done():
		return ""
	case bind = <-commands:
	}
	if bind.StateDir != "" || bind.AuthKey != "" || bind.DeviceID != "" || bind.Port <= 0 || bind.Port > 65535 {
		return "ROUTE_UNAVAILABLE"
	}
	ln, err := srv.ListenFunnel("tcp", ":443", tsnet.FunnelOnly())
	if err != nil {
		return "ROUTE_UNAVAILABLE"
	}
	defer ln.Close()
	send(event{Type: "listening"})
	dest := net.JoinHostPort("127.0.0.1", strconv.Itoa(bind.Port))
	accepting := make(chan error, 1)
	go func() { accepting <- serve(ctx, ln, dest) }()
	renew := time.NewTicker(12 * time.Hour)
	defer renew.Stop()
	for {
		select {
		case <-ctx.Done():
			return ""
		case <-accepting:
			return "ROUTE_OFFLINE"
		case <-renew.C:
			if !issue() {
				return "ROUTE_CERTIFICATE"
			}
		}
	}
}
