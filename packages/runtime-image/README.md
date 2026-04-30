# @funclaw/runtime-image

The Docker image Fun Claw spawns containers from at chat time. Every tool call (`execute_bash`, `write_file`, MCP, skills) runs inside a container created from this image with ADR-001's hardening config applied.

The image is published to **`ghcr.io/ajpandit775/fun-claw-runtime`** with a per-version tag and the rolling `latest` tag. Released at the same git tag as the corresponding `fun-claw` npm package — `v0.1.0` of the CLI uses `ghcr.io/ajpandit775/fun-claw-runtime:0.1.0` as its default sandbox image.

## What's inside

- **Base:** `ubuntu:24.04` (Noble Numbat LTS, supported until April 2029).
- **Pre-created agent user:** `uid 10001`, `gid 10001`, home at `/home/agent`. The image avoids the docker-runner's `--user 0:0` setup-exec for `useradd` (which exists as a fallback bridge for when this image isn't available).
- **Pre-created `/workspace`** (uid 10001-owned, mode `0700`) and `/tmp` (mode `1777`, sticky).
- **Toolchain:** `git`, `curl`, `jq`, `build-essential` (gcc/g++/make), `python3` + `python3-pip` + `python3-venv`, `unzip`, **Node 22 LTS** (via NodeSource apt repo), **pnpm** (via Corepack).
- **Entrypoint:** a tiny `/bin/sh` script that fails fast with a clear FC-pointer if `/workspace` or `/tmp` aren't writable. Normal use never hits the failure path.

Image size targets: **under 500 MB compressed.** Achieved via `--no-install-recommends`, single `RUN` for the apt block, and `apt-get clean` + `rm -rf /var/lib/apt/lists/*` cleanup.

## Building locally

```sh
# From the repo root:
pnpm -F @funclaw/runtime-image run build:local

# Or directly:
node packages/runtime-image/scripts/build.mjs --tag local
```

This produces a single tag, `fun-claw-runtime:local`, suitable for testing without polluting the registry-tagged namespace.

To produce the registry-tagged version (`ghcr.io/ajpandit775/fun-claw-runtime:<version>` + `:latest`):

```sh
pnpm -F @funclaw/runtime-image run build
```

The CI release workflow (`.github/workflows/release.yml`) runs the same `build` command on tagged releases, then `docker push`es the resulting tags to GHCR.

## Verifying

```sh
pnpm -F @funclaw/runtime-image run verify
```

Runs an 11-check suite against `fun-claw-runtime:local` (override with `--tag <other-tag>`):

1. Container's default uid is `10001`.
2. Default gid is `10001`.
3. `/workspace` is writable by uid 10001.
4. `/tmp` is writable.
5. `/tmp` has the sticky bit set (mode `1777`).
6. `node --version` reports a `v22.x` release.
7. `pnpm --version` reports a semver.
8. `git`, `curl`, `jq` are all on `PATH`.
9. `python3 --version` reports `Python 3.x`.

## Version policy

- The image's `version` label and registry tag track the matching `fun-claw` npm package release.
- `revision` label is the git short-sha at build time.
- `created` label is the ISO 8601 build timestamp.
- Stable images are immutable: `0.1.0` will never be re-pushed once published. New patches get a new tag (`0.1.1`).
- The `latest` tag follows the most recent stable release.

## Releasing

Owned by the GitHub Actions release workflow (`.github/workflows/release.yml`). On a tag push matching `v*.*.*`, the workflow:

1. Builds the image with `VERSION=<tag>`, `REVISION=<sha>`, `BUILD_DATE=<iso>`.
2. Tags it as `ghcr.io/ajpandit775/fun-claw-runtime:<version>` and `:latest`.
3. Pushes both tags to GHCR using the `GITHUB_TOKEN` provided by the workflow (no long-lived secret).

Manual release path (used for the v0.1.0 bootstrap before the workflow runs):

```sh
docker login ghcr.io -u ajpandit775
node packages/runtime-image/scripts/build.mjs
docker push ghcr.io/ajpandit775/fun-claw-runtime:0.1.0
docker push ghcr.io/ajpandit775/fun-claw-runtime:latest
```

## Why a separate package?

This is a workspace member with a `package.json` so:

- `pnpm -F @funclaw/runtime-image run build` works from anywhere in the monorepo.
- The build/verify scripts live alongside the Dockerfile they belong to.
- Future per-platform variants (e.g. an Alpine-based slim image) can land as sibling packages without restructuring the workspace.

The package is `private: true` and has no JavaScript output — there's nothing to publish to npm. Only the Docker image is published, and that goes to GHCR via the release workflow.

## License

Apache 2.0. See `/LICENSE` at the repo root.
