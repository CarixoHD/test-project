# Vibecode platform

## Requirements

Node ≥ 22.18 from an official build (nodejs.org, nvm/fnm or NodeSource; `.nvmrc` pins 22) and
git ≥ 2.38. Vibecode runs `.ts` files through Node's built-in type stripping, which distro builds
such as the Debian/Ubuntu apt `nodejs` package may lack. The npm scripts that run `.ts` files
(`start`, `dev`, `set-password`, `docker:images`, `docker:prune` and `claude:record`) check Node
first with `scripts/preflight.mjs` and print what to fix. Docker is needed for real agent runs.

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

Vibecode can run agents on your Claude Pro or Max subscription instead of an API key. It does this by running the official, unmodified Claude Code CLI (`@anthropic-ai/claude-code`, pinned in `docker/claude-code.Dockerfile`) inside the agent containers. You either paste a subscription token from `claude setup-token` into Vibecode, or log in once with Anthropic's own login flow; either way Vibecode only starts the CLI. See [ADR 4](docs/decisions/0004-claude-subscription-backend-drive-the-unmodified-c.md) and [ADR 13](docs/decisions/0013-claude-subscription-owner-can-paste-a-claude-setup.md).

### One-time setup

You need Docker. There are two ways to log in. The token is the recommended one; the volume login is the fallback.

