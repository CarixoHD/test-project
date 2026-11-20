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

## Using your Claude subscription (Claude Code)

Vibecode can run agents on your Claude Pro or Max subscription instead of an API key. It does this by running the official, unmodified Claude Code CLI (`@anthropic-ai/claude-code`, pinned in `docker/claude-code.Dockerfile`) inside the agent containers. You log in once with Anthropic's own login flow; Vibecode only starts the CLI. See [ADR 4](docs/decisions/0004-claude-subscription-backend-drive-the-unmodified-c.md).

### One-time setup

You need Docker. Run these on the machine that runs Vibecode. Settings → Claude Code shows them with copy buttons, filled in for your host:

```sh
# 1. Build the login image (Vibecode also builds it on first use). <hash> is a content hash of
#    docker/claude-code.Dockerfile and docker/base.Dockerfile.
docker buildx build --load --tag vibecode/base --file docker/base.Dockerfile docker && \
  docker buildx build --load --tag vibecode/claude-code:<hash> --build-arg BASE_IMAGE=vibecode/base \
  --file docker/claude-code.Dockerfile docker
# 2. Create the volume that holds the login.
docker volume create vibecode-claude-config
# 3. Log in, as your own uid:gid (the identity agent containers run as).
docker run -it --rm --pull never --user "$(id -u):$(id -g)" \
  -v vibecode-claude-config:/home/agent/.claude vibecode/claude-code:<hash> claude auth login
```

The login stores its state in the `vibecode-claude-config` Docker volume. Then choose the **Claude Code** provider for one or more roles under Settings → Models (or per product).

Copy the commands from Settings rather than typing them: the server fills in the current `<hash>` and your uid and gid. The image tag changes whenever the pinned CLI version (`CLAUDE_CODE_VERSION`) changes, and Vibecode then rebuilds the image. The volume stays the same, so an existing login keeps working. `--pull never` makes sure Docker never fetches a look-alike image from a registry.

### How it runs

- Each Claude-backed run uses an image derived `FROM` the product image with the CLI added (`vibecode/claude-code:<hash>` when the product has no Dockerfile). The volume is mounted at `/home/agent/.claude`, and `CLAUDE_CONFIG_DIR` points there. Product Dockerfiles must be Debian/glibc based.
- Sparring with Claude Code runs in a container on an empty scratch directory, not on the repository.
- Claude containers need internet access to reach Anthropic, so they always join the egress network, including reviewers, which keep their read-only mount.
- Stopping a run sends SIGINT to the CLI inside the container so it can end its turn, and SIGKILL after 5 seconds.

### Status, rate limits and logging in again

Settings → Claude Code shows the current status: **OK**, **Needs login**, or **Rate limited until …**. While Claude Code is rate limited or needs a login, Vibecode does not start runs on it. When the CLI reports that the login expired, run the login command again and press **I've logged in**.

### The token rule

Anthropic's terms forbid third-party apps from collecting, storing or forwarding subscription credentials, and from calling the API with subscription OAuth tokens. So:

- **Never extract tokens** from the volume, from `~/.claude/.credentials.json`, or from `claude setup-token`, and never paste them into Vibecode or anything else.
- Vibecode never reads the `vibecode-claude-config` volume. It never sets `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` for Claude Code runs (it unsets them), and it never uses `--bare`. A test enforces that no server code outside the sandbox names the volume or the credentials file.
- This backend is for your own, individual use. Use API keys if other people use your Vibecode.

Known risk: any code running in a Claude-backed container, including a malicious dependency of your product, could read the login in the volume. Only build products whose dependencies you trust.
