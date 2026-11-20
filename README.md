# Vibecode platform

## Using your Claude subscription (Claude Code)

Vibecode can run agents on your Claude Pro or Max subscription instead of an API key. It does this by running the official, unmodified Claude Code CLI (`@anthropic-ai/claude-code`, pinned in `docker/claude-code.Dockerfile`) inside the agent containers. You log in once with Anthropic's own login flow; Vibecode only starts the CLI. See [ADR 4](docs/decisions/0004-claude-subscription-backend-drive-the-unmodified-c.md).

### One-time setup

You need Docker. Run these on the machine that runs Vibecode (the Settings page shows them with copy buttons):

```sh
npm run docker:claude-code    # builds vibecode/base and vibecode/claude-code (Vibecode also builds them on first use)
docker volume create vibecode-claude-config
docker run -it --rm -v vibecode-claude-config:/home/agent/.claude vibecode/claude-code claude auth login
```

The login stores its state in the `vibecode-claude-config` Docker volume. Then choose the **Claude Code** provider for one or more roles under Settings → Models (or per product).

The login runs as uid 1000, and agent containers run as your own uid. If `id -u` is not 1000, add `--user "$(id -u):$(id -g)"` to the login command so the agents can read the login.

### How it runs

- Each Claude-backed run uses an image derived `FROM` the product image with the CLI added (`vibecode/claude-code` when the product has no Dockerfile). The volume is mounted at `/home/agent/.claude`, and `CLAUDE_CONFIG_DIR` points there. Product Dockerfiles must be Debian/glibc based.
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
