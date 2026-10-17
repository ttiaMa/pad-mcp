# Developer usage statistics

Use the Maintainer-only `get_usage_stats` tool to see whether Developers are using your instance and which tools they use. For example, ask your connected agent:

> How many Developer keys were active this week, and which tools were used most?

Statistics stay in your instance's SQLite database. They are not sent to the project maintainer or an external analytics service.

## Read a report

```json
{ "days": 7, "group_by": "tool" }
```

Pass these arguments to `get_usage_stats`. The default period is 30 days, grouped by day.

| Argument | Values |
| --- | --- |
| `days` | 1–365, limited to the configured retention period; includes today |
| `group_by` | `day`, `tool`, `mode` or `key` |
| `key_id` | Optional Developer key ID from `npm run keys -- list` |
| `limit` | Rows per page, 1–100; default 30 |
| `offset` | Start at 0, then follow `next_offset` until it is `null` |

The response includes the actual UTC date range, totals and distinct active keys for that range, and a page of grouped counters. Totals cover the entire filtered period, not just the page. Grouping by key also returns its name and last-use timestamp. Keys without activity in the selected period do not appear; use the CLI to list all keys.

Developer clients cannot list or call this tool. Maintainer activity, including reading reports, is excluded from collection.

## What is stored

One row combines all calls for the same UTC day, Developer key, tool and PAD mode. More calls update that row instead of adding request records.

| Field | Meaning |
| --- | --- |
| Day | UTC calendar date |
| Key ID | Links the counters to the name assigned when creating the key |
| Tool | The registered tool that handled the call |
| Mode | `classic`, `power_fx` or `not_applicable` when there is no valid context |
| Calls | Total handler executions |
| Successes | Executions that returned without an error |
| Errors | Executions that failed inside the tool handler |
| Empty results | Successful searches with no results, including exact catalog lookups with no matching record |

Calls equal successes plus errors. Empty results are a subset of successes. A context-selection prompt is a successful call even if a mode has not been chosen yet.

The key registry also stores `last_used_at`, the time of the most recent recorded tool call, including failed calls. This single value is retained until the key is deleted and is available through `npm run keys -- list`.

Statistics do not store prompts, search text, code, arguments, complete responses, context IDs, IP addresses, tokens or error messages. This describes the statistics tables; it does not change existing knowledge storage or infrastructure logs.

Connections, tool listings, invalid credentials, unknown or forbidden tools, and arguments rejected by MCP schema validation before a handler runs are not counted. Active keys are not necessarily distinct people, and a successful call does not prove that a PAD flow executed successfully.

## Retention and settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `USAGE_STATS_ENABLED` | `true` | Set to `false` to stop collecting counters and updating `last_used_at` |
| `USAGE_RETENTION_DAYS` | `90` | Number of UTC calendar dates to retain, including today; accepts 1–365 |

Set these variables in the server environment or Compose/Coolify configuration, then restart or redeploy. Reports remain available when collection is disabled, and previously collected counters continue to expire.

Expired rows are removed at startup, hourly while the server runs, and before reports. A stopped server performs cleanup when it next starts. SQLite can reuse freed pages; deleting rows does not necessarily shrink the database file immediately.

Deleting a Developer key also deletes its usage counters. Reports therefore describe retained activity from keys still in the database, not a permanent historical total. Database backups include statistics; knowledge JSON exports do not.

Collection failures do not change a tool's result. Reports expose recording and cleanup failure counts since server startup, so a Maintainer can see when totals may be incomplete. There is no backfill for calls made before this feature was enabled or while recording was unavailable.

When sharing access, tell recipients that the instance stores aggregate tool usage associated with their key, without storing request content in the statistics.
