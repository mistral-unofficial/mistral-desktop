# Mistral Desktop — Technical Documentation

This document contains the technical details for developers, testers, and contributors. For a user-friendly introduction, see the main [README.md](../README.md).

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      Renderer (React)                        │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │   ChatView   │  │  CodeView    │  │    SettingsView     │ │
│  │  (streaming) │  │  (Vibe/ACP)  │  │  (accounts, MCP,    │ │
│  │  Markdown    │  │  sessions)   │  │   Vibe config)      │ │
│  └──────────────┘  └──────────────┘  └─────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                              │
              Typed IPC (contextIsolation, src/shared/api.ts)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     Main Process (Electron)                 │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  settings   │  │   vault     │  │   conversations     │  │
│  │  (SQLite)   │  │  (encrypted │  │   (SQLite)          │  │
│  │             │  │   store)    │  │                     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                     Services                          │  │
│  │  • account.ts      - Mistral API key / OAuth          │  │
│  │  • chat/           - Mistral API streaming, tools     │  │
│  │  │   └─ mistral.ts  - SSE completions                 │  │
│  │  │   └─ run.ts      - tool loop with per-call approval│  │
│  │  • code/           - Vibe ACP client, sessions        │  │
│  │  │   └─ acp-client  - Agent Client Protocol over stdio│  │
│  │  │   └─ service.ts  - sessions, permissions, auth     │  │
│  │  • mcp/            - MCP host (stdio/HTTP/SSE)        │  │
│  │  │   └─ host.ts     - MCP client implementations      │  │
│  │  │   └─ oauth.ts   - OAuth flow (PKCE)                │  │
│  │  • mcpb/           - .mcpb bundle management          │  │
│  │  │   └─ bundle.ts  - parsing, validation              │  │
│  │  │   └─ store.ts   - extension settings               │  │
│  │  • vault.ts        - encrypted store (keychain)       │  │
│  │  • vibe-creds.ts   - Vibe credential management       │  │
│  │  • web-session.ts  - browser sign-in helper           │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

```
renderer (React)  ──IPC (contextIsolation, typed in src/shared/api.ts)──>  main (Electron)
```

The renderer and main processes communicate via a typed IPC layer defined in `src/shared/api.ts`. Context isolation is enabled, with no Node.js integration in the renderer for security.

---

## Technology Stack

| Layer | Technology | Version |
|-------|------------|---------|
| **Runtime** | Electron | 45.x |
| **Bundler** | Vite | 8.x |
| **UI** | React | 19.x |
| **Language** | TypeScript | 5.9.x |
| **AI Engine** | Mistral Vibe CLI | 3.0.4+ |
| **Protocol** | Agent Client Protocol (ACP) | via `vibe-acp` |
| **MCP SDK** | @modelcontextprotocol/sdk | 1.32.x |
| **MCPB** | @anthropic-ai/mcpb | 2.1.x |
| **Markdown** | react-markdown + remark-gfm | latest |
| **Validation** | Zod | 4.x |
| **Build** | electron-builder | 26.x |
| **Testing** | Vitest | 5.x |

---

## Project Structure

