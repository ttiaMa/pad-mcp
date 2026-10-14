<p align="center">
  <img src="assets/pad-mcp-logo.png" alt="pad-mcp" width="520">
</p>

**Build Power Automate Desktop flows and migrate RPA code with AI agents that follow your team's development style.**

pad-mcp gives your team's agents a shared collection of approved Robin snippets, development conventions and practical implementation patterns. Use it to develop directly in **Power Automate Desktop**, or to rebuild parts of automations from **UiPath, Blue Prism and other RPA platforms** in PAD.

The agent interprets the task or source automation, retrieves relevant patterns, and adapts its response to the way you develop. pad-mcp supplies the knowledge; it does not execute Robin or automatically convert entire RPA projects.

**Core requirement:** a self-hostable remote MCP server that helps a team produce PAD solutions aligned with shared, approved practices. Developers use the knowledge base; Maintainers curate it directly from chat, with revision control and explicit publication.

Connect multiple developers' agents to the same endpoint so they can reuse the team's patterns. Give the Maintainer credential only to the people responsible for reviewing and updating that shared knowledge. The same setup also works for a solo developer.

## What you can do

- Load shared development conventions before starting a task.
- Choose Classic or Power Fx once per chat, with a persistent context that fixes the mode for subsequent lookups.
- Search external actions and types selectively, with full examples only on exact lookup and a persistent cache retaining the previous valid generation.
- Search approved snippets with area and Power Fx filters, including English/Italian keyword matching.
- Save pasted Robin code exactly, or import a JSON collection from a file.
- Review drafts, publish an exact revision, replace outdated implementations, withdraw entries or permanently delete them.
- Export published knowledge as portable JSON for sharing or use on another instance.
- Deploy one container with SQLite on persistent storage, with no separate database or AI service required.

On first startup, the server creates the SQLite database and loads the configured seed collection. Content contains development fields only; publication approval applies to the original revision and is not a PAD execution test.

## Access roles

| Capability | Developer | Maintainer |
| --- | --- | --- |
| Load context, search and retrieve shared published patterns | Yes | Yes |
| Export shared published patterns | Yes | Yes |
| Manage drafts and revision history | No | Yes |
| Add, import, edit and publish patterns | No | Yes |
| Replace, withdraw or permanently delete patterns | No | Yes |

Roles are enforced on the server using separate Bearer tokens. Developer connections do not expose or accept mutation tools. This release provides two shared role credentials, not individual user accounts. There is one shared knowledge base: every published pattern is available to both roles. Drafts and revision history belong to the Maintainer review workflow. Anonymous access is disabled.

## Use it from chat

Name **pad-mcp** explicitly in your request so the agent knows which MCP server to use. At the start of a new task, ask it to retrieve the initial context:

> Use the pad-mcp MCP server. Call `get_development_context` to load the team's development conventions before working on this task. Then use `search_patterns` to find approved patterns for the implementation needs that arise.

The agent first asks for **Classic or Power Fx**, creates a context and reuses its `context_id`. Development searches return only compatible published snippets. For actions added or adapted, `search_actions` finds candidates by name/module and returns full details by exact `action_id`; `search_type_reference` provides parameter formatting by exact `type_name`. The full JSON catalog stays on the server.

