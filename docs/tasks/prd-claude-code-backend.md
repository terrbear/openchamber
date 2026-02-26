# PRD: Claude Code Backend

## Introduction

OpenChamber currently works exclusively as a frontend shell for the OpenCode CLI — it spawns an OpenCode server process and proxies all API traffic to it. This feature adds Claude Code CLI (`claude`) as an alternative backend, selectable at startup via a `--backend` flag. When running with `--backend claudecode`, OpenChamber starts a lightweight adapter HTTP server that translates between Claude Code's `--print --output-format=stream-json` subprocess interface and the OpenCode HTTP/SSE API that the existing UI already speaks. No existing OpenCode code changes.

## Goals

- Allow `openchamber serve --backend claudecode` to start successfully using the `claude` binary.
- Implement a Claude Code adapter HTTP server that exposes the minimal OpenCode-compatible API the UI needs.
- Stream Claude Code responses to the UI in real time using OpenCode's SSE event format.
- Persist sessions across restarts via a JSON session registry file.
- Default to `--backend opencode` with zero regression on existing behaviour.
- Show a clear startup message and UI label indicating which backend is active.
- Emit a clear error if the selected backend binary cannot be found.

## User Stories

### US-001: Add `--backend` and `--claude-binary` CLI flags

**Description:** As a developer running OpenChamber, I want to choose the backend at startup so I can use Claude Code as an alternative to OpenCode.

**Acceptance Criteria:**

- [ ] `packages/web/bin/cli.js` parses `--backend <opencode|claudecode>` (default: `opencode`).
- [ ] `packages/web/bin/cli.js` parses `--claude-binary <path>` to override Claude binary location (default: auto-detect `claude` in PATH using the same `searchPathFor` logic used for `opencode`).
- [ ] When `--backend opencode` (or flag omitted), execution is identical to today — `checkOpenCodeCLI()` is called, `OPENCODE_BINARY` is set, no other changes.
- [ ] When `--backend claudecode`, `checkClaudeCodeCLI()` is called to locate the `claude` binary; if not found the process exits with a clear error message: `Error: Unable to locate the claude CLI. Specify its path with --claude-binary or CLAUDECODE_BINARY.`
- [ ] `OPENCHAMBER_BACKEND` env var is set to `opencode` or `claudecode` before the server process is spawned.
- [ ] `CLAUDECODE_BINARY` env var is set to the resolved `claude` path when backend is `claudecode`.
- [ ] Help text (`--help`) documents the new flags and environment variables.
- [ ] `CLAUDECODE_BINARY` env var is accepted as an alternative to `--claude-binary` flag.

### US-002: Create Claude Code adapter server module

**Description:** As a developer, I need a standalone Express adapter that implements the OpenCode HTTP API surface the UI relies on, backed by Claude Code subprocess calls.

**Acceptance Criteria:**

