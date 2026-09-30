#!/usr/bin/env node
'use strict';

/**
 * Copy the static pages inside the backend directory.
 *
 *   npm run build:deploy
 *
 * Why this exists. The API and the pages are served by one process, and the pages
 * live beside the app rather than inside it:
 *
 *     frontend/public/*.html      the pages
 *     backend/                    the app, which reads ../../frontend/public
 *
 * That layout is fine when the whole repository is present at runtime. It is not
 * fine when a builder decides the "app" is backend/ — the nearest directory with a
 * package.json — and ships only that. The result is subtle rather than obvious: the
 * API answers every request, so the deployment looks alive, and every page URL
 * including `/` returns the API's JSON 404. Which reads as a routing bug.
 *
 * So at build time the pages are copied in beside the app, and the app looks for
 * them in both places. Whichever the host ships, one of them works.
 *
 * Running this is harmless when the repository layout is intact — the app prefers
 * the original, and this copy simply goes unused. If the source is absent there is
 * nothing to copy and that is not an error.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '..', '..', 'frontend', 'public');
const DESTINATION = path.join(__dirname, '..', 'public');

if (!fs.existsSync(SOURCE)) {
  process.stdout.write(
    `No pages found at ${SOURCE}, so there is nothing to stage.\n` +
      'That is expected when the app runs from a directory that has no sibling frontend folder.\n'
  );
  process.exit(0);
}

const pages = fs.readdirSync(SOURCE).filter((name) => name.endsWith('.html')).length;

fs.rmSync(DESTINATION, { recursive: true, force: true });
fs.cpSync(SOURCE, DESTINATION, { recursive: true });

const staged = fs.readdirSync(DESTINATION).length;

process.stdout.write(
  `Staged ${staged} entr${staged === 1 ? 'y' : 'ies'} (${pages} page${pages === 1 ? '' : 's'}) ` +
    `into ${path.relative(path.join(__dirname, '..'), DESTINATION)}\n`
);
