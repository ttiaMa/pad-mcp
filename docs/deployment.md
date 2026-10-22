# Deployment and data

## Architecture

One Node.js process serves stateless MCP Streamable HTTP with JSON responses. SQLite stores knowledge, the FTS5 index, persistent development contexts and Developer API key hashes and metadata. No AI provider or remote database is required. Catalog lookups work offline. The server makes no outbound requests for catalogs.

Coolify's reverse proxy terminates HTTPS and forwards traffic to internal port 8080. The container runs as the unprivileged `node` user. The image uses Node 24; `npm ci` installs the exact dependency versions in the lockfile. Validate base-image updates before deployment.

## Configuration

| Variable | Purpose |
| --- | --- |
| `MCP_MAINTAINER_TOKEN` | Required random secret, at least 32 characters; full knowledge-management access |
| `USAGE_STATS_ENABLED` | `true` by default; set to `false` to stop collecting Developer usage statistics |
| `USAGE_RETENTION_DAYS` | Retain 90 UTC calendar dates by default; accepts 1–365. See [Usage statistics](usage-statistics.md) |
| `PUBLIC_URL` | External origin such as `https://mcp.example.com`, without a path |
| `HOST` | Local default `127.0.0.1`; container uses `0.0.0.0` |
| `PORT` | Application port; Compose uses 8080 |
| `DATABASE_PATH` | Local `./data/knowledge.sqlite`; container `/app/data/knowledge.sqlite` |

The application rejects missing Maintainer credentials or values shorter than 32 characters. Server and transfer script require `MCP_MAINTAINER_TOKEN`; a Developer key cannot mutate knowledge, but can create development contexts.

### Where environment values come from

`.env.example` is a local setup template, not a file loaded by the application. The server and CLI commands optionally read `.env` in the working directory. Missing `.env` files are silent; existing process variables take precedence. Docker excludes `.env` files from the image, so Coolify normally supplies configuration directly to the container.

| Variable | Local `.env.example` | Bundled Docker Compose |
| --- | --- | --- |
| `MCP_MAINTAINER_TOKEN` | Empty; set your secret | Required; supply through Coolify or Compose |
| `PUBLIC_URL` | `http://localhost:8080` | Required; set the deployment's HTTPS origin |
| `HOST` | `127.0.0.1` | Fixed at `0.0.0.0` |
| `PORT` | `8080` | Fixed at `8080` |
| `DATABASE_PATH` | `./data/knowledge.sqlite` | Fixed at `/app/data/knowledge.sqlite` |
| `USAGE_STATS_ENABLED` | `true` | Configurable; defaults to `true` |
| `USAGE_RETENTION_DAYS` | `90` | Configurable; defaults to `90` |

The Dockerfile additionally sets `NODE_ENV=production`, along with the container's host, port and database path. The application does not use `NODE_ENV` to select Coolify environment groups. `MCP_URL` is an optional endpoint override for the transfer CLI; `PAD_MCP_TOKEN` belongs to client configuration, not the server.

