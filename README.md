<img src="assets/icon.svg" width="64" height="64" alt="">

# math

Created in [T3 Code](https://t3.codes).

## Local dev

```sh
cp .env.example .env   # fill in the values
uv run flask --app app run --debug --port 5050
```

Google sign-in needs `http://localhost:5050/auth/google/callback` registered as a redirect URI on the OAuth client.
To skip Google locally, set `DEV_LOGIN_EMAIL` in `.env`: the login page then shows a "Dev sign-in" button. It only works when Flask runs in debug mode with a localhost `BASE_URL`.

Graphs are stored in SQLite at `$DATA_DIR/math.db` (default `./data`). Run the tests with `uv run pytest`.

Folder icons can be any [Lucide](https://lucide.dev) icon. The icon names, SVG markup and search tags are vendored in `static/lucide/icons.json`, pinned to the same Lucide version as the `lucide` import in `templates/_head.html`. To regenerate it for another version, run `uv run python scripts/vendor_lucide.py <version>` and update the import map to match.
