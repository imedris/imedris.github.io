#!/usr/bin/env bash
set -Eeuo pipefail

repository=https://github.com/imedris/imedris.github.io.git
cache=/opt/citydetect-deploy
app=/home/ubuntu/tesla-monitor
container=citydetect-monitor
previous=citydetect-monitor-previous
mkdir -p "$cache"
exec 9>"$cache/update.lock"
flock -n 9 || exit 0
export GIT_TERMINAL_PROMPT=0

if [[ ! -d "$cache/repository.git" ]]; then
  git init --bare "$cache/repository.git"
fi
git --git-dir="$cache/repository.git" fetch --quiet --depth=1 "$repository" refs/heads/main
revision=$(git --git-dir="$cache/repository.git" rev-parse FETCH_HEAD)
if [[ -f "$cache/deployed-revision" ]] && [[ $(cat "$cache/deployed-revision") == "$revision" ]]; then
  exit 0
fi

release=$(mktemp -d "$cache/release.XXXXXX")
trap 'rm -rf "$release"' EXIT
for file in index.js Dockerfile.monitor; do
  git --git-dir="$cache/repository.git" show "$revision:$file" > "$release/$file"
done
if cmp -s "$release/index.js" "$app/index.js" && cmp -s "$release/Dockerfile.monitor" "$app/Dockerfile.monitor"; then
  printf '%s\n' "$revision" > "$cache/deployed-revision"
  echo "Application already matches $revision"
  exit 0
fi

image="citydetect-monitor:$revision"
docker build -f "$release/Dockerfile.monitor" -t "$image" "$release"
docker run --rm -v "$release:/candidate:ro" "$image" node --check /candidate/index.js
docker run --rm -v "$release:/candidate:ro" "$image" node /candidate/index.js simulate
cp "$app/index.js" "$release/previous-index.js"
cp "$app/Dockerfile.monitor" "$release/previous-Dockerfile.monitor"

rollback() {
  trap - ERR
  echo "Deployment failed. Restoring previous monitor."
  docker rm -f "$container" >/dev/null 2>&1 || true
  cp "$release/previous-index.js" "$app/index.js.next"
  mv "$app/index.js.next" "$app/index.js"
  cp "$release/previous-Dockerfile.monitor" "$app/Dockerfile.monitor"
  docker rename "$previous" "$container"
  docker start "$container"
  exit 1
}

docker stop "$container"
if ! docker rename "$container" "$previous"; then
  docker start "$container"
  exit 1
fi
trap rollback ERR
install -m 644 "$release/index.js" "$app/index.js.next"
mv "$app/index.js.next" "$app/index.js"
install -m 644 "$release/Dockerfile.monitor" "$app/Dockerfile.monitor"
docker run -d --name "$container" --restart unless-stopped \
  --log-opt max-size=10m --log-opt max-file=3 \
  -v "$app:/app" -v /var/run/docker.sock:/var/run/docker.sock "$image"
sleep 8
[[ $(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$container") == 'true 0' ]]
trap - ERR
docker rm "$previous"
printf '%s\n' "$revision" > "$cache/deployed-revision"
echo "Deployed $revision"
