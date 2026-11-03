# Mistral Desktop — Plan

A desktop app that behaves like Claude Desktop but runs on Mistral: a **Chat** tab, a **Code** tab bound to a local folder, and local **MCP** servers (including `.mcpb` bundles).

## Decisions
- **Shell:** Electron + TypeScript + React.
- **Auth:** support both a Mistral **API key** and **subscription login via OAuth**.
- **Code tab engine:** Mistral **Vibe CLI** over ACP (`vibe-acp`), not a custom agent loop.

## Open questions (resolve in Milestone 0)
1. **Subscription OAuth.** We found no public documentation of an OAuth flow that lets a third-party app use a Le Chat plan. Docs only describe API keys (`~/.vibe/.env`, `vibe --setup`). Need to determine: does Vibe have a login command or token store? Does Mistral publish an OAuth client / device-code flow? Can the resulting token call chat completions? If not possible, subscription login is limited to the Code tab (delegated to Vibe) and Chat stays API-key only. Do not reverse-engineer Le Chat's web session.
2. **Vibe OAuth for MCP.** English docs say `[mcp_servers.auth] type = "oauth"` is supported; French docs say it isn't yet. Verify against the installed version.
3. **ACP surface.** Confirm which ACP features `vibe-acp` implements (permission requests, diffs, terminal, session resume, MCP server passthrough).

## Architecture
```
Electron main process
 ├─ Auth service        API key (OS keychain) + OAuth (system browser, loopback redirect, PKCE)
 ├─ Chat service        Mistral API, streaming, tool loop
 ├─ MCP host            spawns/manages local servers, exposes tools to Chat and Code
 │   └─ MCPB manager    install / update / remove .mcpb bundles
 ├─ Code service        one `vibe-acp` subprocess per session, cwd = chosen folder
 └─ Store               SQLite: conversations, sessions, settings
Renderer (React)
 ├─ Chat tab            conversations, model picker, tool-call cards
 ├─ Code tab            folder picker, session view, diffs, permission prompts
 └─ Settings            accounts, MCP servers / extensions, Vibe path, models
```
Main and renderer talk through a typed IPC layer (contextIsolation on, no node integration in the renderer).

## Chat tab
- Streaming completions from the Mistral API, model picker, system prompt, conversation history.
- Tool-use loop: tools from enabled MCP servers are passed to the model; calls render as expandable cards with approve/deny per server or per tool.
- Attachments (images, PDFs) in a later milestone.

## Code tab
- User picks a folder (remembered per project). The app spawns `vibe-acp` with that folder as cwd and speaks ACP over stdio.
- UI: message stream, tool calls, file diffs, permission prompts (allow once / always / deny), cancel, resume session.
- Safety: the agent is scoped to the chosen folder by cwd; permission prompts gate writes and shell commands. Cwd is not a sandbox, so document this clearly and consider OS sandboxing later.
- MCP servers enabled in the app are passed to Vibe through ACP session setup, or by writing a project-scoped `.vibe/config.toml` if ACP passthrough is unsupported.
- Vibe discovery: look on PATH, offer to install, show version and health in Settings.

## MCP and MCPB
- `.mcpb` is a zip containing `manifest.json` plus a server (Node, Python or binary). Install = verify, unzip to the app data dir, parse manifest, collect `user_config` values (secrets go to the keychain), then launch the server over stdio using the manifest's command and args with variable substitution.
- Manual servers: add stdio commands (and later remote HTTP) in Settings with env vars.
- Lifecycle: start on demand, health check, restart, log viewer, per-server enable toggle, shown per tab.
- Security: show manifest permissions before install, never auto-run unsigned bundles without confirmation, keep secrets out of logs.

## Milestones
0. **Spikes (1–2 days):** install Vibe, drive `vibe-acp` from a script, answer the three open questions above, check MCPB manifest spec version.
1. **Skeleton:** Electron + React + tabs, IPC, settings, keychain, packaging for macOS, Windows and Linux.
2. **Chat:** API key auth, streaming, history, model picker.
3. **MCP host:** manual stdio servers, tool calls in Chat.
4. **MCPB:** install, config prompts, update and remove.
5. **Code tab:** folder picker, ACP client, diffs, permissions, session resume, MCP passthrough.
6. **OAuth:** implement whichever flow Milestone 0 confirms; otherwise document the limitation.
7. **Polish:** auto-update, crash reporting opt-in, onboarding, signed builds.

## Risks
- Subscription auth may not be available to third-party apps (biggest risk, see Open question 1).
- Vibe is young and ACP coverage or flags may change between versions; pin and test a supported version range.
- Mistral's tool-calling quality differs from Claude's; keep the tool loop simple and surface errors clearly.

## References
- Vibe CLI: https://github.com/mistralai/mistral-vibe
- Vibe MCP docs: https://docs.mistral.ai/vibe/code/cli/mcp-servers
- Vibe on ACP: https://zed.dev/acp/agent/mistral-vibe