```
mistral-desktop/
├── src/
│   ├── main/                    # Electron main process
│   │   ├── account.ts           # API key / OAuth management
│   │   ├── chat/
│   │   │   ├── mistral.ts       # Mistral API client (SSE)
│   │   │   └── run.ts           # Tool execution loop
│   │   ├── code/
│   │   │   ├── acp-client.ts    # ACP client for vibe-acp
│   │   │   └── service.ts       # Code session management
│   │   ├── mcp/
│   │   │   ├── host.ts          # MCP server hosting
│   │   │   └── oauth.ts         # OAuth 2.0 flow with PKCE
│   │   ├── mcpb/
│   │   │   ├── bundle.ts        # .mcpb bundle parsing/validation
│   │   │   └── store.ts         # Extension settings storage
│   │   ├── conversations.ts     # Chat conversation storage (SQLite)
│   │   ├── settings.ts          # App settings (SQLite)
│   │   ├── vault.ts             # Encrypted secrets store
│   │   ├── vibe-creds.ts        # Vibe credential management
│   │   └── web-session.ts       # Browser sign-in helper
│   │   └── index.ts             # Electron entry point
│   │
│   ├── renderer/                # React frontend
│   │   ├── src/
│   │   │   ├── App.tsx
│   │   │   ├── main.tsx
│   │   │   ├── chatState.ts     # Chat tab state
│   │   │   ├── codeState.ts     # Code tab state
│   │   │   ├── sessions.ts      # Session management
│   │   │   ├── MentionTextarea.tsx  # @-mention autocomplete
│   │   │   ├── fileMatch.ts     # File fuzzy matching
│   │   │   ├── format.ts        # Text formatting utilities
│   │   │   ├── configForm.ts    # Configuration forms
│   │   │   ├── sidebar.tsx      # Side navigation
│   │   │   ├── ContextMenu.tsx  # Right-click menus
│   │   │   ├── AccountMenu.tsx  # Account dropdown
│   │   │   ├── mcpImport.ts     # MCP server import
│   │   │   ├── settingsSections.ts
│   │   │   └── views/
│   │   │       ├── ChatView.tsx
│   │   │       ├── CodeView.tsx
│   │   │       ├── WorkView.tsx
│   │   │       ├── WorkspaceList.tsx
│   │   │       ├── SettingsView.tsx
│   │   │       └── ExtensionsSection.tsx
│   │   └── index.html
│   │
│   └── shared/                  # Shared code
│       ├── api.ts               # Typed IPC contracts
│       ├── types.ts             # Shared TypeScript types
│       ├── mentions.ts          # File mention types
│       └── config-options.ts    # Configuration options
│
├── e2e/                        # End-to-end tests
│   ├── mock-mistral.mjs        # Mock Mistral API server
│   ├── mock-vibe-llm.mjs       # Mock Vibe LLM server
│   ├── smoke.cjs               # Full e2e test suite
│   └── mentions.cjs            # @-mention test suite
│
├── spikes/                     # Experimental code
│   └── acp/                     # ACP protocol experiments
│
├── img/                        # Assets
│   └── screen1.png             # Screenshot
│
├── docs/
│   └── TECHNICAL.md            # This file
│
├── package.json
├── electron.vite.config.ts
├── electron-builder.yml
├── tsconfig.json
├── vitest.config.mts
├── PLAN.md                     # Design document
├── README.md                   # User-facing documentation
└── LICENSE
```

---

## Implementation Details

### Chat Tab

The Chat tab provides streaming completions from the Mistral API:

- **Streaming**: Uses Server-Sent Events (SSE) for real-time response streaming
- **Markdown**: Full CommonMark support with tables, lists, code blocks
- **Code blocks**: Include copy buttons for easy code extraction
- **Tool use**: MCP tools are presented as expandable cards with approve/deny controls
- **History**: Conversations are stored in SQLite and can be resumed

### Code Tab

The Code tab runs Mistral Vibe via the Agent Client Protocol (`vibe-acp`):

- **Vibe Integration**: Spawns `vibe-acp` as a subprocess with the selected folder as cwd
- **Session Management**: Create, resume, fork, and close sessions
- **@-mentions**: Type `@` to autocomplete files/folders; uses git tracking or folder walk
- **File Diffs**: Shows changes before they're applied
- **Permission Prompts**: Approve or deny file edits and shell commands per-call or globally
- **MCP Passthrough**: App-managed MCP servers are passed to Vibe through ACP session setup
- **Session Resume**: Lists previous Vibe sessions per folder; requires Vibe ≥3.0.4

### MCP Server Support

Three types of MCP servers are supported:

#### 1. Extensions (.mcpb)
- Install via *Install extension...* button or drag-and-drop
- Shows manifest permissions before installation
- User settings are collected (secrets go to OS keychain)
- Servers start automatically and can be disabled/uninstalled
- Updating a bundle preserves user settings
- **Note**: Bundle signatures are detected but **not verified** (install dialog warns users)

