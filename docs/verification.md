# Catalog integration verification

## Bundled catalogs and maintainer approval — 2026-10-17

- `npm run check`: passed.
- `npm test`: all 49 tests passed. Coverage includes first-use offline access to both real bundled editions, daily background checks without chat traffic, persisted success/failure backoff across restarts, pending update persistence, maintainer-only proposals and tools, explicit commit approval, immutable downloads, atomic activation of both editions, failed writes, and recovery of the previous snapshot or bundle.
- The four upstream JSON files were retrieved from current `main` at `0c4ebca091d270f2ddaa70bbda32240251cf0850`. The commit and all four SHA-256 checksums were verified again after implementation. Git preserves their original bytes across platforms.
- The MCP integration test exercises both roles over real local HTTP with deterministic upstream responses. Developers cannot invoke update tools even by name, and cannot see update proposals in their context.
- Docker is unavailable on this host, so the updated image was not built. The Dockerfile now copies `catalogs/` explicitly. No PAD flow execution or deployment was performed.

## Earlier integration verification — 2026-10-14

Local verification completed on 2026-10-14. No production database changes, push or deployment were performed.

## Automated checks

- `npm run check`: passed, including parser, cache and prompt loader modules.
- `npm test`: 47 tests passed. Coverage includes publication/permissions, additive schema migration, fixed-mode contexts, bounded catalog responses, separate editions, concurrent cache access, failed downloads, interrupted file writes, failed activation and fallback after restart.
- `git diff --check`: passed before commits.

The tests use temporary databases/directories and deterministic upstream fixtures. On this Windows host the suite required permission to access localhost and perform atomic directory renames outside sandbox restrictions.

## Live integration smoke check

A temporary local HTTP MCP server was queried using the official MCP client and real GitHub downloads at upstream commit `0c4ebca091d270f2ddaa70bbda32240251cf0850`.

- A new chat returned `selection_required` without downloading the catalog.
- Both Classic and Power Fx contexts returned only their respective local prompt.
- `search_actions` found `Text.JoinText.Join`; exact lookup returned its example and parameters.
- `search_type_reference` returned the `String` record from the selected edition.
- Five-result action responses were approximately 1.3 KB, rather than the full catalog.
- After closing and reopening the server/database with network access disabled, both original context IDs and persisted type references remained usable.
- The isolated smoke-test data was removed after the check; the remote approved knowledge database was not accessed or modified.

## Limits

Docker is unavailable on the verification host, so no image build or container/Coolify deployment was tested. Compose places SQLite and cache under the existing persistent volume; the Dockerfile copies prompts as part of `src`. PAD Designer paste, flow execution and cloud-trigger behavior were not tested. Follow the deployment smoke checks after an authorized deployment, and validate generated flows in PAD with representative inputs.
