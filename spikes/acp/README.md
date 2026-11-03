# ACP spike (Milestone 0)

Drives `vibe-acp` (Vibe 3.0.4) over raw JSON-RPC from Node, with **no real API key**, against a local mock OpenAI-compatible server.

```bash
uv tool install mistral-vibe                 # provides vibe, vibe-acp, vibe-app-server
mkdir -p /tmp/vhome /tmp/proj && cp mock-config.toml /tmp/vhome/config.toml
node mock-llm.mjs &                          # or mock-llm2.mjs (exercises MCP discovery)
MCP_SCRIPT=$PWD/mini-mcp.mjs node acp-drive.mjs "$(command -v vibe-acp)" /tmp/proj /tmp/vhome
```
- `acp-probe.mjs <vibe-acp> <cwd> <vibe-home>`: only `initialize` + `session/new` (shows auth methods and the missing-key error).
- `acp-drive.mjs`: full turn; auto-answers permission requests, logs `session/update` notifications.
- The mock must send `usage` in the final stream chunk (Vibe rejects providers that do not).
