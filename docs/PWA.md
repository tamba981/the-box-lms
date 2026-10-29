# Installing Wuteve as an app

The site is a Progressive Web App: a visitor can add it to their phone's home
screen and it then opens full-screen, with its own icon, and no address bar. The
files that make that possible are:

| File | Purpose |
| --- | --- |
| `frontend/public/manifest.webmanifest` | Name, colours, icons, start URL, and the shortcuts shown on a long-press of the icon |
| `frontend/public/sw.js` | Service worker. Chrome will not offer to install a site without one |
| `frontend/public/offline.html` | What a reader sees when a page has not been saved and there is no signal |
| `frontend/public/icons/*.png` | Four icons, generated from the brand emblem |
| `frontend/public/assets/js/wga-install.js` | The button, and the instructions for platforms with no install API |
| `backend/scripts/make-icons.js` | Rebuilds the icons from `Images/Brand/wuteve-emblem.png` |

Rebuild the icons with `npm run icons` after a rebrand. It reads the emblem and
writes all four, so the artwork stays in one file.

## What actually happens on each platform

This is the part worth understanding, because the two platforms are not
equivalent and a single "Install" button that treats them the same is a button
that lies on one of them.

### Android, and Chrome or Edge on a computer

The browser fires `beforeinstallprompt`, which carries a function that opens the
real install dialog. `wga-install.js` captures it, suppresses Chrome's own
mini-infobar so the invitation can be placed where the design wants it, and
calls it when the reader taps **Install app**. One tap, native sheet, icon in the
app drawer or the desktop launcher.

The browser only fires that event when the site qualifies: HTTPS, a manifest with
a 192px and a 512px icon, `display: standalone`, and a registered service worker
with a `fetch` handler. All four are in place.

### iPhone and iPad

**There is no install API on iOS.** Safari has never shipped one. No JavaScript
can open "Add to Home Screen" — Apple requires the reader to do it from the Share
sheet, and that is a deliberate platform decision.

So on iOS the button opens a short instruction sheet instead: tap Share, choose
Add to Home Screen, tap Add. It is three taps rather than one, and that is Apple's
limit, not the site's. The sheet names the Share button and draws its glyph,
because "the share icon" is not obvious to everyone.

Two details handled there:

- **iPadOS 13 and later reports itself as a Mac.** The tell is a Mac with a touch
  screen; no Mac has one, so `maxTouchPoints > 1` identifies an iPad.
- **Chrome, Firefox and Edge on iOS cannot install at all**, even though they run
  the same engine. On those, the sheet says to open the site in Safari first
  rather than giving steps that would not work.

### Already installed

The button never appears when the site is running as an installed app: detected
from `display-mode: standalone`, `navigator.standalone`, or an
`android-app://` referrer. It also disappears the moment `appinstalled` fires.

**Not now** remembers the answer for 30 days rather than asking on every page.

## The service worker's rules

A service worker that caches badly can pin an old version of a site forever, and
this codebase has already paid for that once — see the comment in
`backend/src/app.js` about a page and a script served from different deploys.
The rules in `sw.js` are deliberately conservative:

- **API calls are never intercepted.** A cached balance, lesson or certificate
  would be wrong in a way that looks like a bug in the academy rather than in a
  cache. `/api/*` and `/health` go straight to the network, always.
- **Writes are never intercepted.** A cached POST is a lie.
- **Pages, scripts and stylesheets are network-first.** The network is always
  tried and its answer always wins, so a deploy lands on the next load exactly as
  it would with no service worker at all. The cache is consulted only after the
  network has already failed.
- **Images and fonts are cache-first**, because they are content-stable.

The net effect while online: nothing changes. While offline: the last page that
worked opens, or the offline page explains itself.

`sw.js` is served with `Cache-Control: no-cache`. That is not an optimisation
detail — a service worker served from cache can never replace itself, so a site
would be stuck on that version permanently.

## Why the icons are generated, not drawn by hand

`backend/scripts/make-icons.js` contains a small PNG decoder and encoder written
against `zlib`, which is in Node. The alternative was `sharp` (a native binary,
around 30 MB per platform, in a container that already has to build) or `jimp`,
for a job that is "read one image, resize it four times". The script also handles
the two things the platforms actually require:

- **Maskable icon.** Android crops the outer 20% of a launcher icon to whatever
  shape the device uses. The emblem is scaled to 72% and centred on the brand
  navy, so a circular crop keeps the whole laurel wreath.
- **Apple touch icon.** 180x180 and fully opaque, because iOS composites
  transparency onto black.

Resizing happens in premultiplied alpha. Interpolating straight RGBA over
transparent pixels leaves a dark halo around the emblem.
