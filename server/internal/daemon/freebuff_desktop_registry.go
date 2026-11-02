package daemon

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/multica-ai/multica/server/pkg/agent"
)

type freebuffRegistryEntry struct {
	AccountID string `json:"accountId"`
	RuntimeID string `json:"runtimeId"`
	Label     string `json:"label"`
	Port      int    `json:"port"`
	PID       int    `json:"pid"`
	LaunchID  string `json:"launchId"`
}

// writeFreebuffDesktopRegistryLocked is called with freebuffDesktopInstanceMu held.
func (d *Daemon) writeFreebuffDesktopRegistryLocked() error {
	profile, err := agent.FreebuffProfileDir(agent.Config{RuntimeID: "default"})
	if err != nil {
		return err
	}
	root := filepath.Dir(profile)
	entries := make([]freebuffRegistryEntry, 0)
	d.freebuffDesktopInstances.Range(func(key, value any) bool {
		inst := value.(*freebuffDesktopInstance)
		if !inst.connected {
			return true
		}
		parts := strings.SplitN(key.(string), "/", 2)
		u, err := url.Parse(inst.client.BaseURL())
		if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || len(parts) != 2 {
			return true
		}
		_, portString, err := net.SplitHostPort(u.Host)
		if err != nil {
			return true
		}
		port, err := strconv.Atoi(portString)
		if err != nil || port < 1 || port > 65535 || inst.client.PID() <= 0 || inst.client.LaunchID() == "" {
			return true
		}
		entries = append(entries, freebuffRegistryEntry{AccountID: parts[1], RuntimeID: parts[0], Label: inst.label, Port: port, PID: inst.client.PID(), LaunchID: inst.client.LaunchID()})
		return true
	})
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(root, ".registry-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err := json.NewEncoder(f).Encode(entries); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, filepath.Join(root, "registry.json")); err != nil {
		return fmt.Errorf("replace registry: %w", err)
	}
	return nil
}

func (d *Daemon) publishFreebuffDesktopLocked() {
	if err := d.writeFreebuffDesktopRegistryLocked(); err != nil {
		d.logger.Warn("freebuff desktop registry update failed", "error", err)
	}
}

func (d *Daemon) setFreebuffDesktopConnected(rt Runtime, accountID string, client freebuffAccount, connected bool, label string) {
	d.freebuffDesktopInstanceMu.Lock()
	defer d.freebuffDesktopInstanceMu.Unlock()
	if value, ok := d.freebuffDesktopInstances.Load(freebuffDesktopLoginKey(rt.ID, accountID)); ok {
		inst := value.(*freebuffDesktopInstance)
		if inst.client == client {
			inst.connected, inst.label = connected, label
			d.publishFreebuffDesktopLocked()
		}
	}
}
