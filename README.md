# Vibecode platform

## Remote access

By default Vibecode listens on `127.0.0.1` only. Without a password it refuses to start on any
other `VIBECODE_HOST`, and it answers only requests whose `Host` header is loopback. This blocks
DNS-rebinding attacks from web pages you visit.

To reach it from other devices:

1. Set an owner password (at least 12 characters). Run `npm run set-password` on the host; it
   prompts without echo, or reads the first line of stdin when piped. You can also set it through
   `POST /api/settings/password` `{current?, next}`. Setting or changing the password logs out
   every session.
2. Choose how to expose Vibecode. Do not put plain HTTP on an untrusted network:
   - **Tailscale (recommended):** keep `VIBECODE_HOST=127.0.0.1` and run
     `tailscale serve --bg 4317`. Other devices on your tailnet then reach it over HTTPS.
     Alternatively, bind to the machine's Tailscale IP (`VIBECODE_HOST=100.x.y.z`).
   - **TLS reverse proxy** (Caddy, nginx, …): keep `VIBECODE_HOST=127.0.0.1` and proxy to it. The
     proxy must forward the original `Host` header and set `X-Forwarded-Proto: https`, so that
     the session cookie is marked `Secure`. It must also not buffer `text/event-stream`
     responses.
3. Log in with `POST /api/login` `{password}`. The session is an HMAC-signed, HttpOnly,
   SameSite=Strict cookie that lasts 30 days.

With a password set, every `/api` route except `/api/login` and `/api/session` needs a session.
Login attempts are limited to 5 per minute per client address. Behind a proxy, all clients share
the proxy's address. Requests that change data must be `application/json`, and their `Origin`,
when present, must match the `Host` they were sent to.

Forgot the password? Run `npm run set-password` again on the host; it does not ask for the old one.
