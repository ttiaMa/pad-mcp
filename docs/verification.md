# Catalog integration verification

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
