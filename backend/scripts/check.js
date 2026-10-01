'use strict';

/**
 * Build gate.
 *
 * Railway (and railpack.json) run `npm run build` before `npm start`. The
 * previous configuration pointed that at a script that did not exist, so every
 * deploy failed. This is a real check rather than a no-op:
 *
 *   1. every JavaScript file parses (catches a syntax error before it becomes
 *      a crash-looping container)
 *   2. every relative require() resolves to a file that exists (catches a
 *      mistyped path, which is otherwise only found at request time)
 *   3. every declared dependency is actually installed
 *   4. the static pages directory is present
 *   5. every local asset a page or stylesheet references exists, matched
 *      case-sensitively — section 7 explains why that is not paranoia
 *
 * It never executes application code, so it needs no database and no secrets.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'tmp']);

const problems = [];
let scanned = 0;
let requiresChecked = 0;

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, onFile);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      onFile(full);
    }
  }
}

/** Resolve a relative require() the way Node would, including index files. */
function resolvesToFile(base) {
  const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')];
  return candidates.some((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

walk(ROOT, (file) => {
  const source = fs.readFileSync(file, 'utf8');
  const relative = path.relative(ROOT, file);
  scanned += 1;

  // 1. Does it parse?
  try {
    new vm.Script(source, { filename: relative });
  } catch (error) {
    problems.push(`syntax error in ${relative}: ${error.message}`);
    return; // A file that does not parse cannot be scanned for requires.
  }

  // 2. Do its relative requires resolve?
  const requirePattern = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let match = requirePattern.exec(source);

  while (match) {
    requiresChecked += 1;
    const target = path.resolve(path.dirname(file), match[1]);
    if (!resolvesToFile(target)) {
      problems.push(`${relative} requires "${match[1]}" which does not exist`);
    }
    match = requirePattern.exec(source);
  }
});

// 3. Are the declared dependencies installed?
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const declared = Object.keys(manifest.dependencies || {});

const missing = declared.filter((name) => {
  try {
    fs.statSync(path.join(ROOT, 'node_modules', name));
    return false;
  } catch {
    return true;
  }
});

for (const name of missing) {
  problems.push(`dependency "${name}" is declared but not installed — run npm install`);
}

// 4. Are the pages where the server expects them?
const publicDir = path.join(ROOT, '..', 'frontend', 'public');
if (!fs.existsSync(publicDir)) {
  problems.push(`static pages directory not found at ${publicDir}`);
} else {
  const pages = fs.readdirSync(publicDir).filter((name) => name.endsWith('.html'));
  if (pages.length === 0) problems.push('no .html pages found in frontend/public');
  for (const required of ['index.html', '404.html']) {
    if (!pages.includes(required)) problems.push(`frontend/public/${required} is missing`);
  }
}

/**
 * 5. Front-end scripts must parse too.
 *
 * A syntax error in the shared API client would break every page that includes
 * it, and the browser would report it only as a blank screen. Checking here
 * turns that into a failed build.
 */
const assetsDir = path.join(publicDir, 'assets', 'js');
if (fs.existsSync(assetsDir)) {
  for (const name of fs.readdirSync(assetsDir).filter((entry) => entry.endsWith('.js'))) {
    const file = path.join(assetsDir, name);
    scanned += 1;
    try {
      new vm.Script(fs.readFileSync(file, 'utf8'), { filename: `frontend/public/assets/js/${name}` });
    } catch (error) {
      problems.push(`syntax error in frontend/public/assets/js/${name}: ${error.message}`);
    }
  }
}

/**
 * 6. Page wiring.
 *
 *    · no page may still call the retired hardcoded API host
 *    · a page that uses WGAUI must load wga-ui.js
 *    · a page that loads the guard must load the API client first, because the
 *      guard calls into it at parse time
 */
const RETIRED_HOST = 'the-box-lms-production.up.railway.app';
if (fs.existsSync(publicDir)) {
  for (const name of fs.readdirSync(publicDir).filter((entry) => entry.endsWith('.html'))) {
    const source = fs.readFileSync(path.join(publicDir, name), 'utf8');

    if (source.includes(RETIRED_HOST)) {
      problems.push(`frontend/public/${name} still calls the retired API host ${RETIRED_HOST}`);
    }

    // Only complain if the page actually calls into the helpers.
    if (/\bWGAUI\./.test(source) && !source.includes('/assets/js/wga-ui.js')) {
      problems.push(`frontend/public/${name} uses WGAUI but does not load /assets/js/wga-ui.js`);
    }

    const guardAt = source.indexOf('/assets/js/wga-guard.js');
    const apiAt = source.indexOf('/assets/js/wga-api.js');

    if (guardAt !== -1 && (apiAt === -1 || apiAt > guardAt)) {
      problems.push(`frontend/public/${name} must load /assets/js/wga-api.js before wga-guard.js`);
    }

    /**
     * Inline script and style blocks.
     *
     * These are parsed by the browser, never by the build, so a syntax error in
     * one is a page that renders its markup and then does nothing — and nothing
     * above catches it. Most of the page logic in this product is inline, so
     * that is the likeliest place for a broken change to hide.
     */
    let scriptIndex = 0;
    for (const script of source.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi)) {
      scriptIndex += 1;

      // Skip data blocks (application/ld+json and friends): they are not
      // JavaScript, and parsing them as if they were reports a false failure.
      const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(script[1] || '');
      if (type && !/^(text\/javascript|module)$/i.test(type[1])) continue;

      scanned += 1;
      try {
        new vm.Script(script[2], {
          filename: `frontend/public/${name} (inline script ${scriptIndex})`,
        });
      } catch (error) {
        problems.push(
          `syntax error in frontend/public/${name} inline script ${scriptIndex}: ${error.message}`
        );
      }
    }

    for (const style of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
      const open = (style[1].match(/\{/g) || []).length;
      const close = (style[1].match(/\}/g) || []).length;

      // An unbalanced block silently discards every rule after the break, so
      // the page still loads and simply looks wrong.
      if (open !== close) {
        problems.push(
          `frontend/public/${name} has an unbalanced <style> block (${open} { against ${close} })`
        );
      }
    }
  }
}

/**
 * 7. Every local asset reference must match the file on disk *including case*.
 *
 * This check exists because of a real failure. The brand folder was renamed from
 * `Imges` to `Images`. Windows resolves either spelling, so every page kept
 * working on the machine the change was made on — while the Linux container is
 * case-sensitive and would have 404'd every logo and favicon across the site.
 *
 * A deployment is the worst place for this: the breakage appears only after the
 * change is live, it hits every page at once, and it reads as a missing file
 * rather than a casing mistake. `fs.existsSync` cannot catch it either, because
 * on Windows it says yes. So this compares each path segment against the real
 * directory entries, where a case-insensitive filesystem cannot paper over it.
 */
function resolveExactly(baseDir, urlPath) {
  const segments = urlPath.split('/').filter(Boolean);
  let current = baseDir;

  for (const segment of segments) {
    let entries;
    try {
      entries = fs.readdirSync(current);
    } catch {
      return { ok: false };
    }

    // Array.includes is case-sensitive, which is the entire point here.
    if (!entries.includes(segment)) {
      // Look for the same name in a different case, so the failure can name the
      // file that is actually there rather than only the one that is not.
      const nearMiss = entries.find((entry) => entry.toLowerCase() === segment.toLowerCase());
      return { ok: false, nearMiss };
    }

    current = path.join(current, segment);
  }

  try {
    return { ok: fs.statSync(current).isFile() };
  } catch {
    return { ok: false };
  }
}

const ASSET_EXTENSIONS = /\.(png|jpe?g|svg|webp|gif|ico|css|js|mjs|woff2?|ttf|eot|mp4|webm|pdf)$/i;

let assetsChecked = 0;

if (fs.existsSync(publicDir)) {
  const sourceFiles = [];
  const stack = [publicDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && /\.(html|css)$/i.test(entry.name)) sourceFiles.push(full);
    }
  }

  const projectRoot = path.join(ROOT, '..');

  for (const file of sourceFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(projectRoot, file).split(path.sep).join('/');

    // src/href attributes in pages, and url(...) in the pages' inline styles and
    // the stylesheets. Query strings and fragments are not part of the path.
    const patterns = [
      /(?:src|href)\s*=\s*["'](\/[^"'#?]+)(?:[#?][^"']*)?["']/gi,
      /url\(\s*['"]?(\/[^'")#?]+)(?:[#?][^'")]*)?['"]?\s*\)/gi,
    ];

    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const urlPath = decodeURIComponent(match[1]);
        if (!ASSET_EXTENSIONS.test(urlPath)) continue;

        assetsChecked += 1;
        const result = resolveExactly(publicDir, urlPath);

        if (!result.ok) {
          const hint = result.nearMiss
            ? ` — on disk it is "${result.nearMiss}", which differs only in case`
            : '';
          problems.push(`${relative} references "${urlPath}", which does not exist${hint}`);
        }
      }
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(`\nBuild check failed with ${problems.length} problem(s):\n\n`);
  for (const problem of problems) process.stderr.write(`  • ${problem}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

process.stdout.write(
  `Build check passed: ${scanned} files parsed, ${requiresChecked} relative imports resolved, ` +
    `${assetsChecked} local assets resolved, ${declared.length} dependencies present.\n`
);
