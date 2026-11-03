# Main stack deploy

`deploy-main.yml` manually builds (or uses staged) backend and web images, then
deploys them with `scripts/deploy-main.sh`. The deploy job runs on a dedicated
host runner because it must control Podman and `systemctl --user`; never run it
inside a Multica daemon task.

## One-time GitHub setup

1. In `ddvnguyen/multica-x`, open **Settings → Environments → New environment**
   and create `main-prod`.
2. Add the Owner as the only required reviewer and disable administrator
   bypass. This allows the Owner to approve a deployment they dispatched while
   preventing an administrator from bypassing the approval gate.
3. Under **Deployment branches and tags**, select **Selected branches and
   tags**. Add a branch rule for `multica-moct` and a tag rule for `*`. This
   environment policy independently restricts which workflow refs may deploy.
   The environment gate protects the entire self-hosted job, including
   checkout and image builds.
4. Under **Settings → Actions → Runners**, create a repository-level Linux
   x64 runner named `ddv-server-main` with the additional label `multica-main`.
   Install its files in `/mnt/workspace/runners/multica-main`, and configure its
   work directory as `/mnt/workspace/runners/multica-main/_work`. Keep runner
   credentials in the runner's local `.credentials` files; do not put tokens
   in the repository, workflow, or unit file.

   From that runner directory, run `config.sh` and paste the one-time
   registration token when prompted so it does not enter shell history:

   ```sh
   ./config.sh --url https://github.com/ddvnguyen/multica-x \
     --name ddv-server-main --labels multica-main \
     --work /mnt/workspace/runners/multica-main/_work --unattended
   ```

Run the runner as the `ddv` user using a systemd **user** service. Enable user
services after logout and provide the runtime directory; otherwise
`systemctl --user` cannot manage the main stack from an Actions job:

```sh
loginctl enable-linger ddv
mkdir -p /mnt/workspace/tmp/multica-main-actions \
  /mnt/workspace/runners/multica-main/_work \
  ~/.config/systemd/user
```

Create `~/.config/systemd/user/multica-main-runner.service`:

```ini
[Unit]
Description=GitHub Actions runner for main Multica deploys
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/mnt/workspace/runners/multica-main
Environment=TMPDIR=/mnt/workspace/tmp/multica-main-actions
Environment=XDG_RUNTIME_DIR=%t
ExecStart=/mnt/workspace/runners/multica-main/run.sh
Restart=always
RestartSec=5
KillMode=process

[Install]
WantedBy=default.target
```

Then enable it as `ddv`:

```sh
systemctl --user daemon-reload
systemctl --user enable --now multica-main-runner.service
systemctl --user status multica-main-runner.service
```

The runner user must be able to access rootless Podman, the main stack's
`.env`, the database container, `/mnt/containers`, `/mnt/workspace`, and the
user systemd manager. Confirm its process tree is independent of
`multica-daemon.service`. All action workspaces, caches, temp files, and deploy
backups must remain on `/mnt/workspace`.

## Dispatch

Go to **Actions → Deploy main Multica → Run workflow**. Choose a dispatch ref
of `multica-moct` or a single-component tag and set:

- **image_tag**: a unique immutable tag; it becomes both the image tag and the
  backend/daemon version.
- **source_ref**: `multica-moct` or `refs/tags/<tag>` with no slash in the tag
  name; the workflow records its full commit SHA and builds both images from it.
- **drain_timeout_seconds**: maximum wait for zero active daemon tasks.
- **image_source**: `build` (default) builds locally after environment approval;
  `staged` uses local images that already carry matching OCI revision and
  version labels.
- **force**: defaults to false. The pending job title and approval summary show
  this value. If true, the script stops the daemon after the drain timeout,
  cancelling tasks that remain.
- **dry_run**: defaults to false. Set it to true to build/validate the selected
  staged images and print the complete deploy plan without building images,
  backups, or service changes. `dry_run=true` requires `image_source=staged`.

The default path aborts on a drain timeout without making changes. The script
also refuses to run when its process ancestry or cgroup identifies
`multica-daemon.service`. On success it checks backend commit/version, migration
readiness at `/healthz`, web HTTP 200, and daemon CLI version. Rollback restores
the previous `.env` and daemon binary and brings the stack back up. It retains
the `pg_dump -Fc` backup for an operator and never restores the database
automatically.

The script reads `BACKEND_PORT` and `FRONTEND_PORT` from the stack `.env`,
defaulting to `3702` and `3180`. A task can arrive after the last zero-task
poll and before the daemon service stops; the script stops the daemon directly
after draining to keep that interval small, but it cannot make the poll and
service stop atomic.

## Dry run and rollback

On ddv-server, from a shell independent of the daemon, stage the selected
backend and web images with `org.opencontainers.image.revision` and
`org.opencontainers.image.version` labels, then run:

```sh
bash scripts/deploy-main.sh <image-tag> <full-40-character-commit-sha> 600 --dry-run
```

The dry run performs the read-only preflight and prints the ordered deploy and
rollback plan; it does not create directories, back up data, or change service
state. Save its output with the deployment record. Backups are created under
`/mnt/workspace/multica-main-backups/<UTC timestamp>.*` with mode 700. If
automatic rollback reports a failure, use that directory's `.env` and
`multica` files to restore the prior configuration/binary, run
`podman compose up -d` from `~/.local/share/multica`, then start
`multica-daemon.service`. Review the database dump separately; never restore it
without deciding how to preserve writes made after the dump.
