<img src="assets/icon.svg" width="64" height="64" alt="">

# math

Created in [T3 Code](https://t3.codes).

A Flask JSON API (`/api/...`, plus `/auth/...`, `/login`, image and thumbnail serving) with a Vite + React + TypeScript single-page app in `frontend/`.

## Local dev

```sh
cp .env.example .env   # fill in the values
uv run flask --app app run --debug --port 5050
```

In a second terminal:

```sh
cd frontend
pnpm install
pnpm dev
```

Open http://localhost:5173. Vite serves the app with hot reload and proxies `/api`, `/auth`, `/login`, `/static`, `/images` and `/graphs` to Flask on 5050.

Google sign-in still runs through Flask on 5050, so the registered redirect URI stays `http://localhost:5050/auth/google/callback`. After the callback, Flask redirects page routes to `FRONTEND_URL` (http://localhost:5173), and the session cookie is shared because cookies ignore the port.
To skip Google locally, set `DEV_LOGIN_EMAIL` in `.env`: the login page then shows a "Dev sign-in" button. It only works when Flask runs in debug mode with a localhost `BASE_URL`.

Graphs are stored in SQLite at `$DATA_DIR/math.db` (default `./data`). Run the backend tests with `uv run pytest` and type-check the frontend with `pnpm typecheck` in `frontend/`.

## Production

The Dockerfile builds `frontend/dist` with pnpm in a Node stage, then serves it from Flask under gunicorn on port 8000. To try the production setup without Docker:

```sh
cd frontend && pnpm install --frozen-lockfile && pnpm build && cd ..
FRONTEND_URL= uv run flask --app app run --port 5050
```

## Folder icons

Folder icons can be any [Lucide](https://lucide.dev) icon. The icon names, SVG markup and search tags are vendored in `static/lucide/icons.json`, which the server uses to validate icon names and the icon picker loads lazily. It is pinned to the same version as `lucide-react` in `frontend/package.json` and `LUCIDE_VERSION` in `frontend/src/icons/registry.ts`. To move to another version, run `uv run python scripts/vendor_lucide.py <version>` and update both to match.
