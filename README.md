# Mistral Desktop

A desktop app in the spirit of Claude Desktop, built on Mistral: a **Chat** tab, a **Code** tab that runs [Mistral Vibe](https://github.com/mistralai/mistral-vibe) inside a folder you choose, and local **MCP** servers. Electron + React + TypeScript.

> Status: early. See [PLAN.md](PLAN.md) for the design, findings and roadmap, and "Known gaps" below.

## Run it

```bash
npm install
npm run dev          # development
npm run build && npm start
```

- **Chat** needs a Mistral API key (Settings → Mistral API key, or `MISTRAL_API_KEY` in the environment).
- **Code** needs Vibe: `uv tool install mistral-vibe`. The app looks for `vibe-acp` on `PATH` and in `~/.local/bin`, or use the path in Settings. The key from Settings is passed to Vibe; if Vibe offers browser sign-in the Code tab shows a button for it.
- **MCP servers** (Settings): add local stdio servers by hand or paste a `{ "mcpServers": … }` block (e.g. from `claude_desktop_config.json`). They are available to Chat as tools (each call needs your approval unless you tick "Auto-approve tools") and are passed to Vibe in the Code tab.

## How it fits together

```
renderer (React)  ──IPC (contextIsolation, typed in src/shared/api.ts)──  main (Electron)
 Chat / Code / Settings                                                     settings.ts      API key via OS keychain (safeStorage)
                                                                            chat/mistral.ts  streaming chat completions (SSE)
                                                                            chat/run.ts      tool loop with per-call approval
                                                                            mcp/host.ts      MCP client for stdio servers
                                                                            code/acp-client  Agent Client Protocol over `vibe-acp`
                                                                            code/service.ts  sessions, permissions, auth, recent folders
```

## Tests

```bash
npm run check        # typecheck + unit tests (vitest)
VIBE_ACP=$(command -v vibe-acp) xvfb-run -a npm run e2e   # drives the real app with Playwright (needs Playwright, a display, vibe-acp)
```

The e2e test uses local mock servers instead of Mistral (`e2e/mock-mistral.mjs` for Chat, `e2e/mock-vibe-llm.mjs` for Vibe), so it needs no account or network. `spikes/acp/` holds the earlier protocol experiments.

## Known gaps

- **Never run against the real Mistral API or a real Le Chat/Mistral account**: everything is verified against mocks, plus the real `vibe-acp` binary talking to a mock model. Real-model behaviour, the browser sign-in flow, and model-list filtering are untested.
- **MCPB (`.mcpb`) install is not implemented yet.** Servers are configured manually or via JSON import.
- Only local **stdio** MCP servers; no remote HTTP/OAuth servers.
- In Vibe, MCP tools reach the model through its code-mode (`search_tool_functions` + `run_typescript`), not as direct tools. How well that works with Mistral models is untested.
- Code tab: no session resume/history, no terminal pane. The permission prompt UI is covered by unit tests, not by the e2e run.
- Chat renders plain text and fenced code blocks only (no Markdown).
- No packaging/auto-update/code signing yet. The `Code` agent's cwd is not a sandbox; use Vibe's `ask` mode to review actions.
- Electron's `safeStorage` on Linux without a keyring is detected and the app falls back to a 0600 file, saying so in Settings.
