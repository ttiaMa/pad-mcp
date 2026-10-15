<p align="center">
  <img src="assets/pad-mcp-logo.png" alt="pad-mcp" width="520">
</p>

**An MCP server for writing Power Automate Desktop flows using shared code snippets and action references.**

Describe what you need to automate to build a new flow, or **paste code or process logic from Blue Prism, UiPath or another RPA tool** and ask the agent to rebuild that task in PAD using your team's coding conventions. Supports **Classic PAD and Power Fx**.

## How it works

| Your team's knowledge | The action reference |
| --- | --- |
| Reusable PAD code snippets, step-by-step solutions and conventions you review and publish. | A searchable catalog of actions, parameters, examples and data types. |
| Reuse the way you already solve problems. | Look up the syntax for the next action you need. |
| Stored in the SQLite database included with pad-mcp. | JSON catalogs from [PAD Robin Action Knowledge Base](https://github.com/JoeG592/pad-robin-action-kb), cached locally. |

At the start of the chat, the agent asks whether you use Classic PAD or Power Fx. That choice stays fixed throughout the conversation.

> Use pad-mcp to build a flow that reads an Excel file and processes its rows in batches.

> Use pad-mcp to recreate this task in Power Automate Desktop with Power Fx enabled. [Copied code]

The agent produces **Robin, the scripting language behind PAD flows**. Copy the generated code and paste it into the PAD flow designer to turn it into actions, then review and test the flow.

## Keep what works

**Maintainers** manage the collection; **Developers** use its published content. Original code and revision history are preserved. Adaptations are clearly separate from approved originals.

Self-host one container with SQLite on persistent storage. The external catalog refreshes on demand, at most once every 12 hours per edition, and keeps the previous valid copy if an update fails.

## Get started

- [Run locally, deploy on Coolify and connect your agent](docs/setup.md)
- [Use the tools and publish snippets](docs/usage.md)
- [Upgrade, back up and restore your data](docs/deployment.md)
- [Read the prompts: shared](src/prompts/common.md) · [Classic](src/prompts/classic.md) · [Power Fx](src/prompts/power-fx.md)

## Credits

The action/type catalogs come from **[JoeG592's PAD Robin Action Knowledge Base](https://github.com/JoeG592/pad-robin-action-kb)**, licensed under **CC BY 4.0**. Thank you for making this reference available. See [attribution and adaptations](src/prompts/NOTICE.md).

Catalog examples validated by pasting into PAD are useful references; they do not prove that a newly composed flow will run correctly.

---

For contributors: `npm run check` and `npm test`. See [architecture and cache](docs/catalog.md) and [verification results](docs/verification.md).
