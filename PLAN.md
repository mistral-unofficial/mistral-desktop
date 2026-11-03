# Mistral Desktop — Plan

A desktop app that behaves like Claude Desktop but runs on Mistral: a **Chat** tab, a **Code** tab bound to a local folder, and local **MCP** servers (including `.mcpb` bundles).

## Decisions
- **Shell:** Electron + TypeScript + React.
- **Auth:** support a Mistral **API key** and **browser sign-in** (see findings: Vibe's browser sign-in mints an API key; no public third-party subscription-OAuth was found).
- **Code tab engine:** Mistral **Vibe CLI** over ACP (`vibe-acp`), not a custom agent loop; `vibe-app-server` is the fallback if ACP is too limited.

## Findings from reading mistral-vibe (v3.0.4, Apache-2.0, Python >=3.12)
Source: https://github.com/mistralai/mistral-vibe (read at commit 338ad4b).

**Three entry points** (`pyproject.toml`): `vibe` (TUI / `--prompt` headless), `vibe-acp` (Agent Client Protocol over stdio), `vibe-app-server` (JSON-RPC 2.0 over stdio, documented in `docs/reference/app-server-protocol.md` and ADR 0009).

**Integration options for the Code tab**
| Option | Pros | Cons |
|---|---|---|
| `vibe-acp` | Open standard; `load_session`, list/fork/close sessions, images, embedded context; `new_session(cwd, mcp_servers)` accepts stdio/HTTP/SSE MCP servers, so app-managed MCP servers can be passed straight in | Only what ACP exposes |
| `vibe-app-server` | Richest: turn queue and steering, interrupt, session resume/fork, history, config read/write, setup/credential endpoints, MCP add/auth, worktrees, client-provided tools. Mistral's own desktop clients use it (README mentions "Le Chat Desktop" creating worktrees) | Newer, Mistral-specific, "current dispatcher still contains coupling" per its own docs; protocol may change |
| `vibe --prompt --output streaming` | Trivial | One-shot, no interactive permission prompts (only `--auto-approve`) |

**Decision:** start with **ACP** (stable, standard), wrap it behind our own `CodeBackend` interface, and evaluate app-server as a second backend if ACP is too limited (e.g. turn queueing).

**Auth, the key finding:** Vibe's browser sign-in (`vibe --setup` → "Launch browser") is *not* a subscription token flow. It starts a PKCE process against `console`/`auth.mistral.ai` (`POST {api}/vibe/sign-in`, poll, then exchange) and the result is **a Mistral API key** persisted to `~/.vibe/.env` or the keyring. So "subscription login" in practice means: sign in through the browser, get an API key minted for your workspace. There is also an experimental OIDC mode (`VIBE_CLI_OIDC_ENABLED=1`, first-party public client IDs hardcoded for Mistral) intended for Mistral's own clients. We must not borrow Mistral's first-party client IDs for our app.
- ACP exposes this flow: `initialize` returns `auth_methods` (browser sign-in, optional terminal `vibe --setup`); `authenticate(method_id)` completes it. The Code tab can therefore offer "Sign in with Mistral" without handling credentials itself.
- Chat tab: the same API key works against `api.mistral.ai`. Plan: (a) paste API key, (b) "Sign in with Mistral" reusing Vibe's credential store after Vibe has signed in (read key from keyring / `~/.vibe/.env`, with user consent), (c) a real third-party OAuth flow only if Mistral publishes one. Whether a Le Chat consumer plan includes API/Vibe usage is a billing question to confirm with Mistral, not something the code can settle.

**Other facts that shape the design**
- MCP in Vibe: `[[mcp_servers]]` in `config.toml` (stdio / http / streamable-http), `vibe mcp add`, per-server `auth` (`static` or `oauth`, tokens in OS keyring). English README documents OAuth MCP; the French docs' "no OAuth yet" note appears stale. Still verify at runtime.
- Config is layered: project `./.vibe/config.toml` over `~/.vibe/`. Custom home via env var (README "Custom Vibe Home Directory"), which lets the app run Vibe with an isolated `VIBE_HOME` if we want to keep app state separate.
- Folder trust: Vibe asks before trusting a folder containing `.vibe/`. The app must surface this prompt (or pre-trust via app-server workspace-trust ops).
- Permissions: agents `accept-edits` (default) etc.; `--auto-approve` exists, we should not enable it by default. Per-tool permission config available.
- Sandbox: app-server supports a sandboxed workspace mode (file/shell tools in the sandbox). Worth evaluating later for real isolation; cwd alone is not a sandbox.
- Distribution: Vibe is Python. The app should detect an installed `vibe`/`vibe-acp` (PATH, `uv tool`), or install it via the official one-line installer / `uv tool install mistral-vibe` with user consent. The repo also ships PyInstaller specs (`vibe-acp.spec`, `vibe-app-server.spec`), so bundling a frozen binary is possible. Check license and size before deciding.
- Overlap: Mistral appears to ship its own "Le Chat Desktop" with a Code mode. Confirm what exists before investing, and position this project accordingly (open-source, MCPB-first, API-key friendly).

## Milestone 0 results (spike in `spikes/acp/`, Vibe 3.0.4, mock LLM, no real key)
Verified by driving `vibe-acp` over JSON-RPC from Node:
- `initialize` OK. With no key and the default provider, `authMethods` = `[{id:"browser-auth", name:"Sign in through Mistral AI Studio"}]`; `session/new` fails with "Missing API key for mistral provider". With a configured key/provider, `authMethods` is `[]`. So the app should: call `initialize`, and if `browser-auth` is offered, show a sign-in button that calls `authenticate`. (Not exercised: needs a real Mistral account.)
- `session/new {cwd, mcpServers}` OK. Returns modes `ask` / `accept-edits` (default) / `auto-approve`, available slash commands (`/compact`), and `configOptions`.
- `session/prompt` streams `session/update` notifications: `agent_message_chunk`, `tool_call` / `tool_call_update` carrying `diff` content (path, newText), `usage_update` (tokens, context size), `session_info_update` (auto title), `user_message_chunk`. `stopReason: end_turn`. A `write_file` tool call really created the file inside the session cwd.
- In `accept-edits` mode file writes ran without a permission request (as documented). Permission request handling for `ask` mode and for bash is **not yet tested**.
- **MCP passthrough works, but differently than assumed:** a stdio server given in `mcpServers` shows up as connector `mcp_<name>` (e.g. `mcp_demo.echo`). In this harness MCP tools are *not* direct function-calling tools; the model finds them with `search_tool_functions` and calls them from `run_typescript`. Initialisation is asynchronous: a failure arrives later as an `agent_message_chunk` ("MCP server 'demo' failed to connect: mcp_transport_failed"). The UI must surface that, and should wait or show a "connecting" state before the first prompt. Consequence: how well Mistral models use MCP tools in the Code tab depends on this code-mode flow.
- Custom OpenAI-compatible providers work (`[[providers]]` / `[[models]]` in `config.toml`) but must stream `usage` in the last chunk. Useful for tests and for future non-Mistral endpoints.

Not yet answered:
1. Real `authenticate` browser flow outside an editor (needs a Mistral account; check the `browser-auth-delegated` client meta flag in `vibe/acp/auth.py`).
2. Whether a Le Chat plan grants API access (billing question for Mistral).
3. MCPB manifest spec version and variable substitution; expected to map to a plain stdio `mcpServers` entry.
4. Permission-request round trip in `ask` mode, `session/load` resume, cancel.
5. Compare `vibe-app-server` for turn queueing and richer config if ACP proves limiting.

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
Status: 0-5 implemented and tested against mocks (MCPB install, remote MCP incl. OAuth, Markdown, session resume added). 6 (Vibe browser sign-in against a real account) and 7 (packaging) not started. See README "Known gaps".

0. **Spikes (1–2 days):** install Vibe, drive `vibe-acp` from a script, answer the three open questions above, check MCPB manifest spec version.
1. **Skeleton:** Electron + React + tabs, IPC, settings, keychain, packaging for macOS, Windows and Linux.
2. **Chat:** API key auth, streaming, history, model picker.
3. **MCP host:** manual stdio servers, tool calls in Chat.
4. **MCPB:** install, config prompts, update and remove.
5. **Code tab:** folder picker, ACP client, diffs, permissions, session resume, MCP passthrough.
6. **Browser sign-in:** drive Vibe's ACP `authenticate` flow; reuse the resulting key for Chat.
7. **Polish:** auto-update, crash reporting opt-in, onboarding, signed builds.

## Risks
- Subscription auth may not be available to third-party apps (biggest risk; see Findings, Auth).
- Vibe is young and ACP coverage or flags may change between versions; pin and test a supported version range.
- Mistral's tool-calling quality differs from Claude's; keep the tool loop simple and surface errors clearly.

## References
- Vibe CLI: https://github.com/mistralai/mistral-vibe
- Vibe MCP docs: https://docs.mistral.ai/vibe/code/cli/mcp-servers
- Vibe on ACP: https://zed.dev/acp/agent/mistral-vibe