- [ ] File created at `packages/web/server/lib/claudecode/adapter.js`.
- [ ] `GET /health` returns `{ "ok": true }` with status 200.
- [ ] `POST /session` creates a new session entry (UUID id, timestamp, optional `title` from request body), stores it in the in-memory registry and persists to `~/.local/share/openchamber/claudecode-sessions.json`, returns session object matching OpenCode session schema `{ id, title, path, created, updated }`.
- [ ] `GET /session` returns array of all sessions from registry, sorted by `updated` descending.
- [ ] `GET /session/:id` returns single session object or 404.
- [ ] `DELETE /session/:id` removes session from registry and persists, returns 200.
- [ ] `GET /session/:id/message` returns array of messages from transcript in `~/.claude/projects/<path-encoded-cwd>/` for the session, or empty array if not found.
- [ ] `POST /session/:id/message` accepts `{ parts: [{ type: "text", text: "..." }] }` (OpenCode message format), spawns `claude --print --output-format=stream-json --resume <sessionId>` with the text piped to stdin, streams the process stdout as SSE events to the client, and returns 200.
- [ ] SSE stream from `POST /session/:id/message` uses `Content-Type: text/event-stream` and writes `data: <json>\n\n` lines.
- [ ] Claude Code stream-json event `{ "type": "text", "text": "..." }` is mapped to an OpenCode `PartEvent` with `{ type: "part", part: { type: "text", text: "..." }, ... }`.
- [ ] Claude Code stream-json event `{ "type": "result", ... }` is mapped to an OpenCode `MessageEvent` marking message completion.
- [ ] `GET /event` and `GET /global/event` return an SSE stream that emits a `session_updated` event when sessions change (create/delete).
- [ ] `GET /config/settings` returns a static JSON object with default values that the UI expects (empty `providers`, empty `models`).
- [ ] `GET /config/agents`, `GET /config/commands`, `GET /config/skills` return `[]`.
- [ ] `POST /config/reload` returns `{ "ok": true }`.
- [ ] All `/fs/*` endpoints return 501 Not Implemented with `{ "error": "not implemented" }`.
- [ ] All `/git/*` endpoints return 501 Not Implemented.
- [ ] All `/terminal/*` endpoints return 501 Not Implemented.
- [ ] Session registry is loaded from disk on adapter startup if the file exists.
- [ ] The adapter module exports a `startClaudeCodeAdapter({ port, claudeBinary, cwd })` function that starts the HTTP server and resolves with `{ port }`.
- [ ] Concurrent `POST /session/:id/message` requests to different sessions each spawn their own `claude` subprocess independently.
- [ ] If a `POST /session/:id/message` is received while a previous claude process for that session is still running, the existing process is killed before starting a new one.

### US-003: Wire Claude Code adapter into server startup

**Description:** As a developer, I need the main server to conditionally start the Claude Code adapter instead of OpenCode when `OPENCHAMBER_BACKEND=claudecode`.

**Acceptance Criteria:**

- [ ] `packages/web/server/index.js` reads `OPENCHAMBER_BACKEND` env var at startup.
- [ ] When `OPENCHAMBER_BACKEND=claudecode`, the existing `startOpenCode()` / `createManagedOpenCodeServerProcess()` code path is skipped entirely.
- [ ] When `OPENCHAMBER_BACKEND=claudecode`, `startClaudeCodeAdapter()` is called to start the adapter on a dynamically assigned free port (similar to how `openCodePort` is chosen today).
- [ ] After `startClaudeCodeAdapter()` resolves, `openCodePort` (or an equivalent variable) is set to the adapter's port so `setupProxy()` routes `/api/*` traffic to the adapter.
- [ ] `setupProxy()` itself is unchanged — it proxies to whatever port is configured.
- [ ] Startup log reads: `[claudecode] Claude Code adapter started on port <N>` when using `claudecode` backend.
- [ ] Startup log reads: `[opencode] OpenCode server started on port <N>` when using `opencode` backend (or existing log is preserved).
- [ ] When `OPENCHAMBER_BACKEND=opencode` (or unset), all existing behaviour is unchanged.
- [ ] The `/api/system/status` endpoint (or equivalent endpoint already served locally by openchamber) includes `{ "backend": "claudecode" }` or `{ "backend": "opencode" }` in its response.

### US-004: UI backend label

**Description:** As a user, I want to see which backend is active in the UI so I know I'm connected to Claude Code rather than OpenCode.

**Acceptance Criteria:**

- [ ] The UI reads the active backend from the server (via `/api/system/status` or an equivalent endpoint already available).
- [ ] When backend is `claudecode`, a visible label in the UI (e.g. in the sidebar, header, or About panel) shows "Claude Code" instead of "OpenCode".
- [ ] When backend is `opencode` (default), the existing label text is unchanged.
- [ ] The change is minimal — no new pages or routes, just a text/label update in the appropriate existing component.
- [ ] Typecheck passes.
- [ ] Verify in browser using dev-browser skill.

## Functional Requirements