Coolify has separate [Production and Preview variable groups](https://coolify.io/docs/applications/configuration/environment-variables). Production is the main deployment; Preview is for pull-request deployments. The Compose references expose `MCP_MAINTAINER_TOKEN`, `PUBLIC_URL`, `USAGE_STATS_ENABLED` and `USAGE_RETENTION_DAYS` as configurable values. Fixed Compose values are not overridden merely by adding similarly named entries to the dashboard.

Review both groups when removing an obsolete setting from an existing application. Developer authentication uses database keys only; there is no Developer-token environment setting. Use separate Maintainer credentials and the correct `PUBLIC_URL` for a preview, then redeploy the affected environment after saving changes.

### Database initialization

On first startup, pad-mcp creates the SQLite database with patterns, revisions and the FTS5 search index. Subsequent starts reopen the same database without resetting its content.

The image includes `knowledge/seed.json`. On an empty, uninitialized database, startup validates and publishes that package in one transaction before accepting connections. Deploy only content you approve for the team in this file. A database completion marker makes this a one-time operation, including for empty seeds; later restarts never restore deleted entries or overwrite team edits. Existing nonempty collections are marked initialized and preserved without loading seeds. Invalid seeds on a fresh database prevent startup and can be corrected before retrying.

To distribute an edited JSON export as the starting collection for a new installation, replace `knowledge/seed.json` before building the image. This does not update an existing database; use the Maintainer tools for ongoing changes. JSON export is not a full database backup.

The database is stored on the `knowledge_data` volume at `/app/data/knowledge.sqlite`. Keep that volume attached across redeployments.

Schemas 2–5 upgrade to schema 6. Earlier migrations add development contexts, Developer keys, daily usage counters and last-use timestamps as needed. Schema 6 removes the obsolete key status column and import marker. Previously disabled keys and their counters are deleted so they cannot regain access; active keys, their statistics, snippets, revisions, contexts and the knowledge seed marker are preserved. Back up the volume before deploying an upgrade. Older binaries supporting only schemas 2–5 cannot open schema 6: rollback requires restoring the pre-upgrade backup rather than resetting the schema number. Portable export/import remains version 2 and does not include API keys or usage statistics. Published legacy entries with unspecified mode stay available for maintenance/export but are excluded from development; new publication and seed entries require explicit classification.

### Bundled catalogs

The application and Docker image bundle the Classic and Power Fx action/type JSON files. Both editions are available offline and checked against their bundled SHA-256 metadata. There is no background checker, download mechanism or MCP update tool. To change versions, manually update the project bundle and release it; see [catalog maintenance](catalog.md#stage-2-bundled-catalogs).

Old catalog cache files are retained but ignored, and `CATALOG_CACHE_PATH` is no longer used. After upgrading, the installed bundle takes precedence over any previously downloaded snapshot. No database migration or deletion is required.

`/healthz` checks the knowledge database; it does not certify catalog validity or PAD execution. To verify a deployment, reconnect an MCP client, choose a mode, search an action and retrieve its exact record and a type. Then restart and repeat using the same context ID. The Dockerfile includes prompts through `COPY src` and all bundled catalogs through `COPY catalogs`.

### Request boundary

Unknown Host headers and Origins different from `PUBLIC_URL` are rejected. Non-browser MCP clients can omit Origin. Update `PUBLIC_URL` when changing the domain. Do not enable broad CORS to bypass these checks.

The Maintainer authenticates with `MCP_MAINTAINER_TOKEN`. Developers authenticate with individual keys created from the server terminal; SQLite stores only their hashes and metadata. Deleting a Developer key rejects subsequent requests without restarting the server. See [API key management](api-keys.md) for commands and key rotation. No SQL port needs to be exposed.

## Local Docker Compose

With Docker installed and `.env` configured (`PUBLIC_URL=http://localhost:8080`):

```sh
docker compose -f compose.yaml -f compose.local.yaml up --build -d
```

The local override publishes port 8080 on loopback only. On Coolify, use `compose.yaml` alone; the proxy handles public HTTPS routing.

## Back up and restore

JSON export includes only currently published revisions, without drafts, history, API keys or usage statistics. For a full backup:

1. Stop the service and wait for the process to exit.
2. Copy or snapshot the `knowledge_data` volume, including any SQLite `-wal` and `-shm` files present.
3. Restart the service and store the backup separately.

For an online backup, use a tool supporting the SQLite Backup API. Do not copy only the `.sqlite` file while it is being written.

To restore, stop the service and restore the complete backup into the volume with read/write permissions for the image's `node` user (UID 1000), then restart. Check `/healthz`, list entries and run a known search. Periodically test recovery on a separate instance.

Do not use `docker compose down -v` when you intend to preserve the collection. Moving to another Coolify server also requires transferring the data volume.

Permanent deletion removes a pattern and all its revisions from the live application's tables and index. It does not remove previous exports or backups and is not a secure disk-erasure mechanism. Old deleted data must not be accidentally republished after a backup restore.

## Current limits

- One application instance and one shared knowledge collection.
- Lexical search with a small synonym dictionary, without semantic embeddings or a ranking benchmark against a real corpus.
- Up to 64,000 characters of Robin per entry and HTTP request bodies up to 2 MB. Keep patterns focused; split large imports into smaller batches when needed.
- Atomic imports of at most 20 entries per tool call. Larger CLI imports use multiple transactions; failure in a later batch leaves earlier batches imported and reports progress.
- Paginated exports: avoid publication or deletion while exporting a large collection to obtain a consistent result.
- Static Bearer authentication without automatic OAuth discovery or login.
- The server does not execute PAD flows or track a test status.
