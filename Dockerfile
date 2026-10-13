# Deployment image.
#
# This exists because the deployment served an API with no pages for ten days and
# nothing reported it as broken. The cause was not the app: the builder shipped
# only `backend/` — the nearest directory holding a package.json — and the pages
# live beside it, in `frontend/public`. Every page URL, including `/`, then came
# back as the API's own JSON 404, which reads as a routing fault rather than a
# missing directory.
#
# `scripts/stage-pages.js` copies the pages in beside the app to survive exactly
# that, but it runs from `npm run build:deploy`, and the previous `railpack.json`
# asked for it under a key that does not exist in the Railpack schema
# (`build.commands.build` — the schema has no `build` key at all). So the staging
# never ran, the config looked correct to a reader, and nothing failed loudly.
#
# A Dockerfile is used here instead of a platform config file because its
# behaviour is not open to interpretation: what is written is what runs. Railway
# prefers a Dockerfile over Railpack when one is present.

FROM node:22-slim

WORKDIR /app

# The whole repository, not just backend/. The pages have to be present for the
# staging step below to copy them, and they are what was missing before.
COPY . .

WORKDIR /app/backend

# `npm ci` installs exactly what the lockfile pins. `build:deploy` runs
# `scripts/check.js` (every source file parses, every relative import resolves,
# every declared dependency is installed, the pages are present) and then
# `scripts/stage-pages.js`, which copies `frontend/public` to `backend/public` so
# the pages travel inside the image rather than beside it.
#
# A failure here fails the build, which is the point: a broken build must not
# produce a container that answers `/health` cheerfully while serving no pages.
RUN npm ci && npm run build:deploy

# Railway injects its own PORT; this is the documented default the app falls back
# to and is informational only.
ENV NODE_ENV=production
EXPOSE 5000

CMD ["node", "server.js"]
