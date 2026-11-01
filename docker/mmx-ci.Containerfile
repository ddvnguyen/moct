# mmx-ci: job container for the rootless self-hosted runner pool (M-164).
#
# Jobs run in this image instead of on the host. It deliberately contains no
# sudo and no docker/podman CLI: a job must not be able to reach a container
# engine or escalate. The runner payload itself is bind-mounted from
# /mnt/workspace/clouds/runners/multica-x/mmx-N (see runner-entry.sh); this
# image only provides the userland the GitHub Actions steps expect.
FROM docker.io/library/node:22-bookworm@sha256:94c973596a8581a87ba42746ceb0b0e0b5246d098de45b1ce04dcc967cfc5dfb

# nftables: the entrypoint installs the egress filter inside the container's
# own network namespace (the rootless analogue of M-150's uid-keyed host
# filter). util-linux ships setpriv, used to drop from container root to the
# capless job uid. libicu72 comes with the node base image and satisfies the
# .NET runner's globalization needs, so DOTNET_SYSTEM_GLOBALIZATION_INVARIANT
# is unnecessary. jq/zip/unzip are used by Actions steps.
RUN apt-get update \
 && apt-get install -y --no-install-recommends nftables jq zip unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && command -v sudo >/dev/null 2>&1 && { echo "sudo must not exist in mmx-ci" >&2; exit 1; } || true

# The job uid: --userns=keep-id maps host ddv (uid 1000) to container uid
# 1000, which the base image already provides as user `node`, so files the
# runner writes into the mounted dirs stay owned by ddv.
RUN mkdir -p /mnt/workspace/cache/mmx /mnt/workspace/tmp/mmx \
 && chown -R node:node /home/node /mnt/workspace/cache/mmx /mnt/workspace/tmp/mmx

# Give Node-based builds (Next.js) enough heap; the container has 12G but
# Node's auto-detection can under-size in nested cgroups.
ENV NODE_OPTIONS=--max-old-space-size=6144


# Egress ruleset (installed by entrypoint inside the container netns).
COPY docker/mmx-nft.rules /etc/mmx-nft.rules

# Entrypoint: install filter, drop to capless uid 1000, exec runner.
COPY docker/mmx-entrypoint.sh /usr/local/bin/mmx-entrypoint.sh
RUN chmod 0755 /usr/local/bin/mmx-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/mmx-entrypoint.sh"]
CMD ["/bin/true"]
