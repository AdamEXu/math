<img src="assets/icon.svg" width="64" height="64" alt="">

# math

Created in [T3 Code](https://t3.codes).

## Local dev

```sh
cp .env.example .env   # fill in the values
uv run flask --app app run --debug --port 5050
```

Google sign-in needs `http://localhost:5050/auth/google/callback` registered as a redirect URI on the OAuth client.
