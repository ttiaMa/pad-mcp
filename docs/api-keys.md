# API key management

The Maintainer key is configured through the `MCP_MAINTAINER_TOKEN` environment variable. It provides access to knowledge-management tools.

Developer keys are created from the server terminal. Each key has a name, grants access to published knowledge and development tools, and remains valid until disabled. Developer keys cannot access Maintainer tools.

## Create a Developer key

From the project directory, run:

```sh
npm run keys -- create --name "Roby"
```

The command returns the key's ID, name, creation date and token. **Copy the token immediately: it is shown only when the key is created.** The database stores its hash, so the original token cannot be retrieved later.

Share the token privately with its recipient, together with your instance's `/mcp` URL and the [client setup instructions](setup.md#connect-codex-or-claude-code).

Names are labels for your reference. Use the returned ID when disabling a key.

## List keys

```sh
npm run keys -- list
```

The list includes each key's ID, name, creation date and `disabled_at` value. A `null` value means the key is active. Tokens and hashes are never included.

## Disable a key

```sh
npm run keys -- disable --id KEY_ID
```

Replace `KEY_ID` with the ID returned by the create or list command.

The key is rejected from the next request onward. No server restart is needed, and other keys continue to work. A request already accepted may finish.

Disabling a key keeps its record in the database. There is no reactivation command; create a new key if the person needs access again.

## Use from Coolify or Docker

In Coolify, open the running application container's terminal and run the commands from `/app`:

```sh
cd /app
npm run keys -- create --name "Roby"
npm run keys -- list
npm run keys -- disable --id KEY_ID
```

Run the command you need; the example above shows the three available operations. Replace `KEY_ID` with the key's ID.

From a Docker host using this project's Compose file:

```sh
docker compose exec pad-mcp npm run keys -- create --name "Roby"
docker compose exec pad-mcp npm run keys -- list
docker compose exec pad-mcp npm run keys -- disable --id KEY_ID
```

The commands use `DATABASE_PATH`, just like the server. The bundled container configuration points both to `/app/data/knowledge.sqlite`.

## Storage and backups

Developer keys have no expiration date. Their hashes and metadata are stored in SQLite alongside the knowledge base and survive application restarts and redeployments when the data volume is preserved.

Include the database in your backups. Knowledge JSON exports do not include API keys.

To replace a lost or exposed Developer token, disable its key and create a new one. To rotate the Maintainer token, update `MCP_MAINTAINER_TOKEN`, redeploy and update your Maintainer clients.

## Migrate from the shared Developer token

If `MCP_DEVELOPER_TOKEN` is configured, the server imports it into the database once, naming it `legacy-developer`. Existing clients can continue using it.

After the first successful startup with the updated version, you can remove `MCP_DEVELOPER_TOKEN` from the deployment configuration. The imported key remains in the database.

Disabling the imported key is permanent: restarting the server or leaving the old environment variable configured will not reactivate it. After the import, changing that variable does not create another key. Use the terminal commands to manage Developer access.

For individual access, create a key for each person, distribute the new tokens, then disable `legacy-developer` when everyone has switched.
