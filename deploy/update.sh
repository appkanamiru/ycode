#!/bin/sh
# Update the running platform: pull the code, rebuild and restart what
# changed, then remove what the build left behind. Every build of the app
# adds gigabytes of build cache and leaves the previous image unused, which
# fills the disk within a few deploys.
#
#   deploy/update.sh
#
# BUILD_CACHE_MAX (default 8GB) is the build cache kept for faster rebuilds.
set -eu

cd "$(dirname "$0")/.."
compose() {
  docker compose -p ycode --env-file deploy/.env -f deploy/docker-compose.yml "$@"
}

before=$(git rev-parse HEAD)
git pull --ff-only

compose up -d --build

# Caddy reads its configuration from a bind-mounted file: a changed file
# only takes effect in a new container
if ! git diff --quiet "$before" HEAD -- deploy/Caddyfile; then
  compose up -d --force-recreate caddy
fi

docker image prune -f
docker builder prune -f --max-used-space "${BUILD_CACHE_MAX:-8GB}"
