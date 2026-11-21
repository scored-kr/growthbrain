package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The proxy itself has no TLS certificate. The test client's trust store
// contains only the device's certificate, so a terminating proxy cannot pass.
func TestTLSRemainsEndToEndAcrossFunnelSocket(t *testing.T) {
	device := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil {
			t.Error("device received plaintext")
		}
		if r.URL.Path != "/mcp" {
			t.Error("wrong destination")
			return
		}
		fmt.Fprint(w, "device")
	}))
	defer device.Close()
	ingress, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ingress.Close()
	fakeFunnel := tls.NewListener(ingress, &tls.Config{MinVersion: tls.VersionTLS12})
	go serve(context.Background(), fakeFunnel, device.Listener.Addr().String())
	trust := x509.NewCertPool()
	trust.AddCert(device.Certificate())
	tr := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: trust, MinVersion: tls.VersionTLS12}}
	defer tr.CloseIdleConnections()
	c := &http.Client{Transport: tr, Timeout: 4 * time.Second}
	res, err := c.Get("https://" + ingress.Addr().String() + "/mcp")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil || string(body) != "device" || !res.TLS.PeerCertificates[0].Equal(device.Certificate()) {
		t.Fatal("did not reach device TLS endpoint")
	}
}
