# Usage

## Connect an agent

Use `https://mcp.example.com/mcp` with `Authorization: Bearer <token>`. Use your individual Developer API key for development assistance or the Maintainer key for maintaining the collection. See [API key management](api-keys.md) to create, list or delete Developer keys.

Follow the [Codex and Claude Code setup instructions](setup.md#connect-codex-or-claude-code) for client configuration, environment variables and connection checks. Both clients use `PAD_MCP_TOKEN`; its value determines the role. The project's `.env` configures the server and transfer script, not the agent's environment.

The server asks the agent to load context first and retrieve relevant patterns before implementation. Actual tool use depends on the agent and client. For RPA migration, the agent interprets the source logic and searches for the PAD implementation needs individually, such as batching, retries or Excel handling. Validate the resulting flow in PAD.

Successful tool results contain one JSON payload in a single MCP text content block. Programmatic clients read it with `JSON.parse(result.content[0].text)`. The server does not duplicate it in `structuredContent`. Tool errors use `isError: true` and a text message.

## Tools and roles

| Tool | Role | Purpose |
| --- | --- | --- |
| `get_development_context` | Both | Load guidance and up to 20 compatible global conventions for the selected mode, without session storage |
| `search_patterns` | Both | Find previews of compatible approved patterns using required `power_fx`, with optional area/kind filters |
| `get_pattern` | Both | Read a compatible published entry using `power_fx`; Maintainers can explicitly request maintenance review |
| `search_actions` | Both | Search the selected mode's catalog by keywords/module; retrieve a complete action by exact `action_id` |
| `search_type_reference` | Both | Search type summaries or retrieve formatting by exact `type_name` |
| `export_knowledge` | Both | Export all published entries |
| `get_usage_stats` | Maintainer | Read aggregate Developer usage by day, tool, mode or key; see [Usage statistics](usage-statistics.md) |
| `list_patterns` | Maintainer | List IDs and current revisions, including drafts |
| `save_draft` | Maintainer | Save a new immutable draft revision |
| `publish_revision` | Maintainer | Publish the exact latest revision for the team |
| `replace_pattern` | Maintainer | Save and publish approved replacement content atomically under the same ID |
| `unpublish_pattern` | Maintainer | Withdraw from retrieval while preserving history |
| `delete_pattern` | Maintainer | Permanently remove an entry and all its revisions from the live database |
| `import_knowledge` | Maintainer | Import up to 20 entries as drafts |

Both roles use the same published collection. Development reads return compatible current published revisions. Maintainers can inspect drafts and history with `get_pattern` and `purpose: "maintenance"`, without `power_fx`; the response is marked as maintenance content. Developers cannot invoke knowledge mutation tools or maintenance reads, even by name. Both roles may load development guidance. All access still requires authentication.

## Reference catalog versions

Classic and Power Fx references are bundled and available offline. Catalog versions change only when you manually incorporate a chosen upstream revision into the project and release it. There are no automatic checks, update proposals or MCP update tools. See [manual catalog maintenance](catalog.md#stage-2-bundled-catalogs).

## Add and approve

Ask the agent to save pasted Robin as a draft, preserving it exactly. `save_draft` takes an `id`, `expected_revision` and `content`. Use revision 0 for a new ID; otherwise read the latest revision first.

After reviewing the draft, approve an exact revision for publication. Saving a newer draft does not replace the previously published revision until publication succeeds.

Publication and replacement require an explicit `power_fx` value of `enabled`, `disabled`, or `either`. Use `either` only when compatibility with both modes is established. Unclassified entries can be saved/imported as drafts, but must receive a new classified revision before publication. This also applies to seed entries published at first startup. Existing published entries are preserved; legacy unclassified entries remain exportable and available for maintenance but are excluded from development.

If your initial message already approves the exact submitted content, the agent can save and publish sequentially. It must not silently change the code or extend that approval to invented metadata. Omit unsupported inferences; ask for clarification only when needed to identify or use the pattern correctly.

### Authoring from informal context

Supply the original Robin block and explain its purpose naturally. If your client supports voice input, its transcript can be used as the explanation. The connected agent prepares the entry using `authoring_guidance` returned to Maintainers by `get_development_context` after mode selection.

The agent should extract:

| Field | What to retain |
| --- | --- |
| `title` | The specific operation, expressed in likely search terms |
| `problem` | When the pattern applies and the expected result, ideally 1-3 sentences |
| `approach` | The mechanism and the author's stated rationale |
| `area`, `tags` | A focused topic and about 3-8 relevant terms or synonyms |
| `inputs`, `outputs` | Input and output values and datatypes |
| `power_fx` | Whether the flow requires Power Fx enabled or disabled |
| `pitfalls` | Known edge cases and limitations |

These length targets are editorial guidance, not automatic truncation. Repetition and unrelated narrative can be omitted; details that affect correct use must be retained once in the appropriate field. Metadata defaults to English, while Robin stays byte-for-byte as submitted and relevant search synonyms can include the team's Italian vocabulary. The agent should check for similar entries and must not invent facts or reasons for your implementation choices.

For example, a long explanation about processing an Excel-derived list in groups could become:

- **Title:** Split a list into fixed-size batches
- **Problem:** Process a list in groups of up to N items, including the final incomplete group.
- **Tags:** batching, pagination, list, groups

That summary is appropriate only if the supplied explanation and code support it. Before publication, the agent shows the saved ID/revision and a compact summary of metadata, constraints and open questions. Approval of the original code alone does not approve newly inferred metadata.

The server validates structure and field sizes, stores the supplied fields and indexes published content. It does not transcribe audio, call an AI model or assess whether the summary accurately reflects your explanation. The quality of the draft depends on the connected agent and your review.

## Replace, withdraw or delete

Choose the operation that matches the request:

- **Replace an outdated implementation:** read the latest revision, then call `replace_pattern` with the same ID, that `expected_revision`, the complete approved replacement `content`. Creation, approval and search-index update occur in one transaction. Previous revisions remain available to Maintainers. If any step fails, the previous published state remains intact. Unapproved replacements should be saved as drafts instead.
- **Withdraw an entry:** call `unpublish_pattern`. It disappears from search, shared context, exports and Developer access. Maintainers retain the history and can publish it again.
- **Permanently delete an entry:** explicitly request deletion, then call `delete_pattern` with its exact ID and latest `expected_revision`. All revisions and the search-index entry are removed from the live database. This cannot be undone through MCP; recovery requires a backup. Existing backups and previously exported copies are not erased.

Replacement reuses the ID so references keep pointing to the maintained pattern. Permanent deletion can leave IDs mentioned in recipes unresolved; dependency text is not a managed foreign-key graph in this release.

A revision conflict rejects the operation. Read the current state before retrying, including when a network failure leaves the outcome unknown. Replacement does not create a new identity or merge entries with different IDs.

## Find and retrieve a snippet

Search returns at most three previews by default (maximum ten): `id`, `revision`, `kind`, `title` and `problem`. The problem excerpt is capped at 600 Unicode code points; `problem_truncated: true` appears only when shortened. Code and detailed constraints stay out of search responses. Full content remains indexed and area/kind/mode filters still apply.

Choose the relevant preview, then call `get_pattern({ power_fx, id, revision })` to retrieve its original code and complete usage constraints. There is no need to fetch every search result. If the selected revision has since been replaced or withdrawn, retrieval fails: search again instead of silently using a different revision. Global conventions in the initial context and portable exports still contain full content.

## Initial context

Fixed server instructions and base guidance are in `src/server.js`. Changing them requires a process restart or redeployment, and reconnecting clients to refresh server instructions.

Editable development conventions are entries with `kind=convention` and `area=global`. Publish them through the same tools as snippets; the next `get_development_context` call reads the updated database content. All published conventions are shared with Developers. Long collections are capped at 20 global conventions per context response.

At the start of each chat, call `get_development_context({})`: it returns `status: "selection_required"` and the mode question only, for both roles. Ask the user whether the chat uses Classic or Power Fx, then call it with `power_fx: "disabled"` or `"enabled"`. The response contains compatible guidance and conventions without creating or storing a session. Repeat the same call to reload guidance.

Pass that same `power_fx` value to every `search_patterns`, `search_actions`, `search_type_reference` and development `get_pattern` call. The agent keeps the initial choice throughout the conversation; the stateless server validates each request independently and cannot enforce a fixed choice across calls. Missing or invalid modes fail rather than defaulting to an edition. Mode-specific entries from the other edition and `unspecified` entries are excluded; `either` is included, even for Maintainers. Conventions are filtered before the 20-entry limit. Search and detail responses do not repeat the initial instructions.

Schema 7 removes the former context table and its rows automatically on startup, preserving knowledge, revision history, API keys and statistics. Reconnect clients after upgrading to reload the tool schemas: old `context_id` arguments are no longer accepted. Portable export/import remains version 2. See [Database initialization](deployment.md#database-initialization).

## External action and type references

After choosing the mode, pass the selected power_fx value in these calls (examples show arguments, not Robin):

```json
{"power_fx":"enabled","query":"join text","module":"Text"}
```

Pass those arguments to `search_actions`. Then request the selected record:

```json
{"power_fx":"enabled","action_id":"Text.JoinText.Join"}
```

Use `search_type_reference` with `{"power_fx":"enabled","type_name":"String"}` or a type name returned in the action's parameters. Exact identifiers are case-sensitive; preserve generic type notation. Use English technical keywords for catalog searches. The action category is its upstream `module`.

Search returns five summaries by default (maximum twenty), total match count and a truncation flag. Exact lookup returns one full record or `record: null`; do not combine an exact ID with query/module filters. General edition rules and Power Fx runtime caveats are included once in the development context. It does not include the entire catalog or repeat the initial prompt.

Catalog lookups omit provenance metadata. Attribution remains in the project documentation and bundled files. With no valid local or bundled pair, the tool returns an error; snippet tools remain available. Catalog content is separate from the team's published knowledge and is never automatically approved or imported.

`get_development_context` returns the locally reviewed `development_prompt` only after mode selection, without requiring a network call. Shared guidance plus one edition-specific file are loaded from `src/prompts`, followed by the original rules from the active local catalog; restart the server after editing them. Catalog updates do not overwrite these prompt files. After deploying a manually updated bundle, reload the context to obtain its current rules. If the catalog is unavailable, `catalog_error` explains the limitation while compatible snippet retrieval remains usable. The agent should distinguish approved originals, adapted code, upstream paste validation and actual PAD execution evidence.

## Entry fields

`id` is a stable slug such as `list-batches`. `content` requires `title`, `problem` and, for snippets, `robin_code`. Optional fields:

- `kind`: `snippet`, `convention` or `recipe`.
- `approach`, `area`, `tags`, `inputs`, `outputs`, `pitfalls`.
- `power_fx`: `enabled`, `disabled`, `either` or `unspecified`. A mode filter excludes unspecified entries.

Only these development fields are accepted. Search runs on the server across the complete stored content and returns the matching patterns, including exact Robin code. The collection targets one shared PAD environment; only snippets suitable for that environment should be published. Power Fx mode belongs in `power_fx`. Publication approval and revision history remain separate from content.

Use task-oriented descriptions and tags for retrieval. Search is lexical with a small English/Italian synonym dictionary; matches still need review for suitability.

## Import and export files

The transfer script uses the authenticated MCP endpoint and reads `.env`. For a remote instance, set `MCP_URL=https://mcp.example.com/mcp` and `MCP_MAINTAINER_TOKEN` in the environment.

```sh
npm run transfer -- export knowledge.json
npm run transfer -- import knowledge.json
```

Export refuses to overwrite an existing file. Import validates the entire file first, rejects existing IDs and never inherits publication approval. Imported revision numbers are source metadata; local revisions start at 1. For existing entries, use draft updates or approved replacement.

On HTTP `429`, the script follows the server's `Retry-After` delay (1–60 seconds), retrying that HTTP request at most three times. Commands are unchanged. Network failures and other errors are not automatically retried because a write may already have succeeded. If an import still fails, earlier completed batches remain imported.

### Edit an exported collection

Export includes all currently published patterns, but no drafts or revision history. You can edit `content` by hand while preserving each entry's stable `id` and the package structure.

- **New installation:** replace `knowledge/seed.json` with the edited export before building/deploying. The first startup on an empty, uninitialized database validates and publishes the entire package atomically, starting local revisions at 1. Including content in this file authorizes publication to the team; the server does not execute PAD flows.
- **Running installation, new IDs:** import the file through the transfer command or `import_knowledge`, then review and publish the resulting drafts.
- **Running installation, existing IDs:** give the edited file to a Maintainer agent. Ask it to read each current entry, compare the changes and use `save_draft` with the current `expected_revision`, then publish after approval. For already approved replacements, use `replace_pattern`. The generic import command deliberately rejects existing IDs; it does not overwrite them.

Example chat request:

> Use pad-mcp. Read this edited JSON collection and compare it with the current patterns. For existing IDs, save the changes as new drafts using their latest revisions; create drafts for new IDs. Preserve the Robin code from the file and show me the changes before publication.

The seed is loaded once per database, not on every restart. Editing it later does not synchronize it with an existing server. A persistent completion marker prevents deleted entries from returning, even if the collection becomes empty. An existing nonempty database is marked initialized without importing or publishing anything. Invalid seeds fail startup without partially importing data; fix the file and restart. An empty seed package is also valid. Seeds support up to 10,000 entries.

The server never writes database changes back into the repository JSON automatically; run export when you want a fresh copy. Keep the persistent database volume for normal redeployments.

The JSON package format uses `schema_version: 2`. Exports include all currently published entries; imports create drafts requiring review before publication. The server validates the package version and rejects unknown fields.

### Package format

```json
{
  "schema_version": 2,
  "entries": [
    {
      "id": "example-convention",
      "revision": 1,
      "content": {
        "kind": "convention",
        "title": "Example for review",
        "problem": "Define a personal development convention",
        "approach": "Replace this text with an approved rule.",
        "area": "global"
      }
    }
  ]
}
```

You can attach a file to a chat and ask the agent to import it if the client can read the attachment and pass its structured contents to `import_knowledge`. The server does not access local client paths or download arbitrary URLs. There is no upload web form in this release.
