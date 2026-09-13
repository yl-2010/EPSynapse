# EPSynapse remote MCP server

EPSynapse exposes the same tools the in-app chatbot uses as a remote MCP server. Point Perplexity, Claude, Cursor, or any Streamable HTTP MCP client at it and the model can read your notes, todos, class files, OneDrive, OneNote, Outlook, and Teams as you.

Endpoint: `https://api.epsynapse.com/mcp`
Transport: MCP Streamable HTTP (spec 2025-03-26 and 2025-06-18; also answers 2024-11-05 clients)
Auth: `Authorization: Bearer <connect token>`

Code lives in `server/mcp-http.js`. Tool definitions come from `server/agent-tools.js`.

## 1. Get your connect token

Sign in at https://epsynapse.com first. Then either:

- Open Settings > MCP in the web app and copy the token. (That panel is being built alongside this server. Until it lands, use the curl below.)
- Or call the API with your browser session:

```bash
curl -s https://api.epsynapse.com/v1/me/mcp -H 'x-epsynapse-session: <your session id>'
```

The response has everything you need:

```json
{
  "url": "https://api.epsynapse.com/mcp",
  "token": "<token>",
  "header": "Authorization: Bearer <token>",
  "perplexityJson": { "name": "EPSynapse", "url": "https://api.epsynapse.com/mcp", "headers": { "Authorization": "Bearer <token>" } },
  "claudeJson": { "mcpServers": { "epsynapse": { "url": "https://api.epsynapse.com/mcp", "headers": { "Authorization": "Bearer <token>" } } } },
  "cursorJson": { "mcpServers": { "epsynapse": { "url": "https://api.epsynapse.com/mcp", "headers": { "Authorization": "Bearer <token>" } } } },
  "curl": "curl -s https://api.epsynapse.com/mcp -H 'Authorization: Bearer <token>' ..."
}
```

Where the session id comes from: the web app stores it in the `epsynapse_sid` cookie and returns it as `sessionId` from `POST /v1/auth/google`. The iOS app keeps it in the keychain and sends it as `x-epsynapse-session`.

## 2. Connect a client

### Perplexity

Settings > Connectors > Add connector > MCP. Pick the remote (URL) option.

- Server URL: `https://api.epsynapse.com/mcp`
- Header: `Authorization` with value `Bearer <token>`

Perplexity will call `initialize` and `tools/list`. You should see 36 tools. Ask it something like "what OneNote notebooks do I have" or "add a todo for the chem lab due Friday".

### Claude Desktop

Add to `claude_desktop_config.json` (this is the `claudeJson` blob from `/v1/me/mcp`):

```json
{
  "mcpServers": {
    "epsynapse": {
      "url": "https://api.epsynapse.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

If your Claude build only speaks stdio, wrap it with `npx mcp-remote https://api.epsynapse.com/mcp --header "Authorization: Bearer <token>"`.

### Cursor

`.cursor/mcp.json` in any project, or the global one:

