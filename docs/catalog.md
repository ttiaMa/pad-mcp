# External catalog integration

## Stage 1: local parser and lookup

`src/catalog.js` provides a local-only parser and index for the Classic and Power Fx editions of [JoeG592/pad-robin-action-kb](https://github.com/JoeG592/pad-robin-action-kb). Upstream catalog content is licensed CC BY 4.0. Attribution and version provenance remain in the bundled files and this documentation; tool responses omit source metadata. Parser tests use synthetic records; a separate offline test verifies the actual bundled catalogs.

The parser itself does not register MCP tools, download or cache files, create development contexts, or modify the knowledge database.

`parseCatalogPair({ actions, types, power_fx })` accepts JSON strings or parsed documents. It validates required record fields, nonempty collections, unique identifiers and matching editions. It preserves additional upstream fields and allows action and type documents to have different version numbers. Classic currently omits `edition`; Power Fx must declare `power-fx`. Validation does not establish that the two documents came from the same commit; the bundled metadata records the immutable commit SHA and checksums.

`new CatalogIndex(input)` accepts the same pair without provenance metadata.

- `searchActions({ query?, module?, max_results? })` searches names, modules, descriptions and parameter names/types. A module-only request browses that module. Module matching is case-insensitive and exact.
- `searchActions({ action_id })` returns the complete exact record or `record: null`. IDs are case-sensitive. It cannot be combined with query/module filters.
- `searchTypes({ query, max_results? })` searches type names, categories and descriptions.
- `searchTypes({ type_name })` returns the complete exact type record, or `record: null` if absent. Generic type names remain unchanged.

Search defaults to five compact results, with a maximum of twenty, a total match count and truncation flag. Ranking prefers an exact identifier, then the number of matching normalized keywords, with stable identifier ordering for ties. CamelCase names are split into keywords. Search uses any matching term; it does not translate Italian or infer semantic matches. Callers should use upstream technical terms and module filters as needed.

Only exact detail requests include templates, golden examples or type examples. Returned details are detached copies so callers cannot mutate the index. Upstream paste-validation statements are preserved as source claims, not execution guarantees for generated flows.

Action records may include `error_handling: { on_error, errors }`. The parser validates the boolean support flag and array of nonempty error names when present, while accepting older catalogs without this field. Missing metadata means unknown support; an empty `errors` array does not imply `on_error: false`. Exact lookups preserve this metadata, while search summaries remain unchanged. Shared guidance explains named handlers and preserves existing subflow-level error handling rather than adding local handlers by default.

Error-handler guidance was reviewed against upstream [Classic PROMPT.md](https://github.com/JoeG592/pad-robin-action-kb/blob/0365052300d76f85ea1d2db5baca8048ae252934/PROMPT.md) and [PROMPT_PowerFx.md](https://github.com/JoeG592/pad-robin-action-kb/blob/0365052300d76f85ea1d2db5baca8048ae252934/PROMPT_PowerFx.md). It includes retry/named/default ordering, a shared closing `END`, and handler statement restrictions. The project's prompts remain adapted to selective MCP retrieval and team conventions; catalog updates do not automatically replace them.

## Stage 2: bundled catalogs

`new CatalogCache()` from `src/catalog-cache.js` supplies `await cache.get('enabled' | 'disabled')`, returning a `CatalogIndex`. The running server shares one read-only in-memory cache across requests and roles.

The application and Docker image include all four original upstream JSON files in `catalogs/`, with commit provenance, SHA-256 checksums and CC BY 4.0 attribution. Both editions are validated together before use. The server performs no upstream checks, downloads or catalog writes and exposes no catalog update tools or proposals.

To incorporate an upstream revision manually, replace all four files from the chosen immutable commit, update `metadata.json` (commit, retrieval time and SHA-256 checksums) and `NOTICE.md`, then run `npm test` and `npm run check`. Review and release the application when ready; restart the server or rebuild and redeploy the Docker image to load the new bundle. Review changes to local development prompts separately.

Previously downloaded snapshots and check records are retained on disk but ignored. `CATALOG_CACHE_PATH` is no longer used. The installed bundle is always authoritative, including after an upgrade from a version that supported downloaded snapshots. Invalid bundled data makes catalog lookups unavailable; the knowledge database remains independent.

## Stage 3: fixed-mode development contexts

MCP knowledge tools require an explicit power_fx mode for each development lookup. Schema 7 removes the old persistent contexts; see [Database initialization](deployment.md#database-initialization) for the current schema and upgrade behavior. Knowledge exports remain version 2. New publication requires explicit mode classification. See [Initial context](usage.md#initial-context) for the changed tool contract and client reconnection requirements. No live database reset or reimport is required.

## Stage 4: MCP tools and reviewed prompts

`search_actions` and `search_type_reference` are available to both roles and require a valid context. The server derives the edition from the stored mode. Lookups use only the bundled catalogs; unavailable or invalid local data returns an MCP error.

The context tool loads shared guidance and only the selected edition's prompt, without downloading a catalog. Read [common](../src/prompts/common.md), [Classic](../src/prompts/classic.md) and [Power Fx](../src/prompts/power-fx.md). The context includes the original type rules and Power Fx rules/exception metadata where present. Action and type detail responses contain only the complete record, with no repeated rules or rule references. Search summaries remain small.

## Verification

`npm run check` covers the new modules. `npm test` exercises local parsing, exact and bounded retrieval, bundle integrity and manual repair, schema migration, stateless mode selection, publication classification and HTTP MCP integration for both modes and roles. Tests use temporary local data; no approved remote knowledge is mutated. No automated check executes PAD flows or proves cloud-trigger compatibility.
