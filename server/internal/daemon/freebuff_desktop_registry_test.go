package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/pkg/agent"
)

func TestFreebuffDesktopRegistryLifecycle(t *testing.T) {
	root := t.TempDir()
	t.Setenv(agent.FreebuffEnvProfilesDir, root)
	d := newFreebuffFixture(t).daemon
	rt := Runtime{ID: "runtime"}
	client := &fakeAccount{launchID: "secret"}
	d.freebuffDesktopInstances.Store(freebuffDesktopLoginKey(rt.ID, "account"), &freebuffDesktopInstance{client: client, stop: func() {}})
	read := func() []freebuffRegistryEntry {
		t.Helper()
		path := filepath.Join(root, "registry.json")
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Fatalf("mode = %o", info.Mode().Perm())
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var entries []freebuffRegistryEntry
		if err := json.Unmarshal(data, &entries); err != nil {
			t.Fatal(err)
		}
		return entries
	}
	d.setFreebuffDesktopConnected(rt, "account", client, true, "label")
	entries := read()
	if len(entries) != 1 || entries[0].AccountID != "account" || entries[0].PID != 123 || entries[0].LaunchID != "secret" {
		t.Fatalf("unexpected entry: %+v", entries)
	}
	d.setFreebuffDesktopConnected(rt, "account", client, false, "")
	if got := read(); len(got) != 0 {
		t.Fatalf("signed-out account published: %+v", got)
	}
	d.setFreebuffDesktopConnected(rt, "account", client, true, "label")
	d.stopFreebuffDesktopInstances()
	if got := read(); len(got) != 0 {
		t.Fatalf("stopped account published: %+v", got)
	}
}

func TestFreebuffDesktopRegistryConcurrentReaders(t *testing.T) {
	root := t.TempDir()
	t.Setenv(agent.FreebuffEnvProfilesDir, root)
	d := newFreebuffFixture(t).daemon
	rt := Runtime{ID: "runtime"}
	client := &fakeAccount{launchID: "secret"}
	d.freebuffDesktopInstances.Store(freebuffDesktopLoginKey(rt.ID, "account"), &freebuffDesktopInstance{client: client, stop: func() {}})
	d.setFreebuffDesktopConnected(rt, "account", client, true, "label")
	path := filepath.Join(root, "registry.json")
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			data, err := os.ReadFile(path)
			if err != nil || !json.Valid(data) {
				t.Errorf("reader observed incomplete registry: %v", err)
				return
			}
		}
	}()
	for i := 0; i < 100; i++ {
		d.setFreebuffDesktopConnected(rt, "account", client, i%2 == 0, "label")
	}
	wg.Wait()
}
