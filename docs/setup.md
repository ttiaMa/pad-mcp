# Setup and client connections

## Run locally

The bundled [`knowledge/seed.json`](../knowledge/seed.json) is empty, so a new installation starts with no patterns. Add and publish entries through the Maintainer tools, or supply an approved seed collection before the first startup. Seeding runs once per database: subsequent restarts preserve edits, withdrawals and deletions. Existing collections are left unchanged.

You can export published patterns, edit the JSON and use it as the seed for a new installation. To update the running collection, use the Maintainer tools. See [Import and export files](usage.md#import-and-export-files).

Requires Node.js 24 or later.

```powershell
npm ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set the generated value as `MCP_MAINTAINER_TOKEN` in `.env`, then run:

```sh
npm start
```

Health check: `http://localhost:8080/healthz`. MCP endpoint: `http://localhost:8080/mcp`, with `Authorization: Bearer <token>`. The endpoint is a protocol interface, not a web page.

To give a Developer access, open another terminal in the project directory and create an individual key:

```sh
npm run keys -- create --name "Roby"
```

Copy the returned token and share it privately. See [API key management](api-keys.md) for listing and deleting keys.

## Deploy on Coolify

Docker Compose defines the application, environment, health check and persistent SQLite volume in one place.

1. Make the project available in a Git repository accessible to Coolify.
2. Create an application from the repository, select **Docker Compose**, and use `/compose.yaml`.
3. Set `MCP_MAINTAINER_TOKEN` to a random secret of at least 32 characters and `PUBLIC_URL=https://mcp.example.com`.
4. Set the `pad-mcp` service domain to `https://mcp.example.com:8080`. The suffix tells Coolify to route to internal port **8080**; public access still uses standard HTTPS.
5. Deploy, check `https://mcp.example.com/healthz`, then connect your MCP client to `https://mcp.example.com/mcp` using the Maintainer key.
6. To give Developers access, open the application container's terminal, run `cd /app`, then `npm run keys -- create --name "Roby"`. Share the returned token privately with its recipient. See [API key management](api-keys.md).

`PUBLIC_URL` must not contain `/mcp` or the internal port in production. The `knowledge_data` volume is mounted at `/app/data` and survives normal redeployments. Run **one instance** and back up the volume separately.

See [environment defaults](deployment.md#where-environment-values-come-from) for the local template, container settings and Coolify Production/Preview groups. Developer keys are created through the CLI and do not require a server environment variable.

See [Deployment](deployment.md) for configuration and backups, and [Usage](usage.md) for client setup, tools and data formats.

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
