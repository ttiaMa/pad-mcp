# External catalog integration

## Stage 1: local parser and lookup

`src/catalog.js` provides a local-only parser and index for the Classic and Power Fx editions of [JoeG592/pad-robin-action-kb](https://github.com/JoeG592/pad-robin-action-kb). Upstream catalog content is licensed CC BY 4.0. Lookup responses retain attribution and the upstream version and declared PAD build. The test records are synthetic, not copied or PAD-tested examples.

The parser itself does not register MCP tools, download or cache files, create development contexts, or modify the knowledge database.

`parseCatalogPair({ actions, types, power_fx })` accepts JSON strings or parsed documents. It validates required record fields, nonempty collections, unique identifiers and matching editions. It preserves additional upstream fields and allows action and type documents to have different version numbers. Classic currently omits `edition`; Power Fx must declare `power-fx`. Validation does not establish that the two documents came from the same commit; the future loader must supply that guarantee.

`new CatalogIndex(input, source)` accepts the same pair and optional `commit`, `checked_at` and `cache_status` provenance. Until supplied by a loader, these are null or `not_managed`, not a claim of freshness.

- `searchActions({ query?, module?, max_results? })` searches names, modules, descriptions and parameter names/types. A module-only request browses that module. Module matching is case-insensitive and exact.
- `searchActions({ action_id })` returns the complete exact record or `record: null`. IDs are case-sensitive. It cannot be combined with query/module filters.
- `searchTypes({ query, max_results? })` searches type names, categories and descriptions.
- `searchTypes({ type_name })` returns the complete exact type record and general formatting rules, or `record: null` if absent. Generic type names remain unchanged.

Search defaults to five compact results, with a maximum of twenty, a total match count and truncation flag. Ranking prefers an exact identifier, then the number of matching normalized keywords, with stable identifier ordering for ties. CamelCase names are split into keywords. Search uses any matching term; it does not translate Italian or infer semantic matches. Callers should use upstream technical terms and module filters as needed.

Only exact detail requests include templates, golden examples or type examples. Returned details are detached copies so callers cannot mutate the index. Upstream paste-validation statements are preserved as source claims, not execution guarantees for generated flows.

## Stage 2: persistent catalog cache

`new CatalogCache({ directory })` from `src/catalog-cache.js` supplies `await cache.get('enabled' | 'disabled')`, returning a `CatalogIndex`. The caller must share one cache instance per directory/process. This component is not yet wired into the running MCP server; subsequent integration will place its directory inside the persistent data volume.

On first use and the first request after an hour, it resolves GitHub `main` to a commit SHA, then fetches both stable filenames from that immutable commit. When the commit is unchanged, it updates the successful check timestamp without downloading the files again. Concurrent requests for an edition share one operation. The default per-request timeout is 15 seconds and the maximum response size is 10 MiB, checked while streaming as well as against Content-Length. Redirects are rejected. Network operations use fixed GitHub endpoints and no credentials.

Each edition has a `manifest.json` pointing to active and previous UUID generation directories. A generation contains the original action/type JSON and metadata with mode, commit, download time and SHA-256 checksums. New files are written and synced in a temporary directory, parsed as a complete pair, moved into a generation directory and read back for checksum/schema verification. A same-directory atomic manifest rename activates the pair. No active file is overwritten during download.

After successful activation, both retained generations are revalidated before older previously referenced generations are removed. Cleanup deletes only known files, without recursive removal. Cleanup failures and unreferenced generations left by interrupted activation are conservatively retained. This is process-crash recovery with filesystem rename semantics, not a backup against volume loss or a guarantee against hardware/power failures.

At restart the active generation is checked; if invalid, the previous generation is tried. Download, validation or activation failures return the last valid pair with `cache_status: stale` and `refresh_error`. Failed refreshes are retried after an hour in the same process; restarting permits a new attempt. No valid pair means an explicit error, never an empty catalog or a switch to another edition. An unreadable manifest is not guessed from arbitrary directories: existing files are retained and a fresh download is attempted.

The new generation retains the actual last valid pair as its predecessor, including after recovery. Current and previous files survive remote deletions and invalid JSON responses. A cache error does not involve the approved knowledge database.

## Stage 3: fixed-mode development contexts

The existing MCP knowledge tools now use persistent immutable contexts and mode filters. SQLite migrates additively from schema 2 to 3; knowledge exports remain version 2. New publication requires explicit mode classification. See [Initial context](usage.md#initial-context) for the changed tool contract and client reconnection requirements. No live database reset or reimport is required.

The catalog lookup tools and complete edition-specific prompts are not yet registered; they are the next integration stage.

## Remaining stages

1. MCP lookup tools and reviewed mode-specific prompts.
2. End-to-end verification and deployment/client documentation.