```json
{
  "mcpServers": {
    "epsynapse": {
      "url": "https://api.epsynapse.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### Raw curl

```bash
TOKEN=...
curl -s https://api.epsynapse.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}' -i
```

The response carries `Mcp-Session-Id`. Send it back on later calls. It is optional because auth is per request, but clients that follow the spec will do it.

```bash
curl -s https://api.epsynapse.com/mcp -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"connection_status","arguments":{}}}'
```

## 3. Tools

Every tool runs as the student whose token you sent. Nothing is shared between accounts.

Start with `connection_status`. It reports which of Canvas, OneDrive, OneNote, Outlook, and Teams are connected, and when Microsoft has denied a scope it returns the admin approval link.

| Group | Tools |
|-------|-------|
| Notes | `list_notes`, `read_note`, `add_note`, `update_note`, `delete_note` |
| Todos | `list_todos`, `add_todo`, `update_todo`, `complete_todo`, `delete_todo` |
| Classes | `list_classes`, `rename_class` |
| Class files | `list_class_files`, `write_class_file`, `read_class_file`, `delete_class_file` |
| Todo files | `list_todo_files`, `write_todo_file`, `read_todo_file`, `delete_todo_file` |
| OneDrive | `list_onedrive_files`, `read_onedrive_file`, `write_onedrive_file` |
| OneNote | `list_onenote_notebooks`, `list_onenote_sections`, `list_onenote_pages`, `read_onenote_page`, `create_onenote_page` |
| Outlook | `list_outlook_mail`, `read_outlook_mail`, `send_outlook_mail`, `list_outlook_events` |
| Teams | `list_teams_chats`, `read_teams_thread`, `send_teams_message` |
| Status | `connection_status` |

36 tools. The chatbot's `open_page` tool is hidden because it only moves the web dashboard.

Input schemas are the same JSON schemas the chatbot uses. `tools/list` returns them.

Tool errors come back as a normal result with `isError: true` and a plain sentence, for example "Connect OneDrive in settings first." Unknown tool names are a JSON-RPC `-32602` error.

## 4. Protocol details

| Route | What |
|-------|------|
| `POST /mcp` | JSON-RPC in, JSON out. Handles `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`, plus empty `resources/list` and `prompts/list`. Batch arrays work. Notifications alone return 202. |
| `GET /mcp` | 405 with `Allow: POST, DELETE, OPTIONS`. No standalone SSE stream. |
| `DELETE /mcp` | Ends the `Mcp-Session-Id` session. 200. |
| `OPTIONS /mcp` | 204. CORS is `*` for this path only. |
| `GET /.well-known/oauth-protected-resource` | `{ resource, authorization_servers: [], bearer_methods_supported: ["header"] }` |
| `GET /v1/me/mcp` | Connect token and ready-to-paste client configs. Needs the normal cookie or `x-epsynapse-session` header. |

If a client sends `Accept: text/event-stream` without `application/json`, the single response is wrapped as one SSE `data:` event. Everyone else gets plain JSON.

`Mcp-Session-Id` is issued on `initialize` and lives 24 hours in memory. An unknown id gets 404 so the client re-initializes. Sessions do not survive a server restart, which is also a re-initialize for the client.

JSON-RPC errors: `-32600` bad request shape, `-32601` unknown method, `-32602` unknown tool or bad arguments, `-32000` tool threw.

The server logs one line per `tools/call`: tool name and student email. No arguments, no tokens.

## 5. Auth model and its limits

The bearer token is your EPSynapse session id. That is the same value in your `epsynapse_sid` cookie. We reuse it for the hackathon instead of standing up an OAuth 2.1 authorization server.

What that means:

- Anyone with the token is you until it expires or you sign out of the web app. Treat it like a password.
- Signing out at epsynapse.com kills the token. Every connected MCP client stops working until you paste a new one.
- Session cookies last 30 days. Expect to re-paste about monthly.
- There is no OAuth discovery. `/.well-known/oauth-protected-resource` returns an empty `authorization_servers` list so clients that try OAuth fail fast instead of hanging. Use the bearer header.
- Missing or bad token: `401` with `WWW-Authenticate: Bearer realm="EPSynapse"` and body `{ "error": "Sign in at https://epsynapse.com, open Settings > MCP, and paste the connect token." }`.

## 6. Microsoft tools need school IT approval

OneDrive, OneNote, Outlook, and Teams go through Microsoft Graph with the student's school account. Eastside Prep's tenant blocks new app permissions until an admin approves them once. Those Microsoft tools stay off until `MICROSOFT_CLIENT_ID` is set to EPSynapse's own registration. EPSynapse never signs in with device code or a stored password.

Until school IT approves the app, those tools return `isError: true` with the honest message, for example "OneNote needs Notes access on this Microsoft sign-in. Connect OneDrive again after school IT accepts the app." `connection_status` shows the same thing per service and includes `adminConsentUrl` once a client id is set.

The approval link is also returned as `adminConsentUrl` from `GET /v1/me`. It points at `https://login.microsoftonline.com/<EPS tenant>/v2.0/adminconsent?client_id=...`. Send it to school IT. They click once, sign in as a tenant admin, accept, and every student's Microsoft tools start working after they reconnect.

Local notes and todos, class files, and Canvas tools do not depend on Microsoft and work right away.

## 7. Running it locally

The MCP routes are mounted by `server/index.js`, so `npm run server` (port 3006) already serves `/mcp`. For a spare port:

```bash
cd server && PORT=3198 node --env-file=.env index.js
```

Then hit `localhost:3198/mcp` with the curls above. A restart of the LaunchAgent (`launchctl kickstart -k "gui/$(id -u)/com.jype.server"`) is needed on the Mac Studio after pulling this.
