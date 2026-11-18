#!/bin/sh
# Installs the worker as a systemd user service: starts at login, restarts if it crashes.
set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p ~/.config/systemd/user
sed "s#__DIR__#$DIR#" "$DIR/worker/azymut-worker.service" > ~/.config/systemd/user/azymut-worker.service
systemctl --user daemon-reload
systemctl --user enable --now azymut-worker.service
systemctl --user --no-pager status azymut-worker.service | head -5
