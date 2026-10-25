# Deployment and data

## Architecture

One Node.js process serves stateless MCP Streamable HTTP with JSON responses. SQLite stores knowledge, the FTS5 index, Developer API key hashes and metadata. No AI provider or remote database is required. Catalog lookups work offline. The server makes no outbound requests for catalogs.

An HTTPS reverse proxy forwards public requests to internal port 8080. The container runs as the unprivileged `node` user. The image uses Node 24; `npm ci` installs the exact dependency versions in the lockfile. Validate base-image updates before deployment.

## Configuration

| Variable | Purpose |
| --- | --- |
| `MCP_MAINTAINER_TOKEN` | Required random secret, at least 32 characters; full knowledge-management access |
| `MCP_CALL_RATE_LIMIT_PER_MINUTE` | Maximum authenticated MCP requests per API key in any rolling 60 seconds; positive integer, default `100` |
| `USAGE_STATS_ENABLED` | `true` by default; set to `false` to stop collecting Developer usage statistics |
| `USAGE_RETENTION_DAYS` | Retain 90 UTC calendar dates by default; accepts 1–365. See [Usage statistics](usage-statistics.md) |
| `PUBLIC_URL` | External origin such as `https://mcp.example.com`, without a path |
| `HOST` | Local default `127.0.0.1`; container uses `0.0.0.0` |
| `PORT` | Application port; Compose uses 8080 |
| `DATABASE_PATH` | Local `./data/knowledge.sqlite`; container `/app/data/knowledge.sqlite` |

The application rejects missing Maintainer credentials or values shorter than 32 characters. Server and transfer script require `MCP_MAINTAINER_TOKEN`; a Developer key cannot mutate knowledge, but can load development guidance.

### Where environment values come from

`.env.example` is a local setup template, not a file loaded by the application. The server and CLI commands optionally read `.env` in the working directory. Missing `.env` files are silent; existing process variables take precedence. Docker excludes `.env` files from the image, so deployed containers receive configuration through their environment.

| Variable | Local `.env.example` | Bundled Docker Compose |
| --- | --- | --- |
| `MCP_MAINTAINER_TOKEN` | Empty; set your secret | Required; supply through Compose or the container environment |
| `MCP_CALL_RATE_LIMIT_PER_MINUTE` | `100` | Configurable; defaults to `100` |
| `PUBLIC_URL` | `http://localhost:8080` | Required; set the deployment's HTTPS origin |
| `HOST` | `127.0.0.1` | Fixed at `0.0.0.0` |
| `PORT` | `8080` | Fixed at `8080` |
| `DATABASE_PATH` | `./data/knowledge.sqlite` | Fixed at `/app/data/knowledge.sqlite` |
| `USAGE_STATS_ENABLED` | `true` | Configurable; defaults to `true` |
| `USAGE_RETENTION_DAYS` | `90` | Configurable; defaults to `90` |

The Dockerfile additionally sets `NODE_ENV=production`, along with the container's host, port and database path. `MCP_URL` is an optional endpoint override for the transfer CLI; `PAD_MCP_TOKEN` belongs to client configuration, not the server.

The Compose references expose `MCP_MAINTAINER_TOKEN`, `MCP_CALL_RATE_LIMIT_PER_MINUTE`, `PUBLIC_URL`, `USAGE_STATS_ENABLED` and `USAGE_RETENTION_DAYS` as configurable values. Fixed Compose values must be changed in the Compose definition or an override. Developer authentication uses database keys only; there is no Developer-token environment setting. For a separate test instance, use its own credentials, URL and data volume.

### Database initialization

On first startup, pad-mcp creates the SQLite database with patterns, revisions and the FTS5 search index. Subsequent starts reopen the same database without resetting its content.

The image includes `knowledge/seed.json`. On an empty, uninitialized database, startup validates and publishes that package in one transaction before accepting connections. Deploy only content you approve for the team in this file. A database completion marker makes this a one-time operation, including for empty seeds; later restarts never restore deleted entries or overwrite team edits. Existing nonempty collections are marked initialized and preserved without loading seeds. Invalid seeds on a fresh database prevent startup and can be corrected before retrying.

To distribute an edited JSON export as the starting collection for a new installation, replace `knowledge/seed.json` before building the image. This does not update an existing database; use the Maintainer tools for ongoing changes. JSON export is not a full database backup.

The database is stored on the `knowledge_data` volume at `/app/data/knowledge.sqlite`. Keep that volume attached across redeployments.

