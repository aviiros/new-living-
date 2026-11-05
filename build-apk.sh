#!/usr/bin/env bash
# Linux / macOS:  ./build-apk.sh   (add --release for a signed build)
set -e
cd "$(dirname "$0")"
node scripts/build-apk.js "$@"