**Recommended: paste a subscription token.** On any machine with Claude Code installed, run `claude setup-token`. It opens Anthropic's login and prints a long-lived token (`sk-ant-oat01-…`, valid for a year). Paste it under Settings → Claude Code (the API is `PUT /api/backends/claude-code/token {"token": "…"}`; `{"token": null}` removes it). Vibecode keeps it write-only in its secrets table: it only ever shows whether a token is set and its last 4 characters, and masks it in every log and activity line. Saving a token also clears a **Needs login** status. Each Claude Code run then gets the token as `CLAUDE_CODE_OAUTH_TOKEN` in the container's environment (`docker exec -e CLAUDE_CODE_OAUTH_TOKEN`, with the value passed through the docker CLI's own environment, never on a command line). Vibecode still builds the Claude image on first use; no volume login is needed.

**Fallback: log in to a Docker volume.** Without a token, the CLI uses the login stored in the `vibecode-claude-config` volume. Run these on the machine that runs Vibecode. Settings → Claude Code shows them with copy buttons, filled in for your host:

```sh
# 1. Build the login image (Vibecode also builds it on first use). <base-hash> is a content hash
#    of docker/base.Dockerfile, <hash> one of the base tag and docker/claude-code.Dockerfile.
#    `npm run -s docker:images` prints this command with the current tags filled in.
docker buildx build --load --tag vibecode/base:<base-hash> --file docker/base.Dockerfile docker && \
  docker buildx build --load --tag vibecode/claude-code:<hash> \
  --build-arg BASE_IMAGE=vibecode/base:<base-hash> --file docker/claude-code.Dockerfile docker
# 2. Create the volume that holds the login.
docker volume create vibecode-claude-config
# 3. Log in, as your own uid:gid (the identity agent containers run as).
docker run -it --rm --pull never --user "$(id -u):$(id -g)" \
  -v vibecode-claude-config:/home/agent/.claude vibecode/claude-code:<hash> claude auth login
```

The login stores its state in the `vibecode-claude-config` Docker volume. When a token is set, it takes precedence over the volume login. With either method, choose the **Claude Code** provider for one or more roles under Settings → Models (or per product).

Copy the commands from Settings rather than typing them: the server fills in the current `<hash>` and your uid and gid. The image tags change whenever the pinned CLI version (`CLAUDE_CODE_VERSION`) or `docker/base.Dockerfile` changes, and Vibecode then rebuilds the images. The volume stays the same, so an existing login keeps working. `--pull never` makes sure Docker never fetches a look-alike image from a registry.

**Removing old images.** Each new tag leaves the previous `vibecode/base` and `vibecode/claude-code` images behind, as do plain `latest` tags from older Vibecode versions. `npm run -s docker:prune` prints one `docker image rm ...` command for every local tag of those two repositories that is not current (nothing when there is nothing to remove); it never removes anything itself and never touches other images, product images (`vibecode/p-*`) included. Read it, then run `npm run -s docker:prune | sh` to remove them.

**Volume from an older image.** Docker copies the image's owner and mode into a named volume only when the volume is first mounted. A `vibecode-claude-config` volume created by an older Vibecode image therefore keeps owner 1000:1000 and mode 0700. If your host uid is not 1000, the login (which now runs as your uid:gid) cannot write to it: remove it with `docker volume rm vibecode-claude-config`, then run steps 2 and 3 again to log in.

### How it runs

- Each Claude-backed run uses an image derived `FROM` the product image with the CLI added (`vibecode/claude-code:<hash>` when the product has no Dockerfile). The volume is mounted at `/home/agent/.claude`, and `CLAUDE_CONFIG_DIR` points there. Product Dockerfiles must be Debian/glibc based.
- Sparring with Claude Code runs in a container on an empty scratch directory, not on the repository.
- Claude containers need internet access to reach Anthropic, so they always join the egress network, including reviewers, which keep their read-only mount.
- Stopping a run sends SIGINT to the CLI inside the container so it can end its turn, and SIGKILL after 5 seconds.

### Recording real stream fixtures

The Claude Code backend's parser is tested against NDJSON fixtures in `src/server/agents/fixtures/`. To capture a real stream from your own login (after the one-time setup above):

```sh
npm run -s claude:record -- --help   # options
npm run -s claude:record             # writes src/server/agents/fixtures/real-success.ndjson
npm run -s claude:record -- --out /tmp/run.ndjson --model opus
```

It prints the CLI version, then runs `claude` once in the current `vibecode/claude-code:<hash>` image (the tag `npm run -s docker:images` prints; `--pull never`) as your uid:gid, with the `vibecode-claude-config` volume mounted at `/home/agent/.claude`. It uses exactly the backend's argv (`--output-format stream-json`, `--json-schema`, the read-only tool set) for a tiny task that replies `{"ok":true}`. The raw stdout goes through the secret redactor (values of environment variables whose names contain `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL`) and is written to the fixture file. The exit code is non-zero if the CLI fails; whatever it printed is still written, so error runs can be recorded too. The script never reads the volume itself; only the CLI inside the container does. Review the file before you commit it.

### Status, rate limits and logging in again

Settings → Claude Code shows the current status: **OK**, **Needs login**, or **Rate limited until …**. While Claude Code is rate limited or needs a login, Vibecode does not start runs on it. When the CLI reports that the login expired, paste a new token from `claude setup-token` (this clears the status), or run the volume login command again and press **I've logged in**.

### The token rule

Anthropic's terms forbid using subscription OAuth tokens to call the API directly or through the Agent SDK, and restrict third-party apps that collect or forward subscription credentials. Vibecode is self-hosted and single-user, so its secrets table is your own secret store on your own machine (ADR 13). So:

- **The only token you paste is the one `claude setup-token` prints**, the documented way to give the CLI a login in CI and scripts. Vibecode uses it for nothing except handing it to the official, unmodified CLI as `CLAUDE_CODE_OAUTH_TOKEN`; it never calls the API with it. It is write-only, never in events, and redacted from logs.
- **Never extract tokens** from the volume or from `~/.claude/.credentials.json`. Vibecode never reads the `vibecode-claude-config` volume. It never sets `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` for Claude Code runs (it unsets them), and it never uses `--bare`. A test enforces that no server code outside the sandbox names the volume or the credentials file.
- This backend is for your own, individual use. Use API keys if other people use your Vibecode.

Known risk: any code running in a Claude-backed container, including a malicious dependency of your product, could read the token from its environment or the login in the volume. Only build products whose dependencies you trust.
