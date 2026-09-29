#!/bin/bash
#
# Alternative start script, for hosts that prefer one rather than a platform
# config file. Equivalent to what railpack.json does.
#
# The API and the static pages are served by the same process, so there is only
# one thing to start.

set -euo pipefail

cd backend

# `npm ci` installs exactly what the lockfile pins. `npm run build` runs
# scripts/check.js, which verifies that every source file parses, every relative
# import resolves, every declared dependency is installed and the pages are
# present — so a broken build fails here rather than as a crash-looping
# container.
npm ci
npm run build

exec npm start