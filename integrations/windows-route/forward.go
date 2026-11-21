package main

import (
	"context"
	"crypto/tls"
	"io"
	"net"
	"time"
)

func serve(ctx context.Context, ln net.Listener, dest string) error {
	slots := make(chan struct{}, 32)
	for {
		remote, err := ln.Accept()
		if err != nil {
			return err
		}
		// ListenFunnel wraps each unhandshaken connection in tls.Conn. Forward
		// the original encrypted stream to the local MCP TLS endpoint; never
		// invoke Read/Write/Handshake on the Go TLS wrapper.
		wrapper, ok := remote.(*tls.Conn)
		if !ok {
			remote.Close()
			continue
		}
		raw := wrapper.NetConn()
		select {
		case slots <- struct{}{}:
		default:
			raw.Close()
			continue
		}
		go func() {
			defer func() { <-slots }()
			defer raw.Close()
			d := net.Dialer{Timeout: 5 * time.Second}
			local, err := d.DialContext(ctx, "tcp", dest)
			if err != nil {
				return
			}
			defer local.Close()
			done := make(chan struct{})
			go func() {
				io.Copy(local, raw)
				if c, ok := local.(*net.TCPConn); ok {
					c.CloseWrite()
				}
				close(done)
			}()
			io.Copy(raw, local)
			raw.Close()
			local.Close()
			<-done
		}()
	}
}
