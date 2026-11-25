# Host disk-guard config (M-559)

Source of truth for the host-only disk guards on the lane-z machine. These are
host config, not part of a deploy artifact: install them to the paths below and
keep this directory in sync with the live host.

| Repo path | Host path |
| --- | --- |
| `disk-retention.sh` | `/mnt/workspace/clouds/dsh-z/bin/disk-retention.sh` |
| `systemd/dsh-x.service.d/disk-tmp.conf` | `~/.config/systemd/user/dsh-x.service.d/disk-tmp.conf` |
| `systemd/paseo-beta.service.d/disk-tmp.conf` | `~/.config/systemd/user/paseo-beta.service.d/disk-tmp.conf` |
| `environment.d/00-disk-tmp.conf` | `~/.config/environment.d/00-disk-tmp.conf` |

Install:

```bash
install -m 755 disk-retention.sh /mnt/workspace/clouds/dsh-z/bin/disk-retention.sh
install -D -m 644 systemd/dsh-x.service.d/disk-tmp.conf \
  ~/.config/systemd/user/dsh-x.service.d/disk-tmp.conf
install -D -m 644 systemd/paseo-beta.service.d/disk-tmp.conf \
  ~/.config/systemd/user/paseo-beta.service.d/disk-tmp.conf
install -D -m 644 environment.d/00-disk-tmp.conf ~/.config/environment.d/00-disk-tmp.conf
systemctl --user daemon-reload
systemctl --user restart dsh-x.service
# paseo-beta.service: restart only when no run is active
```

`dsh-disk-retention.timer` (already enabled) runs `disk-retention.sh --apply`
daily; `multica-prune-workspaces.timer` handles git-audited task-workdir GC.

Verify with `bash -n`, a `--dry-run`, and `systemctl --user list-timers`. The
85% alert can be tested without touching the production file:

```bash
DISK_ALERT_PCT=1 DISK_ALERT_CLEAR_PCT=0 \
DISK_ALERT_MARKER=/mnt/workspace/tmp/disk-alert-test.marker \
  ./disk-retention.sh --dry-run
```