#### 2. Local Servers
- Any stdio command can be registered as an MCP server
- Can be added manually or by pasting a `{ "mcpServers": ... }` block.
- Entries with a `url` field become remote servers

#### 3. Remote Servers
- HTTP endpoints (streamable HTTP with automatic SSE fallback)
- Optional headers and OAuth sign-in
- *Sign in* button opens the system browser for OAuth
- Tokens are stored securely in the OS keychain
- **Warning**: Static header values are stored **unencrypted** in `settings.json`; prefer OAuth

### Authentication

#### Mistral API Key
- Stored in OS keychain via Electron's `safeStorage`
- Can be set in Settings → Account or via `MISTRAL_API_KEY` environment variable
- Shared between Chat and Code tabs

#### Browser Sign-in
- Uses Vibe's ACP `authenticate` flow
- Opens system browser for PKCE-based sign-in against `console.mistral.ai`
- Result is a **Mistral API key** (not a subscription token)
- Key is persisted to Vibe's credential store (`~/.vibe/.env` or keyring)
- The app can reuse this key with user consent

#### OAuth for MCP Servers
- Full OAuth 2.0 flow with PKCE
- Discovery, dynamic registration, token refresh supported
- Tested against mock servers; real provider testing pending
- Tokens stored in OS keychain

### Security Considerations

- **API Keys**: Stored in OS keychain (Electron `safeStorage`)
- **OAuth Tokens**: Stored in OS keychain
- **Extension Secrets**: Stored in OS keychain
- **MCPB Bundles**: Signatures detected but not verified; users are warned
- **Remote MCP Headers**: Static headers stored unencrypted in `settings.json`
- **Code Tab**: cwd is NOT sandboxed; permission prompts gate writes and shell commands; use Vibe's `ask` mode
- **Linux**: If no keyring is available, `safeStorage` falls back to a 0600 file with a warning in Settings

---

## Development Setup

### Prerequisites

- Node.js 20+
- npm 10+
- For Code tab: Mistral Vibe CLI (`uv tool install mistral-vibe`)
- For MCP extensions: Python/uv or Node.js depending on bundle requirements

### Installation

```bash
# Clone the repository
git clone https://github.com/wolfposd/mistral-desktop.git
cd mistral-desktop

# Install dependencies
npm install

# Development mode
npm run dev

# Build for production
npm run build

# Preview built app
npm run start

# Build and package
npm run dist        # Package for current platform
npm run dist:mac    # macOS only
npm run dist:dir    # Build to directory (no package)
```

### Type Checking & Testing

```bash
# Type check
npm run typecheck

# Run unit tests (vitest)
npm run test

# Type check + unit tests
npm run check

# End-to-end tests (requires vibe-acp)
VIBE_ACP=$(command -v vibe-acp) xvfb-run -a npm run e2e:mentions   # @-mention tests
VIBE_ACP=$(command -v vibe-acp) xvfb-run -a npm run e2e          # Full test suite
```

### Test Environment

- E2e tests use **mock servers** (`e2e/mock-mistral.mjs` for Chat, `e2e/mock-vibe-llm.mjs` for Vibe)
- No real Mistral API key or account required for testing
- Tests verify against mocks only; real-model behavior is untested

---

## Known Limitations & Gaps

### General
- ❌ Never tested against real Mistral API or real Mistral account
- ❌ Real-model behavior untested
- ❌ Vibe browser sign-in flow untested with real account
- ❌ Model-list filtering untested
- ❌ No auto-update mechanism
- ❌ No code signing for builds
- ❌ No syntax highlighting in Markdown code blocks

### MCPB (Extensions)
- ❌ Bundle signatures **detected but not verified** (install dialog warns users)
- ❌ Python and `uv` bundles require Python/uv on the machine
- ❌ Node bundles use system `node`, or app's built-in Node if none exists
- ❌ Not supported: bundle localization, `prompts`, auto-update
- ❌ Not supported: installing by double-clicking a file
- ❌ Tested with synthetic bundles only, not real third-party bundles

