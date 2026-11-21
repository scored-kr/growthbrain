package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestFreshManagedDeviceUsesOneInheritedGrant(t *testing.T) {
	id := "83ad4852-f588-40e5-b17f-75762088543c"
	setup := command{StateDir: t.TempDir(), DeviceID: id}
	for _, allow := range []bool{true, false} {
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		defer cancel()
		cmd := make(chan command, 1)
		var events []string
		node, code := managedServer(ctx, setup, cmd, func(e event) {
			events = append(events, e.Type)
			if allow {
				cmd <- command{AuthKey: "tskey-auth-" + strings.Repeat("x", 24)}
			} else {
				cmd <- command{Port: 443}
			}
		})
		if len(events) != 1 || events[0] != "enroll" {
			t.Fatalf("expected one private enrollment event")
		}
		if allow {
			if code != "" || node == nil || !node.Ephemeral || node.AuthKey == "" || node.Hostname != "gb-"+id {
				t.Fatal("invalid managed node")
			}
		} else if node != nil || code != "ROUTE_ENROLLMENT_UNAVAILABLE" {
			t.Fatal("unexpected authorization path")
		}
	}
}
