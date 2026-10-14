# External catalog integration

## Stage 1: local parser and lookup

`src/catalog.js` provides a local-only parser and index for the Classic and Power Fx editions of [JoeG592/pad-robin-action-kb](https://github.com/JoeG592/pad-robin-action-kb). Upstream catalog content is licensed CC BY 4.0. Lookup responses retain attribution and the upstream version and declared PAD build. The test records are synthetic, not copied or PAD-tested examples.

This stage does not register MCP tools, download or cache files, create development contexts, or modify the knowledge database. Those integrations follow in subsequent stages.

`parseCatalogPair({ actions, types, power_fx })` accepts JSON strings or parsed documents. It validates required record fields, nonempty collections, unique identifiers and matching editions. It preserves additional upstream fields and allows action and type documents to have different version numbers. Classic currently omits `edition`; Power Fx must declare `power-fx`. Validation does not establish that the two documents came from the same commit; the future loader must supply that guarantee.

`new CatalogIndex(input, source)` accepts the same pair and optional `commit`, `checked_at` and `cache_status` provenance. Until supplied by a loader, these are null or `not_managed`, not a claim of freshness.

- `searchActions({ query?, module?, max_results? })` searches names, modules, descriptions and parameter names/types. A module-only request browses that module. Module matching is case-insensitive and exact.
- `searchActions({ action_id })` returns the complete exact record or `record: null`. IDs are case-sensitive. It cannot be combined with query/module filters.
- `searchTypes({ query, max_results? })` searches type names, categories and descriptions.
- `searchTypes({ type_name })` returns the complete exact type record and general formatting rules, or `record: null` if absent. Generic type names remain unchanged.

Search defaults to five compact results, with a maximum of twenty, a total match count and truncation flag. Ranking prefers an exact identifier, then the number of matching normalized keywords, with stable identifier ordering for ties. CamelCase names are split into keywords. Search uses any matching term; it does not translate Italian or infer semantic matches. Callers should use upstream technical terms and module filters as needed.

Only exact detail requests include templates, golden examples or type examples. Returned details are detached copies so callers cannot mutate the index. Upstream paste-validation statements are preserved as source claims, not execution guarantees for generated flows.

## Remaining stages

1. Persistent, atomic catalog cache retaining the active and previous valid pair.
2. Immutable development contexts and mode-aware approved-pattern filtering.
3. MCP lookup tools and reviewed mode-specific prompts.
4. End-to-end verification and deployment/client documentation.
