# Setup and client connections

## Choose a version

For a stable installation, download the source archive from [release v1.0.0](https://github.com/ttiaMa/pad-mcp/releases/tag/v1.0.0) and extract it, or use Git:

```sh
git clone --branch v1.0.0 https://github.com/ttiaMa/pad-mcp.git pad-mcp
cd pad-mcp
```

To follow development instead, clone the `main` branch. A release tag selects a fixed source version; `main` receives ongoing changes. Both use the same configuration, API key commands and persistent database. No prebuilt container image is published with this release; Docker builds it from the selected source.

The bundled [`knowledge/seed.json`](../knowledge/seed.json) is empty, so a new installation starts with no patterns. Add and publish entries through the Maintainer tools, or supply an approved seed collection before the first startup. Seeding runs once per database; existing collections are preserved. See [Import and export files](usage.md#import-and-export-files).

## Install with Docker Compose

Requires Docker Engine with the Docker Compose plugin, or Docker Desktop. Run the following from the selected source directory. Node.js is included in the image and is not required on the host.

### Configure the instance

Copy `.env.example` to `.env` using your shell or file manager:

```sh
# Linux/macOS
cp .env.example .env
```

```powershell
# PowerShell
Copy-Item .env.example .env
```

Generate a Maintainer token:

```sh
docker run --rm node:24-bookworm-slim node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Put the generated value in `.env` as `MCP_MAINTAINER_TOKEN`. Keep `PUBLIC_URL=http://localhost:8080` for local use; for a public instance, set the external HTTPS origin, such as `PUBLIC_URL=https://mcp.example.com`. Optional settings and defaults are listed in [Deployment and data](deployment.md#configuration).

### Start the service

For local use, or an HTTPS reverse proxy running on the Docker host:

```sh
docker compose -f compose.yaml -f compose.local.yaml up --build -d
docker compose -f compose.yaml -f compose.local.yaml ps
docker compose -f compose.yaml -f compose.local.yaml logs --tail=100 pad-mcp
```

The override publishes `127.0.0.1:8080` on the host. Locally, check `http://localhost:8080/healthz`; the MCP endpoint is `http://localhost:8080/mcp`.

For a public instance, point your domain at the host and configure an HTTPS reverse proxy to forward to `http://127.0.0.1:8080`, preserving the original Host header. Then check `https://mcp.example.com/healthz` and use `https://mcp.example.com/mcp`. If the proxy runs in another container, connect it to the application's Docker network and route to service `pad-mcp` on port 8080; `compose.yaml` alone exposes that port inside Docker without publishing it on the host.

`PUBLIC_URL` is the external origin: omit `/mcp` and the internal port when serving HTTPS on port 443. Run one application instance and preserve the `knowledge_data` volume mounted at `/app/data`. See [backups](deployment.md#back-up-and-restore) and [upgrades](deployment.md#update-an-existing-instance).

### Create a Developer key

From the same source directory:

```sh
docker compose exec pad-mcp npm run keys -- create --name "Roby"
```

Copy the returned token and share it privately. Use the same Compose project name if you configured a custom one. See [API key management](api-keys.md) for listing, deleting and running commands against a specific container.

### Optional: Coolify

Create an application from Git with the **Docker Compose** build strategy and `/compose.yaml`. Supply the environment values in Coolify and route the `pad-mcp` service domain `https://mcp.example.com:8080` to internal port 8080; set `PUBLIC_URL=https://mcp.example.com`. Use the existing `/app/data` volume across redeployments. In the container terminal, run API key commands from `/app`.

For an existing application, pin **Source > Commit SHA** to the commit behind the release tag and disable automatic Git deployments. See [pin a Coolify instance to a release](deployment.md#optional-pin-a-coolify-instance-to-a-release). Interface labels can vary by Coolify version.

## Run directly with Node.js

Requires Node.js 24 or later. From the selected source directory, run `npm ci`, copy `.env.example` to `.env`, and generate a token:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set it as `MCP_MAINTAINER_TOKEN` in `.env`, then run `npm start`. Defaults bind the server to `127.0.0.1:8080`. For a public instance, configure HTTPS through a reverse proxy and set `PUBLIC_URL` to the external origin. Preserve `DATABASE_PATH` and its database when upgrading. Create Developer keys with `npm run keys -- create --name "Roby"` from the project directory.

The endpoint supports MCP `2026-07-28`, `2025-11-25` and earlier SDK-supported revisions. It requires `Authorization: Bearer <token>` and is a protocol interface, not a web page. Development lookups require explicit `power_fx`; clients upgrading from the old `context_id` contract must reconnect to refresh their tool schemas. Unknown or unavailable tools return a JSON-RPC error; application-level tool failures use `isError`.

## Connect Codex or Claude Code

Start or deploy the server first. Replace `https://mcp.example.com/mcp` below with your endpoint, or use `http://localhost:8080/mcp` for a local server.

Both clients use a client-side environment variable named `PAD_MCP_TOKEN`. Set it to the key for the access you need:

| What the agent should do | Value to use for `PAD_MCP_TOKEN` |
| --- | --- |
| Retrieve shared patterns and help write PAD code | Your individual Developer API key, provided by the Maintainer |
| Also add, publish, replace and delete knowledge | The server's `MCP_MAINTAINER_TOKEN` |

For example, enter the token without putting it in shell history in **PowerShell 7**:

```powershell
$env:PAD_MCP_TOKEN = Read-Host 'pad-mcp role token' -MaskInput
```

This sets the variable for the current shell and applications launched from it. Set it again in a new shell, or configure it through your environment/secret-management setup. Desktop and IDE clients must inherit it when they start; an already-running application will not receive a variable set in another terminal. The server's `.env` does not configure either client.

### Codex

With Codex installed, register the remote server:

```sh
codex mcp add pad-mcp --url https://mcp.example.com/mcp --bearer-token-env-var PAD_MCP_TOKEN
codex mcp list
```

Alternatively, merge this entry into `~/.codex/config.toml` (`%USERPROFILE%\.codex\config.toml` on Windows), or a trusted project's `.codex/config.toml`:

```toml
[mcp_servers.pad-mcp]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "PAD_MCP_TOKEN"
```

Choose one setup method. Start Codex from the configured environment and use `/mcp` in the CLI to inspect the connection. Reconnect or restart an existing client after changing the token. This server uses static Bearer authentication, so `codex mcp login` is not required. [Official Codex MCP documentation](https://developers.openai.com/codex/mcp).

### Claude Code

In the project where you use Claude Code, create or merge the following into `.mcp.json`:

```json
{
  "mcpServers": {
    "pad-mcp": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${PAD_MCP_TOKEN}"
      }
    }
  }
}
```

Keep `${PAD_MCP_TOKEN}` literal in the file; Claude Code expands it from its environment. The configuration can be shared with your team without including the secret.

Start `claude` from the configured environment and accept the project MCP approval when prompted. Use `/mcp` to inspect the connection, or `claude mcp list` from the terminal. No OAuth login is needed. [Official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

### Check the connection

Ask either agent:

> Use pad-mcp to load the development context, then search for an approved pattern for processing a list in batches.

An empty result is expected until a Maintainer publishes matching content. Developer connections should expose retrieval tools but no `save_draft` or `delete_pattern` tool. A `401` usually means the client did not inherit `PAD_MCP_TOKEN`, the token is incorrect, or the Developer key has been deleted. Do not paste tokens into chat or commit their values to configuration files.
