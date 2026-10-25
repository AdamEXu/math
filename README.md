# math

A Flask JSON API (`/api/...`, plus `/auth/...`, `/login`, image and thumbnail serving) with a Vite + React + TypeScript single-page app in `frontend/`, plus WebSockets for live multiplayer editing.

## Local dev

```sh
cp .env.example .env   # fill in the values
FLASK_DEBUG=1 uv run uvicorn asgi:app --reload --port 5050 --env-file .env
```

In a second terminal:

```sh
cd frontend
pnpm install
pnpm dev
```

Open http://localhost:5173. Vite serves the app with hot reload and proxies `/api`, `/auth`, `/login`, `/static`, `/images`, `/graphs`, `/desmos` and the `/ws` WebSockets to the backend on 5050. `flask run` still serves the HTTP API, but realtime editing needs uvicorn.

Google sign-in still runs through Flask on 5050, so the registered redirect URI stays `http://localhost:5050/auth/google/callback`. After the callback, Flask redirects page routes to `FRONTEND_URL` (http://localhost:5173), and the session cookie is shared because cookies ignore the port.
To skip Google locally, set `DEV_LOGIN_EMAIL` in `.env`: the login page then shows a "Dev sign-in" button, plus a field to sign in as any other `@pinewood.edu` address (handy for testing sharing with a second user in a private window). Both only work in debug mode (`FLASK_DEBUG=1`) with a localhost `BASE_URL`.

Graphs are stored in SQLite at `$DATA_DIR/math.db` (default `./data`). Run the backend tests with `uv run pytest` and type-check the frontend with `pnpm typecheck` in `frontend/`.

## Production

The Dockerfile builds `frontend/dist` with pnpm in a Node stage, then serves everything from one uvicorn process on port 8000. To try the production setup without Docker:

```sh
cd frontend && pnpm install --frozen-lockfile && pnpm build && cd ..
FRONTEND_URL= uv run uvicorn asgi:app --port 5050 --env-file .env
```

### Runtime

`asgi.py` is the entry point. WebSocket traffic goes to Starlette handlers in `realtime.py`; all HTTP goes to the Flask app through `a2wsgi` (a thread pool, `WSGI_THREADS`, default 32). It must run as a **single process**: each open graph is a room held in memory, so a second worker or replica would split the people editing a graph. Scaling out would need a broker between processes.

- `/ws/graphs/<id>` speaks the Yjs sync and awareness protocols. The handshake checks the `Origin` against `BASE_URL`/`FRONTEND_URL`, reads the Flask session cookie and the caller's role. Every change a client sends is applied to the room's Y.Doc and only the part that was new is appended to the `updates` log with the sender as author, so resends after a reconnect never duplicate rows. Checkpoints still happen every 200 updates. Viewers' updates are ignored. Clients ping every 15s and reconnect if a ping goes unanswered; the server drops sockets silent for 90s, which tolerates browsers throttling timers in background tabs. Sharing changes push the new role to open sockets or close them.
- `/ws/presence` lets the library watch the graphs it lists and get who is in each, per user, as people come and go.
- `POST /api/graphs/<id>/updates` still works for scripts and is broadcast to open rooms, but the app no longer uses it.

The client keeps each graph's Y.Doc in IndexedDB per user, so edits made offline survive a reload or crash and sync on the next connection.

### Sharing

Graphs have an owner (`graphs.owner_id`), editor/viewer rows in `graph_members`, and `graphs.link_access` (`NULL` = restricted, or `viewer`/`editor` for anyone signed in with the link). Opening a link-shared graph records a row in `graph_link_visits` so it shows under "Shared with you". Image URLs are content hashes, so any signed-in user can read them; that keeps images working for everyone a graph is shared with.

### Desmos bundle

At startup `desmos_bundle.py` downloads the official Desmos v1.13 `calculator.js` with `DESMOS_API_KEY`, applies string-anchored patches that make `tone()` playback cheap (oscillators only for audible list elements, audio recomputed only for changed tone items, and a muted, paused copy of the graph for the hidden calculator behind `asyncScreenshot` so thumbnails don't start a second animated, audible graph) and serves the result at `/desmos/calculator-<commit>-<hash>.js`. The official source is cached in `$DATA_DIR/desmos/` and used when the download fails. If no bundle is available or any anchor doesn't match exactly once, it logs why and `/api/config` lists only the official desmos.com script; the client also falls back to it if the patched script fails to load. The startup log line names the Desmos version and commit, and warns when the commit differs from `PATCHED_COMMIT`. Set `DESMOS_SELF_HOST=0` to always use the official script. To check the patches against a local copy: `uv run python desmos_bundle.py calculator.js patched.js`.

## Folder icons

Folder icons can be any [Lucide](https://lucide.dev) icon. The icon names, SVG markup and search tags are vendored in `static/lucide/icons.json`, which the server uses to validate icon names and the icon picker loads lazily. It is pinned to the same version as `lucide-react` in `frontend/package.json` and `LUCIDE_VERSION` in `frontend/src/icons/registry.ts`. To move to another version, run `uv run python scripts/vendor_lucide.py <version>` and update both to match.
