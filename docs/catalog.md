# External catalog integration

## Stage 1: local parser and lookup

`src/catalog.js` provides a local-only parser and index for the Classic and Power Fx editions of [JoeG592/pad-robin-action-kb](https://github.com/JoeG592/pad-robin-action-kb). Upstream catalog content is licensed CC BY 4.0. Attribution and version provenance remain in the bundled files and this documentation; tool responses omit source metadata. Update tests use synthetic records; a separate offline test verifies the actual bundled catalogs.

The parser itself does not register MCP tools, download or cache files, create development contexts, or modify the knowledge database.

`parseCatalogPair({ actions, types, power_fx })` accepts JSON strings or parsed documents. It validates required record fields, nonempty collections, unique identifiers and matching editions. It preserves additional upstream fields and allows action and type documents to have different version numbers. Classic currently omits `edition`; Power Fx must declare `power-fx`. Validation does not establish that the two documents came from the same commit; the loader supplies that guarantee using an immutable commit SHA.

`new CatalogIndex(input)` accepts the same pair without provenance metadata.

- `searchActions({ query?, module?, max_results? })` searches names, modules, descriptions and parameter names/types. A module-only request browses that module. Module matching is case-insensitive and exact.
- `searchActions({ action_id })` returns the complete exact record or `record: null`. IDs are case-sensitive. It cannot be combined with query/module filters.
- `searchTypes({ query, max_results? })` searches type names, categories and descriptions.
- `searchTypes({ type_name })` returns the complete exact type record, or `record: null` if absent. Generic type names remain unchanged.

Search defaults to five compact results, with a maximum of twenty, a total match count and truncation flag. Ranking prefers an exact identifier, then the number of matching normalized keywords, with stable identifier ordering for ties. CamelCase names are split into keywords. Search uses any matching term; it does not translate Italian or infer semantic matches. Callers should use upstream technical terms and module filters as needed.

Only exact detail requests include templates, golden examples or type examples. Returned details are detached copies so callers cannot mutate the index. Upstream paste-validation statements are preserved as source claims, not execution guarantees for generated flows.

## Stage 2: persistent catalog cache

`new CatalogCache({ directory })` from `src/catalog-cache.js` supplies `await cache.get('enabled' | 'disabled')`, returning a `CatalogIndex`. The running server shares one instance across requests and roles. The entrypoint uses `CATALOG_CACHE_PATH`, defaulting beside the database; Compose keeps it inside the persistent data volume.

The application and Docker image include all four original upstream JSON files in `catalogs/`, with commit provenance, SHA-256 checksums and CC BY 4.0 attribution. Both editions work on first use without network access or a writable cache. Lookups never download or activate remote content.

The entrypoint starts a background check at startup and then every 24 hours, including when there is no chat traffic. One shared GitHub `main` check covers both editions. Successful and failed checks persist their timestamp in `check.json`; a restart waits for the remaining interval. Maintainer context/status requests also perform a check when due, sharing the same serialized operation. Checks only resolve the repository commit; they never download or install catalog JSON. Failures retain any pending proposal and the current baseline.

When the upstream SHA differs from the active baseline, `get_development_context` returns `catalog_update` only to Maintainers, after selecting a PAD mode. The agent is instructed to ask whether to replace the local catalogs. Developers receive neither the proposal nor update tools. `get_catalog_update_status` allows a Maintainer to revisit the proposal. Declining leaves the current catalogs in use; the pending proposal remains available in later chats.

Only the Maintainer-only `update_catalogs` tool can activate a remote snapshot. It requires `confirmed: true` and the exact offered `expected_commit`. A changed proposal requires fresh approval. The download pins all four stable filenames to that immutable SHA, validates both editions and verifies checksums before atomically switching one manifest for the complete snapshot. An upstream change after the proposal cannot change the approved download. Repeated approval of an already active commit is idempotent. Successful activation makes that commit the new baseline for subsequent daily checks.

Approved snapshots live in UUID directories under `CATALOG_CACHE_PATH`. Each contains four original JSON files and metadata; a root `manifest.json` points to active and previous approved snapshots. These persistent files override the application bundle, including after restart or image rebuild. The bundle itself stays read-only. The previous snapshot is retained; cleanup removes only known files in previously referenced generations after validation, without recursive deletion. Orphan generations from interrupted activation remain untouched.

At restart, invalid active data falls back to the previous complete snapshot, then to the bundled catalogs. An unreadable manifest never causes arbitrary directories to be promoted. Failed downloads, schema checks, writes or activation leave the active manifest authoritative, and a later explicit approval can retry the pending update. These are filesystem rename/process-crash guarantees, not backups against volume loss or hardware failure. Legacy per-edition auto-refresh caches are left on disk but are not imported as approved snapshots: installations start from the bundled baseline until a Maintainer approves an update.

Network requests use fixed GitHub endpoints, no credentials, rejected redirects, a 15-second per-request timeout and a 10 MiB per-response streaming bound. A check failure does not prevent local lookups; lookup responses contain only development data. Update proposals and check errors are reported separately to Maintainers. Only a failure to load both local and bundled data makes catalog tools unavailable; the knowledge database is independent.

## Stage 3: fixed-mode development contexts

MCP knowledge tools use persistent immutable contexts and mode filters. Contexts were introduced in schema 3; see [Database initialization](deployment.md#database-initialization) for the current schema and upgrade behavior. Knowledge exports remain version 2. New publication requires explicit mode classification. See [Initial context](usage.md#initial-context) for the changed tool contract and client reconnection requirements. No live database reset or reimport is required.

## Stage 4: MCP tools and reviewed prompts

`search_actions` and `search_type_reference` are available to both roles and require a valid context. The server derives the edition from the stored mode. Lookups use only the active local snapshot; unavailable or invalid local data returns an MCP error.

The context tool loads shared guidance and only the selected edition's prompt, without downloading a catalog. Read [common](../src/prompts/common.md), [Classic](../src/prompts/classic.md) and [Power Fx](../src/prompts/power-fx.md). The context includes the original type rules and Power Fx rules/exception metadata where present. Action and type detail responses contain only the complete record, with no repeated rules or rule references. Search summaries remain small.

## Verification

`npm run check` covers the new modules. `npm test` exercises local parsing, exact and bounded retrieval, persistence, interrupted writes/activation, previous-generation recovery, schema migration, immutable contexts, publication classification and HTTP MCP integration for both modes and roles. Tests use temporary data and mocked upstream responses; no approved remote knowledge is mutated. Live GitHub checks are separate from this deterministic suite. No automated check executes PAD flows or proves cloud-trigger compatibility.
