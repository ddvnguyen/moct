package daemon

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/pkg/freebuffrt"
)

func TestDesktopPinReconciliation(t *testing.T) {
	fx := newFreebuffFixture(t)
	rt := Runtime{ID: "pin-test"}
	t.Cleanup(func() {
		for _, id := range []string{"a", "b"} {
			freebuffAccountPins.Delete(freebuffDesktopLoginKey(rt.ID, id))
		}
	})
	fx.pending = `{"pins":{"a":"2","b":"1"},"accounts":[]}`
	started := map[string]string{}
	stopped := map[string]int{}
	prev := startFreebuffAccount
	startFreebuffAccount = func(_ context.Context, runtimeID, id string) (freebuffAccount, func(), error) {
		started[id] = freebuffAccountEngineVersion(runtimeID, id)
		return &fakeAccount{statuses: []freebuffrt.AuthStatus{signedIn("x")}}, func() { stopped[id]++ }, nil
	}
	t.Cleanup(func() { startFreebuffAccount = prev })
	old := &fakeAccount{statuses: []freebuffrt.AuthStatus{signedIn("x")}}
	fx.daemon.freebuffDesktopInstances.Store(freebuffDesktopLoginKey(rt.ID, "a"), &freebuffDesktopInstance{client: old, pin: "1", stop: func() { stopped["a"]++ }})
	fx.daemon.freebuffDesktopInstances.Store(freebuffDesktopLoginKey(rt.ID, "b"), &freebuffDesktopInstance{client: old, pin: "1", stop: func() { stopped["b"]++ }})
	release := fx.daemon.reserveFreebuffDesktopAccount(rt.ID, "a")
	fx.daemon.syncFreebuffDesktopRuntime(context.Background(), rt)
	if stopped["a"] != 0 {
		t.Fatal("restarted reserved account")
	}
	release()
	fx.daemon.syncFreebuffDesktopRuntime(context.Background(), rt)
	if stopped["a"] != 1 || stopped["b"] != 0 || started["a"] != "2" {
		t.Fatalf("stops=%v starts=%v", stopped, started)
	}
}

func TestDesktopPinDefersLoginAndReportsFailure(t *testing.T) {
	fx := newFreebuffFixture(t)
	rt := Runtime{ID: "pin-failure"}
	key := freebuffDesktopLoginKey(rt.ID, "a")
	t.Cleanup(func() { freebuffAccountPins.Delete(key) })
	fx.pending = `{"pins":{"a":"missing"},"accounts":[{"id":"a","state":"awaiting_login","active":true}]}`
	stopped := 0
	old := &fakeAccount{statuses: []freebuffrt.AuthStatus{signedIn("x")}}
	fx.daemon.freebuffDesktopInstances.Store(key, &freebuffDesktopInstance{client: old, pin: "old", stop: func() { stopped++ }})
	fx.daemon.freebuffDesktopLogins.Store(key, context.CancelFunc(func() {}))
	fx.daemon.syncFreebuffDesktopRuntime(context.Background(), rt)
	if stopped != 0 {
		t.Fatal("restarted during login")
	}
	fx.daemon.freebuffDesktopLogins.Delete(key)
	fx.pending = `{"pins":{"a":"missing"},"accounts":[]}`
	prev := startFreebuffAccount
	startFreebuffAccount = func(context.Context, string, string) (freebuffAccount, func(), error) {
		return nil, nil, errors.New("missing; installed versions: 1")
	}
	t.Cleanup(func() { startFreebuffAccount = prev })
	fx.daemon.syncFreebuffDesktopRuntime(context.Background(), rt)
	reports := fx.accountReports()
	if stopped != 1 || len(reports) == 0 || reports[len(reports)-1]["state"] != "failed" || !strings.Contains(reports[len(reports)-1]["error"].(string), "installed versions: 1") {
		t.Fatalf("stopped=%d reports=%v", stopped, reports)
	}
}

func TestDesktopAccountPinPrecedence(t *testing.T) {
	rt, id := "pin-precedence", "a"
	key := freebuffDesktopLoginKey(rt, id)
	freebuffPins.Store(rt, "runtime")
	t.Cleanup(func() { freebuffPins.Delete(rt); freebuffAccountPins.Delete(key) })
	if got := freebuffAccountEngineVersion(rt, id); got != "runtime" {
		t.Fatal(got)
	}
	freebuffAccountPins.Store(key, "account")
	if got := freebuffAccountEngineVersion(rt, id); got != "account" {
		t.Fatal(got)
	}
	freebuffAccountPins.Store(key, "")
	freebuffPins.Delete(rt)
	if got := freebuffAccountEngineVersion(rt, id); got != "" {
		t.Fatal(got)
	}
}

func TestDesktopReservationWaitsForRestart(t *testing.T) {
	fx := newFreebuffFixture(t)
	rt := Runtime{ID: "pin-race"}
	key := freebuffDesktopLoginKey(rt.ID, "a")
	t.Cleanup(func() { freebuffAccountPins.Delete(key) })
	fx.pending = `{"pins":{"a":"2"},"accounts":[]}`
	old := &fakeAccount{statuses: []freebuffrt.AuthStatus{signedIn("x")}}
	fx.daemon.freebuffDesktopInstances.Store(key, &freebuffDesktopInstance{client: old, pin: "1", stop: func() {}})
	entered, unblock := make(chan struct{}), make(chan struct{})
	prev := startFreebuffAccount
	startFreebuffAccount = func(context.Context, string, string) (freebuffAccount, func(), error) {
		close(entered)
		<-unblock
		return &fakeAccount{statuses: []freebuffrt.AuthStatus{signedIn("x")}}, func() {}, nil
	}
	t.Cleanup(func() { startFreebuffAccount = prev })
	done := make(chan struct{})
	go func() { defer close(done); fx.daemon.syncFreebuffDesktopRuntime(context.Background(), rt) }()
	<-entered
	reserved := make(chan struct{})
	go func() {
		release := fx.daemon.reserveFreebuffDesktopAccount(rt.ID, "a")
		defer release()
		client, err := fx.daemon.ensureFreebuffDesktopInstance(context.Background(), rt, "a")
		if err != nil || client == old {
			t.Errorf("task received old or failed endpoint: %v", err)
		}
		close(reserved)
	}()
	select {
	case <-reserved:
		t.Fatal("task passed restart before replacement")
	default:
	}
	close(unblock)
	<-done
	<-reserved
}
