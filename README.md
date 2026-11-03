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
- **MCP servers** (Settings) come in three kinds. All are available to Chat as tools (each call needs your approval unless you tick "Auto-approve tools") and are handed to Vibe in the Code tab.
  - **Extensions (`.mcpb`)**: click *Install extension…* (or drop a file). You see what it will run, fill in its settings (secrets go to the OS keychain), and it starts automatically. Settings can be changed later, extensions can be disabled or uninstalled. Updating a bundle keeps your settings.
  - **Local servers**: any stdio command, added by hand or by pasting a `{ "mcpServers": … }` block (e.g. from `claude_desktop_config.json`; entries with a `url` become remote servers).
  - **Remote servers**: a URL (streamable HTTP, with automatic fallback to legacy SSE), optional headers, and OAuth sign-in (*Sign in* opens your browser; tokens are kept in the keychain).
- **Chat** renders Markdown (tables, lists, code blocks with a copy button). Raw HTML is shown as text, links open in your browser, images are not loaded.
- **Code → History** lists earlier Vibe sessions for the current folder; pick one to continue it where you left off.
- **Code → `@` file mentions**: type `@` in the prompt box to complete files and folders of the project, fuzzy-matched and ranked like the Vibe CLI (`@app` finds `src/app.ts`, `@btn` finds `Button.tsx`). Arrow keys move, Enter or Tab inserts, Esc closes. The list comes from git (tracked and untracked, not ignored) or a folder walk, so `.gitignore`d files do not show up. Vibe itself attaches the mentioned files; the app only completes the text in the syntax Vibe reads (names with spaces or characters like `+` are inserted quoted).

## How it fits together

```
renderer (React)  ──IPC (contextIsolation, typed in src/shared/api.ts)──  main (Electron)
 Chat / Code / Settings                                                     settings.ts      API key via OS keychain (safeStorage)
                                                                            chat/mistral.ts  streaming chat completions (SSE)
                                                                            chat/run.ts      tool loop with per-call approval
                                                                            mcp/host.ts      MCP client: stdio, streamable HTTP, SSE; OAuth via mcp/oauth.ts
                                                                            mcpb/            .mcpb parsing/validation (bundle.ts), install + settings (store.ts)
                                                                            vault.ts         encrypted store for extension secrets and OAuth tokens
                                                                            code/acp-client  Agent Client Protocol over `vibe-acp`
                                                                            code/service.ts  sessions, permissions, auth, recent folders
```

## Tests

```bash
npm run check        # typecheck + unit tests (vitest)
VIBE_ACP=$(command -v vibe-acp) xvfb-run -a npm run e2e:mentions   # `@` completion in the real app, with real vibe-acp
VIBE_ACP=$(command -v vibe-acp) xvfb-run -a npm run e2e            # older full tour (see the note under Known gaps)
```

The e2e test uses local mock servers instead of Mistral (`e2e/mock-mistral.mjs` for Chat, `e2e/mock-vibe-llm.mjs` for Vibe), so it needs no account or network. `spikes/acp/` holds the earlier protocol experiments.

## Known gaps

- **Never run against the real Mistral API or a real Mistral account**: everything is verified against mocks, plus the real `vibe-acp` binary talking to a mock model. Real-model behaviour, the Vibe browser sign-in flow, and model-list filtering are untested.
- **MCPB**: bundle signatures are detected but **not verified** (the install dialog says so). Python and `uv` bundles need Python/uv on the machine; Node bundles use your `node`, or this app's built-in Node if you have none. Not supported: bundle localization, `prompts`, auto-update, installing by double-clicking a file. Tested with synthetic bundles, not a library of real third-party ones.
- **Remote MCP**: custom header values (e.g. a static `Authorization` token) are stored **unencrypted** in `settings.json`; prefer OAuth. OAuth is tested against a mock server (discovery, dynamic registration, PKCE, refresh), not a real provider. In the Code tab, OAuth servers are passed to Vibe with the *current* access token, so they stop working when it expires until the app refreshes it (restart the session).
- In Vibe, MCP tools reach the model through its code-mode (`search_tool_functions` + `run_typescript`), not as direct tools. How well that works with Mistral models is untested.
- **Session resume** replays the stored conversation but shows it as a flat history (no scroll-to-position); sessions are listed per folder and per Vibe home. Vibe must support `session/list` and `session/load` (3.0.4 does); otherwise the History button is hidden.
- **`npm run e2e` (smoke.cjs) is out of date**: it was written before the account menu and Code sidebar and fails at its first steps on the current UI (e.g. two "Settings" buttons). `e2e:mentions` is current. Update smoke.cjs before relying on it.
- Code tab: no terminal pane. The permission prompt UI is covered by unit tests, not by the e2e run.
- Markdown has no syntax highlighting.
- No packaging/auto-update/code signing yet. The Code agent's cwd is not a sandbox; use Vibe's `ask` mode to review actions.
- Electron's `safeStorage` on Linux without a keyring is detected and the app falls back to a 0600 file, saying so in Settings.