### Remote MCP
- ❌ Static header values stored **unencrypted** in `settings.json` (prefer OAuth)
- ❌ OAuth tested against mock server only (discovery, dynamic registration, PKCE, refresh)
- ❌ Real provider OAuth untested
- ⚠️ In Code tab, OAuth servers passed to Vibe with current access token; stop working when token expires until session restart

### Code Tab
- ❌ No terminal pane
- ❌ Permission prompt UI covered by unit tests only (not e2e)
- ❌ cwd is NOT sandboxed; document this clearly
- ⚠️ MCP tools in Vibe reach model through code-mode (`search_tool_functions` + `run_typescript`), not as direct tools
- ⚠️ How well Mistral models use MCP tools in Code tab depends on this code-mode flow (untested)

### Session Resume
- ⚠️ Replays stored conversation as flat history (no scroll-to-position)
- ⚠️ Sessions listed per folder and per Vibe home
- ⚠️ Requires Vibe ≥3.0.4 with `session/list` and `session/load` support
- ⚠️ History button hidden if Vibe doesn't support session operations

---

## Vibe Integration Details

### Mistral Vibe Overview
Source: [mistral-vibe GitHub](https://github.com/mistralai/mistral-vibe) (read at commit 338ad4b, v3.0.4).

**Three entry points** (`pyproject.toml`):
- `vibe` — TUI / `--prompt` headless mode
- `vibe-acp` — Agent Client Protocol over stdio (chosen for this app)
- `vibe-app-server` — JSON-RPC 2.0 over stdio, documented in `docs/reference/app-server-protocol.md` and ADR 0009

### Integration Options Comparison

| Option | Pros | Cons |
|---|---|---|
| **`vibe-acp`** (chosen) | Open standard; `load_session`, list/fork/close sessions, images, embedded context; `new_session(cwd, mcp_servers)` accepts stdio/HTTP/SSE MCP servers | Only what ACP exposes |
| **`vibe-app-server`** | Richest: turn queue and steering, interrupt, session resume/fork, history, config read/write, setup/credential endpoints, MCP add/auth, worktrees, client-provided tools; Mistral's own desktop clients use it | Newer, Mistral-specific, "current dispatcher still contains coupling" per docs; protocol may change |
| **`vibe --prompt --output streaming`** | Trivial to implement | One-shot, no interactive permission prompts (only `--auto-approve`) |

### Vibe Configuration
- MCP servers in Vibe: Configured via `[[mcp_servers]]` in `config.toml` (stdio / http / streamable-http), or `vibe mcp add`
- Per-server auth: `static` or `oauth`, tokens stored in OS keyring
- Config is layered: project `./.vibe/config.toml` overrides `~/.vibe/`
- Custom home: Set via `VIBE_HOME` environment variable (documented as "Custom Vibe Home Directory")
- Folder trust: Vibe asks before trusting a folder containing `.vibe/`; app can pre-trust via app-server workspace-trust ops
- Permissions: Agents support `accept-edits` (default), `ask`, `auto-approve`; per-tool permission config available
- Sandbox: app-server supports a sandboxed workspace mode (file/shell tools in sandbox); worth evaluating for real isolation

### Vibe Distribution
- Vibe is Python-based
- App should detect installed `vibe`/`vibe-acp` on PATH or in `~/.local/bin`
- Can offer to install via `uv tool install mistral-vibe` with user consent
- Repository ships PyInstaller specs (`vibe-acp.spec`, `vibe-app-server.spec`), so bundling a frozen binary is possible
- Check license and binary size before deciding to bundle

### Le Chat Desktop Overlap
- Mistral appears to ship its own "Le Chat Desktop" with a Code mode
- This project's differentiation: open-source, MCPB-first, API-key friendly

### Milestone 0 Results
Verified by driving `vibe-acp` over JSON-RPC from Node:
- `initialize` OK. With no key and default provider, `authMethods` = `[{id:"browser-auth", name:"Sign in through Mistral AI Studio"}]`; `session/new` fails with "Missing API key for mistral provider". With configured key/provider, `authMethods` is `[]`.
- `session/new {cwd, mcpServers}` OK. Returns modes `ask` / `accept-edits` (default) / `auto-approve`, available slash commands (`/compact`), and `configOptions`.
- `session/prompt` streams `session/update` notifications: `agent_message_chunk`, `tool_call` / `tool_call_update` carrying `diff` content (path, newText), `usage_update` (tokens, context size), `session_info_update` (auto title), `user_message_chunk`. `stopReason: end_turn`.
- A `write_file` tool call really created the file inside the session cwd.
- In `accept-edits` mode file writes ran without a permission request (as documented).
- **MCP passthrough works**: a stdio server given in `mcpServers` shows up as connector `mcp_<name>` (e.g. `mcp_demo.echo`). MCP tools are *not* direct function-calling tools; the model finds them with `search_tool_functions` and calls them from `run_typescript`.
- Initialisation is asynchronous: a failure arrives later as an `agent_message_chunk` ("MCP server 'demo' failed to connect: mcp_transport_failed"). The UI must surface that, and should wait or show a "connecting" state before the first prompt.
- Custom OpenAI-compatible providers work (`[[providers]]` / `[[models]]` in `config.toml`) but must stream `usage` in the last chunk.

Verified manually with a real Mistral account (milestone 6):
- The real `authenticate` browser flow works outside an editor
- The minted API key also works for the Chat tab, so no billing/entitlement question remains

---

## Design Decisions

### ACP over App-Server
- **Chosen**: Agent Client Protocol (`vibe-acp`) for Code tab integration
- **Rationale**: Open standard, stable, well-documented
- **Alternative**: `vibe-app-server` (richer features but Mistral-specific, may change)
- **Future**: May add app-server as a second backend if ACP proves limiting

### Authentication Strategy
- **Approach**: Support both API key and browser sign-in
- **Finding**: Vibe's browser sign-in mints an API key (not a subscription token)
- **Flow**: PKCE against `console.mistral.ai`, result stored in `~/.vibe/.env` or keyring
- **Note**: No public third-party subscription-OAuth flow found for Mistral

### MCP Passthrough
- **Approach**: Pass app-managed MCP servers to Vibe via ACP `session/new {mcpServers}`
- **Result**: Servers appear as `mcp_<name>` connectors in Vibe
- **Limitation**: MCP tools in Vibe go through code-mode, not as direct tools

---

## Milestones

| # | Milestone | Status | Notes |
|---|-----------|--------|-------|
| 0 | Spikes | ✅ Done | ACP, MCPB, OAuth experiments |
| 1 | Skeleton | ✅ Done | Electron + React + tabs, IPC, settings |
| 2 | Chat | ✅ Done | API key auth, streaming, history, model picker |
| 3 | MCP Host | ✅ Done | Manual stdio servers, tool calls in Chat |
| 4 | MCPB | ✅ Done | Install, config prompts, update, remove |
| 5 | Code Tab | ✅ Done | Folder picker, ACP client, diffs, permissions, session resume, MCP passthrough |
| 6 | Browser Sign-in | ✅ Done | ACP `authenticate` flow verified manually against a real account; key reused for Chat |
| 7 | Polish | ⏳ Pending | Auto-update, crash reporting opt-in, onboarding, signed builds |

---

## Risks

1. **Vibe Stability**: ACP coverage or flags may change between versions; pin and test supported version range

---

## References

- [Mistral Vibe CLI](https://github.com/mistralai/mistral-vibe) — Official repository
- [Vibe MCP Documentation](https://docs.mistral.ai/vibe/code/cli/mcp-servers) — MCP server setup
- [Vibe on ACP](https://zed.dev/acp/agent/mistral-vibe) — Agent Client Protocol integration
- [Model Context Protocol](https://modelcontextprotocol.io) — MCP specification
- [PLAN.md](../PLAN.md) — Detailed design, findings, and roadmap

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests: `npm run check`
5. Submit a pull request

---

*Last updated: See git history for changes*
