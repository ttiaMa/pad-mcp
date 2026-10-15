# Deployment and data

## Architecture

One Node.js process serves stateless MCP Streamable HTTP with JSON responses. SQLite stores knowledge, the FTS5 index and persistent development contexts. No AI provider or remote database is required. Catalog lookups use outbound HTTPS to `api.github.com` and `raw.githubusercontent.com`; approved snippet workflows and initial prompts work without GitHub. No credentials are sent to GitHub.

Coolify's reverse proxy terminates HTTPS and forwards traffic to internal port 8080. The container runs as the unprivileged `node` user. The image uses Node 24; `npm ci` installs the exact dependency versions in the lockfile. Validate base-image updates before deployment.

## Configuration

| Variable | Purpose |
| --- | --- |
| `MCP_MAINTAINER_TOKEN` | Required random secret, at least 32 characters; full knowledge-management access |
| `MCP_DEVELOPER_TOKEN` | Optional separate secret; read-only access to all published entries |
| `PUBLIC_URL` | External origin such as `https://mcp.example.com`, without a path |
| `HOST` | Local default `127.0.0.1`; container uses `0.0.0.0` |
| `PORT` | Application port; Compose uses 8080 |
| `DATABASE_PATH` | Local `./data/knowledge.sqlite`; container `/app/data/knowledge.sqlite` |
| `CATALOG_CACHE_PATH` | Optional; defaults to `catalog-cache` beside the database. Compose uses `/app/data/catalog-cache` in the same persistent volume |

The application rejects missing or short Maintainer credentials, short Developer credentials when supplied, and equal Developer/Maintainer tokens. Server and transfer script require `MCP_MAINTAINER_TOKEN`; a Developer token cannot mutate knowledge, but can create development contexts.

### Database initialization

On first startup, pad-mcp creates the SQLite database with patterns, revisions and the FTS5 search index. Subsequent starts reopen the same database without resetting its content.

The image includes `knowledge/seed.json`. On an empty, uninitialized database, startup validates and publishes that package in one transaction before accepting connections. Deploy only content you approve for the team in this file. A database completion marker makes this a one-time operation, including for empty seeds; later restarts never restore deleted entries or overwrite team edits. Existing nonempty collections are marked initialized and preserved without loading seeds. Invalid seeds on a fresh database prevent startup and can be corrected before retrying.

To distribute an edited JSON export as the starting collection for a new installation, replace `knowledge/seed.json` before building the image. This does not update an existing database; use the Maintainer tools for ongoing changes. JSON export is not a full database backup.

The database is stored on the `knowledge_data` volume at `/app/data/knowledge.sqlite`. Keep that volume attached across redeployments.

Schema 2 upgrades additively to schema 3 without changing snippet content, revision history or the seed marker. Back up the volume before deploying an upgrade. Older binaries supporting only SQLite schema 2 cannot open schema 3: rollback requires restoring the pre-upgrade backup rather than resetting the schema number. Portable export/import remains version 2. Published legacy entries with unspecified mode stay available for maintenance/export but are excluded from development; new publication and seed entries require explicit classification.

### Catalog persistence and outages

Both editions are downloaded lazily, when their tools are used. A shared cache checks `main` at most once every 12 hours per edition in a running process, resolving a commit and fetching both JSON files from that commit. It retains active and previous validated pairs with checksums. Failed downloads, invalid responses and remote deletions keep the last valid pair; startup validates disk data and can recover the previous pair. First use without a valid cache fails explicitly when GitHub is unavailable. Unauthenticated GitHub rate limits are handled as refresh failures.

The cache directory must be writable by the service user and remain on persistent storage. Include it in volume backups. Do not delete it to resolve a temporary upstream outage. It uses one process per directory, 15-second per-request timeouts and a 10 MiB per-response bound. Interrupted activation may leave unreferenced generations, which are retained rather than guessed as active. See [cache details](catalog.md#stage-2-persistent-catalog-cache).

`/healthz` checks the knowledge database; it does not certify catalog freshness or PAD execution. Catalog responses report `cache_status`, commit, checked time and refresh errors. To verify a deployment, reconnect an MCP client, choose a mode, search an action and retrieve its exact record and a type. Then restart and repeat using the same context ID. Prompts are included by the Dockerfile's existing `COPY src` instruction.

### Request boundary

Unknown Host headers and Origins different from `PUBLIC_URL` are rejected. Non-browser MCP clients can omit Origin. Update `PUBLIC_URL` when changing the domain. Do not enable broad CORS to bypass these checks.

This release uses two shared role credentials, not individual accounts, per-user audit attribution or a permissions administration UI. Tokens are not stored in SQLite. Rotate a token by updating its environment variable and redeploying, then update affected clients. No SQL port needs to be exposed.

## Local Docker Compose

With Docker installed and `.env` configured (`PUBLIC_URL=http://localhost:8080`):

```sh
docker compose -f compose.yaml -f compose.local.yaml up --build -d
```

The local override publishes port 8080 on loopback only. On Coolify, use `compose.yaml` alone; the proxy handles public HTTPS routing.

## Back up and restore

JSON export includes only currently published revisions, without drafts or history. For a full backup:

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