- FR-1: `packages/web/bin/cli.js` must accept `--backend opencode|claudecode` flag, defaulting to `opencode`.
- FR-2: `packages/web/bin/cli.js` must accept `--claude-binary <path>` flag and `CLAUDECODE_BINARY` env var to override `claude` binary path.
- FR-3: When `--backend claudecode`, the CLI must search for `claude` in PATH using the existing `searchPathFor()` helper, then shell fallback logic, before failing with a clear error.
- FR-4: The CLI must pass `OPENCHAMBER_BACKEND` and `CLAUDECODE_BINARY` to the server process via environment variables.
- FR-5: `packages/web/server/lib/claudecode/adapter.js` must implement an Express HTTP server exposing the OpenCode-compatible API surface listed in US-002.
- FR-6: The adapter must use a persistent session registry at `~/.local/share/openchamber/claudecode-sessions.json`, creating the directory if needed.
- FR-7: The adapter must spawn `claude --print --output-format=stream-json --resume <sessionId>` for each message request, piping the message text to stdin.
- FR-8: The adapter must convert Claude Code stream-json lines to OpenCode SSE `data:` events in real time as stdout is received.
- FR-9: `packages/web/server/index.js` must skip OpenCode startup when `OPENCHAMBER_BACKEND=claudecode` and instead start the Claude Code adapter.
- FR-10: The proxy target port must be set to the adapter's port so all `/api/*` requests reach the adapter.
- FR-11: `/api/system/status` must include a `backend` field with the active backend name.
- FR-12: The UI must display the active backend name in an appropriate location.

## Non-Goals

- Terminal emulation support in the Claude Code backend.
- Full filesystem browser (`/fs/*`) in the Claude Code backend.
- Git operations (`/git/*`) in the Claude Code backend.
- Claude Code configuration management (agents, skills, commands — stubs only).
- Desktop (Tauri) or VSCode extension backend switching.
- Any modification to existing OpenCode code paths.
- Automatic session synchronisation from `~/.claude/projects/` on startup (sessions are registered by the adapter when created via `POST /session`; existing external sessions are not imported).

## Technical Considerations

- The adapter should be a standalone module so it can be tested in isolation without starting the full OpenChamber server.
- Claude Code stream-json format: each stdout line is a newline-delimited JSON object with a `type` field. Key types: `{ type: "text", text: "..." }`, `{ type: "tool_use", ... }`, `{ type: "result", ... }`.
- OpenCode SSE format: each event is `data: <json>\n\n` where the JSON matches OpenCode's `Event` union type from `@opencode-ai/sdk/v2`.
- The adapter's Express server should bind to `127.0.0.1` only (not `0.0.0.0`), since it is an internal proxy target.
- Port selection for the adapter: use `net.createServer()` to find a free port, same pattern used in `cli.js` for the `isPortAvailable()` check.
- The `cwd` for claude subprocess invocations should default to the working directory OpenChamber was started in, matching how OpenCode uses `openCodeWorkingDirectory`.
- Session IDs passed to `--resume` must match what Claude Code expects. Since Claude Code uses its own session identifiers from `~/.claude/projects/`, the adapter should pass through the id it assigned and let `--resume` handle the mapping (or generate IDs compatible with Claude Code's scheme).
- Keep all existing module-level variables and functions in `server/index.js` untouched. Add a new conditional block around the backend startup, not a refactor of existing code.

## Success Metrics

- `openchamber serve --backend opencode` passes all existing manual smoke tests with no regression.
- `openchamber serve --backend claudecode` starts, responds to `GET /api/health` with `{ "ok": true }`, and allows the user to create a session and receive a streamed response through the UI.
- Sessions created while using the Claude Code backend are listed on the next restart of OpenChamber with `--backend claudecode`.
- Running `openchamber serve` without `--backend` defaults to OpenCode behaviour (backward compatible).

## Open Questions

- Claude Code's `--resume <sessionId>` requires a session ID in Claude's own format (stored under `~/.claude/projects/`). The adapter creates sessions with UUIDs. Should the adapter use a two-level ID scheme (internal UUID -> Claude session ID) populated after the first message, or should it generate IDs that match Claude's scheme from the start?
- Should `GET /session/:id/message` attempt to parse Claude's JSONL transcript files from `~/.claude/projects/` to reconstruct message history, or return an empty array for MVP?
- If `claude --resume` fails because the session ID is not recognised (e.g. new session), should the adapter fall back to starting a fresh conversation without `--resume`?