Read the local prompts: [shared guidance](src/prompts/common.md), [Classic](src/prompts/classic.md), [Power Fx](src/prompts/power-fx.md). The technical guidance is adapted from [JoeG592/pad-robin-action-kb](https://github.com/JoeG592/pad-robin-action-kb), licensed CC BY 4.0; see [attribution](src/prompts/NOTICE.md). Catalog paste validation does not certify execution of a generated flow.

**Upgrading:** reconnect clients to refresh tool schemas. `search_patterns` and development `get_pattern` now require `context_id`. Maintainers use `purpose: "maintenance"` for unfiltered draft/history review. SQLite schema 2 migrates additively to 3; knowledge export/import remains version 2. No reset or reimport is required. See [usage](docs/usage.md#initial-context) and [deployment](docs/deployment.md).

As a **Developer**:

> Use pad-mcp to help me build a Power Automate Desktop flow that reads Excel and processes rows in batches. First call `get_development_context`, then search for approved patterns and follow the retrieved conventions when producing Robin code.

> Use pad-mcp to rebuild this part of a Blue Prism or UiPath process in Power Automate Desktop. First call `get_development_context`, then identify the source logic and use `search_patterns` for the relevant PAD implementation steps. Distinguish approved snippets from any adaptations you generate.

As a **Maintainer**:

> Use pad-mcp and first call `get_development_context`. Here is my Robin block and an informal explanation of how I use it. Turn the explanation into a concise, searchable entry with a specific title, problem, approach and relevant tags. Preserve important conditions and limitations, keep the code exactly as pasted, and show me the saved draft for review.

You can provide context conversationally, including a voice transcription from your client. The agent prepares the structured entry before saving: it removes repetition, retains technical details and separates unconfirmed interpretations. The MCP server stores and indexes that prepared entry; it does not run its own summarization model. See [Authoring from informal context](docs/usage.md#authoring-from-informal-context).

> Use pad-mcp to publish revision 1 of `list-batches` with `publish_revision`. I approve this revision for the team's shared knowledge base.

> Use pad-mcp to read the latest revision of `list-batches`, then replace it with this approved implementation using `replace_pattern`. Preserve the previous revisions.

> Use pad-mcp to read the latest revision of `obsolete-example`, then permanently delete it with `delete_pattern`, including its revision history.

Replacement creates and publishes a new revision in one transaction. Deletion removes the entry and all revisions from the live database. Both require the latest revision number, so an outdated request cannot overwrite or delete a newer revision. Withdrawal keeps the history while removing the entry from retrieval.

## Run locally

The bundled [`knowledge/seed.json`](knowledge/seed.json) is empty, so a new installation starts with no patterns. Add and publish entries through the Maintainer tools, or supply an approved seed collection before the first startup. Seeding runs once per database: subsequent restarts preserve edits, withdrawals and deletions. Existing collections are left unchanged.

You can export published patterns, edit the JSON and use it as the seed for a new installation. To update the running collection, use the Maintainer tools. See [Import and export files](docs/usage.md#import-and-export-files).

Requires Node.js 24 or later.

```powershell
npm ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set the generated value as `MCP_MAINTAINER_TOKEN` in `.env`. Optionally generate a different value for `MCP_DEVELOPER_TOKEN`, then run:

```sh
npm start
```

Health check: `http://localhost:8080/healthz`. MCP endpoint: `http://localhost:8080/mcp`, with `Authorization: Bearer <token>`. The endpoint is a protocol interface, not a web page.

## Deploy on Coolify

Docker Compose defines the application, environment, health check and persistent SQLite volume in one place.

1. Make the project available in a Git repository accessible to Coolify.
2. Create an application from the repository, select **Docker Compose**, and use `/compose.yaml`.
3. Set `MCP_MAINTAINER_TOKEN` to a random secret of at least 32 characters and `PUBLIC_URL=https://mcp.example.com`. Optionally set a distinct `MCP_DEVELOPER_TOKEN`.
4. Set the `pad-mcp` service domain to `https://mcp.example.com:8080`. The suffix tells Coolify to route to internal port **8080**; public access still uses standard HTTPS.
5. Deploy, check `https://mcp.example.com/healthz`, then connect your MCP client to `https://mcp.example.com/mcp` using the appropriate role token.

`PUBLIC_URL` must not contain `/mcp` or the internal port in production. The `knowledge_data` volume is mounted at `/app/data` and survives normal redeployments. Run **one instance** and back up the volume separately.

See [Deployment](docs/deployment.md) for configuration and backups, and [Usage](docs/usage.md) for client setup, tools and data formats.

## Connect Codex or Claude Code

Start or deploy the server first. Replace `https://mcp.example.com/mcp` below with your endpoint, or use `http://localhost:8080/mcp` for a local server.

Both clients use a client-side environment variable named `PAD_MCP_TOKEN`. Its value must match one of the server's role tokens:

| What the agent should do | Value to use for `PAD_MCP_TOKEN` |
| --- | --- |
| Retrieve shared patterns and help write PAD code | The server's `MCP_DEVELOPER_TOKEN` |
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

An empty result is expected until a Maintainer publishes matching content. Developer connections should expose retrieval tools but no `save_draft` or `delete_pattern` tool. A `401` usually means the client did not inherit `PAD_MCP_TOKEN`, or its value does not match a configured server token. Do not paste tokens into chat or commit their values to configuration files.

## Development and scope

```sh
npm run check
npm test
```

Tests use the official MCP client against a real HTTP server and temporary SQLite databases. They cover role boundaries, publication, replacement, deletion, retrieval, import/export and persistence. They do not execute PAD flows.

This release uses manually configured Bearer tokens. OAuth, individual account management, an administrative web interface and semantic search are not implemented. Clients must support MCP Streamable HTTP and custom authentication headers or Bearer tokens.

Project documentation, tool descriptions and messages are in English. User-supplied content is preserved in its original language; bilingual search remains available.

You can publish your team's JSON knowledge collection independently from the server code, with a license you choose. No license is assigned automatically to your original content. The external catalog and adapted prompt guidance retain their upstream CC BY 4.0 attribution; see [NOTICE](src/prompts/NOTICE.md).

References: [MCP SDK](https://ts.sdk.modelcontextprotocol.io/server), [Coolify Compose](https://coolify.io/docs/applications/builds/docker-compose), [persistent storage](https://coolify.io/docs/applications/configuration/persistent-storage).