Schemas 2-6 upgrade to schema 7. Earlier migrations add Developer keys, daily usage counters and last-use timestamps as needed; schema 6 removes obsolete key status/import metadata and previously disabled keys with their counters. Schema 7 deletes the obsolete development-context table, its rows and its immutability trigger. Active keys, statistics, snippets, revisions, the search index and the knowledge seed marker are preserved. No per-chat rows are created. Back up the volume before deploying an upgrade. Older binaries cannot open schema 7: rollback requires restoring the pre-upgrade backup rather than resetting the schema number. Portable export/import remains version 2 and does not include API keys or usage statistics. Published legacy entries with unspecified mode stay available for maintenance/export but are excluded from development; new publication and seed entries require explicit classification.

### Bundled catalogs

The application and Docker image bundle the Classic and Power Fx action/type JSON files. Both editions are available offline and checked against their bundled SHA-256 metadata. There is no background checker, download mechanism or MCP update tool. To change versions, manually update the project bundle and release it; see [catalog maintenance](catalog.md#stage-2-bundled-catalogs).

Old catalog cache files are retained but ignored, and `CATALOG_CACHE_PATH` is no longer used. After upgrading, the installed bundle takes precedence over any previously downloaded snapshot. No database migration or deletion is required.

`/healthz` checks the knowledge database; it does not certify catalog validity or PAD execution. To verify a deployment, reconnect an MCP client, choose a mode, search an action and retrieve its exact record and a type. Then restart and repeat using the same explicit power_fx value. The Dockerfile includes prompts through `COPY src` and all bundled catalogs through `COPY catalogs`.

### Request boundary

Unknown Host headers and Origins different from `PUBLIC_URL` are rejected. Non-browser MCP clients can omit Origin. Update `PUBLIC_URL` when changing the domain. Do not enable broad CORS to bypass these checks.

The Maintainer authenticates with `MCP_MAINTAINER_TOKEN`. Developers authenticate with individual keys created from the server terminal; SQLite stores only their hashes and metadata. Deleting a Developer key rejects subsequent requests without restarting the server. See [API key management](api-keys.md) for commands and key rotation. No SQL port needs to be exposed.

## Local Docker Compose

With Docker installed and `.env` configured (`PUBLIC_URL=http://localhost:8080`):

```sh
docker compose -f compose.yaml -f compose.local.yaml up --build -d
```

The local override publishes port 8080 on loopback only. For a containerized reverse proxy on the application network, use `compose.yaml` alone and route to `pad-mcp:8080`. For a reverse proxy on the host, the loopback override also works with an HTTPS `PUBLIC_URL`.

## Update an existing instance

A GitHub release identifies a fixed Git tag, such as `v1.0.0`. It includes source archives containing the Dockerfile, Compose files, catalogs and lockfile. A Git checkout at that tag and an extracted release archive use the same build and runtime configuration. Release notes describe changes, migration requirements and relevant commits. Keep published tags fixed.

The `latest` branch follows the most recent stable GitHub release. It advances only when that release is published; normal commits to `main` do not move it. To use it in a clean checkout, run `git fetch origin`, `git switch latest`, and `git pull --ff-only origin latest`, then rebuild as below. Use a version tag when you want to stay on one exact release.

Before updating, read the target release notes, back up the data volume, and check `git status` if using Git. Preserve your `.env`, existing Compose overrides, project name, volume and domain. Compose normally derives its project name from the directory: extracting a new archive into a differently named directory can select a different volume. Reuse the existing directory/project identity rather than creating a second stack.

For a Git checkout, fetch tags and select the published release you want. For the initial stable version:

```sh
git fetch origin --tags
git checkout --detach v1.0.0
```

For an archive installation, replace application sources with those from the target release while keeping local configuration and data. Rebuild using the same Compose files and project name as before. For the host-proxy/local configuration in the setup guide:

```sh
docker compose -f compose.yaml -f compose.local.yaml up --build -d
docker compose -f compose.yaml -f compose.local.yaml ps
```

If your proxy uses the Docker network and you originally deployed with `compose.yaml` alone, use `docker compose up --build -d` instead. Verify `/healthz`, reconnect your MCP client and check a known lookup and API key. Startup applies supported database migrations automatically; it does not reset the collection. An older application may not support a migrated database, so rollback can require the matching pre-upgrade backup.

To follow development instead, use `git switch main` and `git pull --ff-only origin main` in a clean checkout, then perform the same backup, build and verification steps. Builds follow your selected source; neither installation method updates itself automatically. Deployments following `main` can receive changes before a stable release is published.

### Optional: Coolify release settings

Keep the existing application, `/compose.yaml`, environment, domain and `/app/data` volume. Back up the volume before redeploying. In **Source**, set **Branch** to `latest` and **Commit SHA** to `HEAD`. Select manual deployments under **Advanced > Deployment > Auto deploy** (older versions expose an Auto Deploy toggle), then save and redeploy. Each manual redeployment takes the latest stable release; commits on `main` are excluded. Confirm the commit in deployment logs, check `/healthz` and reconnect the MCP client.

To stay on one exact release instead, keep branch `main` and put the full output of `git rev-list -n 1 v1.0.0` in **Commit SHA** after fetching tags. Coolify's resource-group Tags are unrelated to Git release tags. Labels vary by version; see [source settings](https://github.com/coollabsio/coolify/blob/main/resources/views/livewire/project/application/source.blade.php) and [automatic deployments](https://coolify.io/docs/applications/deployments/automatic-deployments). Configure separate environment values and storage for any Preview instance.

### Maintaining the stable release branch

The [release-channel workflow](../.github/workflows/release-channel.yml) advances `latest` to the tag's commit after a stable release is published and GitHub identifies it as the latest release. It ignores drafts, prereleases and other releases, and never force-pushes or changes version tags. Publish from `main`; keep development commits on `main` rather than merging them into `latest`. To initialize or resync the branch, run the workflow manually from GitHub Actions. Release events use the workflow stored in the release tag, so future release tags must include it; manual runs use `main`.

## Back up and restore

JSON export includes only currently published revisions, without drafts, history, API keys or usage statistics. For a full backup:

1. Stop the service and wait for the process to exit.
2. Copy or snapshot the `knowledge_data` volume, including any SQLite `-wal` and `-shm` files present.
3. Restart the service and store the backup separately.

For an online backup, use a tool supporting the SQLite Backup API. Do not copy only the `.sqlite` file while it is being written.

To restore, stop the service and restore the complete backup into the volume with read/write permissions for the image's `node` user (UID 1000), then restart. Check `/healthz`, list entries and run a known search. Periodically test recovery on a separate instance.

Do not use `docker compose down -v` when you intend to preserve the collection. Moving to another server also requires transferring the data volume.

Permanent deletion removes a pattern and all its revisions from the live application's tables and index. It does not remove previous exports or backups and is not a secure disk-erasure mechanism. Old deleted data must not be accidentally republished after a backup restore.

## MCP request rate limit

`MCP_CALL_RATE_LIMIT_PER_MINUTE=100` permits 100 authenticated requests to `/mcp` in any rolling 60 seconds for each API key. All chats and clients using the same key share its budget. Each Developer key has a separate budget; the Maintainer key uses the same configured limit with its own budget. Connection messages, discovery, tool listings and rejected tool calls count too. `/healthz` and local API key commands are excluded.

Requests over the limit receive HTTP `429` with `Retry-After` in seconds before body parsing or tool execution. Rejections do not extend the wait. Clients must wait before retrying; automatic retries depend on the client. The transfer CLI handles these rejections with bounded retries. Rejected requests do not appear as tool executions in usage statistics.

Counters stay in process memory, expire after inactivity and reset on restart. Change the environment value and restart/redeploy to apply it; for example, set `1000` for a higher allowance. This is a per-key limit, not a total server capacity guarantee or a restriction on simultaneous requests. A key can use its whole budget in a burst. Invalid credentials are rejected before counting; proxy and anonymous-traffic protections remain the instance operator's responsibility. Multiple processes or replicas would need shared counters.

## Current limits

- One application instance and one shared knowledge collection.
- Lexical search with a small synonym dictionary, without semantic embeddings or a ranking benchmark against a real corpus.
- Up to 64,000 characters of Robin per entry and HTTP request bodies up to 2 MB. Keep patterns focused; split large imports into smaller batches when needed.
- Atomic imports of at most 20 entries per tool call. Larger CLI imports use multiple transactions; failure in a later batch leaves earlier batches imported and reports progress.
- Paginated exports: avoid publication or deletion while exporting a large collection to obtain a consistent result.
- Static Bearer authentication without automatic OAuth discovery or login.
- The server does not execute PAD flows or track a test status.
