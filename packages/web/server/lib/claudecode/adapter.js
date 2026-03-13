import express from 'express';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

const DATA_DIR = path.join(os.homedir(), '.local', 'share', 'openchamber');
const SESSIONS_FILE = path.join(DATA_DIR, 'claudecode-sessions.json');

const TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_MAX = 64 * 1024; // 64KB

let _port = null;
let sessions = {};
let _claudeBinary = 'claude';
let _cwd = process.cwd();
let _permissionMode = 'default';

// ---------------------------------------------------------------------------
// Permission rule matching against ~/.claude/settings.json
// ---------------------------------------------------------------------------

// Parse a rule like "Bash(*)" or "Edit(/home/user/**)" or "WebFetch(domain:github.com)"
// Returns { tool, filter } where filter is the string inside parens.
function parseRule(rule) {
  const m = rule.match(/^([^(]+)\((.+)\)$/);
  if (!m) return { tool: rule, filter: '*' };
  return { tool: m[1], filter: m[2] };
}

// Simple glob match supporting * and **
function globMatch(pattern, value) {
  if (pattern === '*') return true;
  // Convert glob to regex: ** matches anything, * matches non-/ chars
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex specials except * and ?
    .replace(/\*\*/g, '\0')                  // placeholder for **
    .replace(/\*/g, '[^/]*')                 // * matches within a path segment
    .replace(/\0/g, '.*');                   // ** matches across segments
  return new RegExp(`^${re}$`).test(value);
}

// Extract the primary value to match against from a tool's input.
function extractToolValue(toolName, input) {
  switch (toolName) {
    case 'Bash':
      return input.command || '';
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'Glob':
    case 'Grep':
    case 'NotebookEdit':
      return input.file_path || input.path || input.pattern || '';
    case 'WebFetch':
    case 'WebSearch':
      return input.url || input.domain || '';
    case 'Agent':
      return input.prompt || '';
    default:
      return '';
  }
}

// Check if a single rule matches a tool invocation.
function ruleMatches(rule, toolName, input) {
  const { tool, filter } = parseRule(rule);

  // Tool name matching — support wildcards (e.g. "mcp__*__*")
  if (!globMatch(tool, toolName)) return false;

  if (filter === '*') return true;

  // "domain:example.com" filter for WebFetch
  if (filter.startsWith('domain:')) {
    const domain = filter.slice(7);
    const url = input.url || input.domain || '';
    try {
      const host = url.startsWith('http') ? new URL(url).hostname : url;
      return host === domain || host.endsWith('.' + domain);
    } catch {
      return url.includes(domain);
    }
  }

  // "sudo:*" filter for Bash deny rules
  if (filter.startsWith('sudo:')) {
    const cmd = input.command || '';
    return /(?:^|\s|&&|\|\||;)sudo(?:\s|$)/.test(cmd);
  }

  // Path glob filter — match against the primary value
  const value = extractToolValue(toolName, input);
  if (value) return globMatch(filter, value);

  return false;
}

// Load permission rules from ~/.claude/settings.json (and optionally project settings).
function loadPermissionRules(projectDir) {
  const rules = { allow: [], deny: [] };

  // Global settings
  const globalPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const raw = fs.readFileSync(globalPath, 'utf8');
    const settings = JSON.parse(raw);
    if (settings.permissions) {
      if (Array.isArray(settings.permissions.allow)) rules.allow.push(...settings.permissions.allow);
      if (Array.isArray(settings.permissions.deny)) rules.deny.push(...settings.permissions.deny);
    }
  } catch { /* missing or invalid — no rules */ }

  // Project-level settings (.claude/settings.json in the project dir)
  if (projectDir) {
    for (const name of ['settings.json', 'settings.local.json']) {
      const projPath = path.join(projectDir, '.claude', name);
      try {
        const raw = fs.readFileSync(projPath, 'utf8');
        const settings = JSON.parse(raw);
        if (settings.permissions) {
          if (Array.isArray(settings.permissions.allow)) rules.allow.push(...settings.permissions.allow);
          if (Array.isArray(settings.permissions.deny)) rules.deny.push(...settings.permissions.deny);
        }
      } catch { /* missing or invalid */ }
    }
  }

  return rules;
}

// Evaluate whether a tool invocation should be allowed, denied, or needs user input.
// Returns 'allow', 'deny', or 'ask'.
function evaluatePermission(toolName, input, rules) {
  // Deny rules take priority
  for (const rule of rules.deny) {
    if (ruleMatches(rule, toolName, input)) return 'deny';
  }
  // Check allow rules
  for (const rule of rules.allow) {
    if (ruleMatches(rule, toolName, input)) return 'allow';
  }
  return 'ask';
}

// Pending permission questions keyed by requestId: { resolve, question }
const pendingQuestions = {};

// Track running claude processes per session to prevent concurrent prompts
const runningProcesses = new Map();

// Per-session promise chains for serializing message file writes.
// Same pattern as `saveChain` for sessions, but keyed per session so
// different sessions can write in parallel while writes to the same
// session are serialized (preventing the read-modify-write race).
const messagesSaveChains = new Map();

const globalSseClients = new Set();

function broadcastGlobalEvent(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  console.log(`[claudecode-adapter] broadcast event: ${obj.type} (clients=${globalSseClients.size})`);
  for (const client of globalSseClients) {
    try {
      const ok = client.write(data);
      if (!ok) {
        // backpressure or half-closed — evict
        globalSseClients.delete(client);
      }
    } catch {
      globalSseClients.delete(client);
    }
  }
}

async function ensureDataDir() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
}

async function loadSessions() {
  try {
    const raw = await fs.promises.readFile(SESSIONS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[claudecode-adapter] Failed to parse sessions file, starting empty:', err.message);
    }
    return {};
  }
}

let saveChain = Promise.resolve();
function saveSessions() {
  saveChain = saveChain.then(() =>
    fs.promises.writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8')
  ).catch((err) => console.error('[claudecode-adapter] Failed to save sessions:', err.message));
  return saveChain;
}

function messagesFile(sessionId) {
  const safe = path.basename(sessionId);
  if (safe !== sessionId || !safe) throw new Error('Invalid session id');
  return path.join(DATA_DIR, `claudecode-messages-${safe}.json`);
}

async function loadMessages(sessionId) {
  try {
    const raw = await fs.promises.readFile(messagesFile(sessionId), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[claudecode-adapter] Failed to parse messages file:', err.message);
    }
    return [];
  }
}

async function saveMessages(sessionId, msgs) {
  await fs.promises.writeFile(messagesFile(sessionId), JSON.stringify(msgs, null, 2), 'utf8');
}

// Serialize a read-modify-write append to the messages file for a given session.
// Returns the full messages array after the append (useful for getting the count).
function chainedAppendMessage(sessionId, msg) {
  const prev = messagesSaveChains.get(sessionId) || Promise.resolve();
  const next = prev.then(async () => {
    const msgs = await loadMessages(sessionId);
    msgs.push(msg);
    await saveMessages(sessionId, msgs);
    return msgs;
  }).catch((err) => {
    console.error('[claudecode-adapter] Failed to persist message:', err.message);
    return null;
  });
  messagesSaveChains.set(sessionId, next);
  return next;
}

// Convert internal session to the SDK Session shape the UI expects.
function toSdkSession(session) {
  const createdMs = session.createdAt ? new Date(session.createdAt).getTime() : Date.now();
  const updatedMs = session.updatedAt ? new Date(session.updatedAt).getTime() : createdMs;
  return {
    id: session.id,
    slug: session.id,
    projectID: 'default',
    directory: session.directory || session.path || _cwd,
    title: session.title || 'New Session',
    version: '1',
    time: { created: createdMs, updated: updatedMs },
    messageCount: session.messageCount || 0,
    claudeSessionId: session.claudeSessionId || null,
  };
}

// Convert stored message to the { info, parts } shape the client expects.
function toSdkMessage(msg, sessionId) {
  const createdMs = msg.createdAt ? new Date(msg.createdAt).getTime() : Date.now();
  const savedParts = Array.isArray(msg.parts) ? msg.parts : [];
  const textPart = msg.content
    ? [{ id: `${msg.id}-p0`, type: 'text', text: msg.content, messageID: msg.id, sessionID: sessionId }]
    : [];
  return {
    info: {
      id: msg.id,
      sessionID: sessionId,
      role: msg.role,
      time: { created: createdMs, updated: createdMs },
      status: 'completed',
      ...(msg.role === 'assistant' ? { finish: 'stop' } : {}),
    },
    parts: [...savedParts, ...textPart],
  };
}

function createApp(cwd) {
  const app = express();
  app.use(express.json());

  // GET /health
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // POST /session
  app.post('/session', async (req, res) => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const title = (req.body && req.body.title) || 'New Session';
    const directory = (req.body && req.body.directory) || req.query.directory || req.get('x-opencode-directory') || cwd;
    console.log(`[claudecode-adapter] POST /session: directory=${directory} (body=${req.body?.directory}, query=${req.query.directory}, header=${req.get('x-opencode-directory')}, fallback=${cwd})`);
    const session = {
      id,
      title,
      directory,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      claudeSessionId: null, // set after first successful claude run
      agent: null,
    };
    sessions[id] = session;
    try {
      await saveSessions();
    } catch {
      // non-fatal
    }
    const sdk = toSdkSession(session);
    broadcastGlobalEvent({ type: 'session.updated', properties: { info: sdk } });
    res.status(201).json(sdk);
  });

  // GET /session
  app.get('/session', (_req, res) => {
    const list = Object.values(sessions)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .map(toSdkSession);
    res.json(list);
  });

  // GET /session/:id
  app.get('/session/:id', (req, res) => {
    const { id } = req.params;
    if (!Object.hasOwn(sessions, id)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(toSdkSession(sessions[id]));
  });

  // DELETE /session/:id
  app.delete('/session/:id', async (req, res) => {
    const { id } = req.params;
    if (!Object.hasOwn(sessions, id)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    delete sessions[id];
    try {
      await saveSessions();
    } catch {
      // non-fatal
    }
    // Clean up messages file
    try {
      await fs.promises.unlink(messagesFile(id));
    } catch {
      // file may not exist, ignore
    }
    broadcastGlobalEvent({ type: 'session.deleted', properties: { sessionID: id } });
    res.status(204).end();
  });

  // GET /session/:id/message
  app.get('/session/:id/message', async (req, res) => {
    const { id } = req.params;
    if (!Object.hasOwn(sessions, id)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const messages = await loadMessages(id);
    res.json(messages.map(msg => toSdkMessage(msg, id)));
  });

  // POST /session/:id/prompt_async — fire-and-forget; events delivered via SSE
  app.post('/session/:id/prompt_async', async (req, res) => {
    const { id } = req.params;

    // Auto-create session entry when the adapter receives a prompt for an
    // unknown session ID (e.g. routed from an OpenCode-managed session).
    if (!Object.hasOwn(sessions, id)) {
      const now = new Date().toISOString();
      const directory = req.query.directory || req.get('x-opencode-directory') || cwd;
      sessions[id] = {
        id,
        title: 'New Session',
        directory,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        claudeSessionId: null,
        agent: null,
      };
      saveSessions().catch(() => {});
    }

    // Extract text from parts array (OpenCode API format)
    const body = req.body || {};

    // Capture agent from the request body (sent by the UI)
    if (body.agent && typeof body.agent === 'string') {
      sessions[id].agent = body.agent;
    }
    console.log(`[claudecode-adapter] prompt_async received for session=${id}, body keys=${Object.keys(body).join(',')}`);
    const parts = Array.isArray(body.parts) ? body.parts : [];
    const textPart = parts.find(p => p && p.type === 'text');
    const content = (typeof textPart?.text === 'string') ? textPart.text.trim() : '';
    if (!content) {
      console.log(`[claudecode-adapter] prompt_async rejected: no text part found. parts=${JSON.stringify(parts).slice(0, 200)}`);
      return res.status(400).json({ error: 'Message must contain a text part' });
    }
    console.log(`[claudecode-adapter] prompt_async content="${content.slice(0, 80)}..."`);

    // Generate stable IDs for this exchange
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const assistantPartId = crypto.randomUUID();

    // Return immediately — the UI will receive events via the SSE stream
    res.status(200).json({ id: userMessageId });

    // Everything below runs asynchronously after the response is sent
    ;(async () => {
      // Update session title from first message
      if (Object.hasOwn(sessions, id) && sessions[id].title === 'New Session') {
        sessions[id].title = content.slice(0, 60).replace(/\n/g, ' ');
        await saveSessions();
      }

      // Persist user message and emit it
      await chainedAppendMessage(id, { id: userMessageId, role: 'user', content, createdAt: new Date().toISOString() });

      const userCreatedAt = Date.now();
      broadcastGlobalEvent({
        type: 'message.updated',
        properties: {
          info: {
            id: userMessageId,
            sessionID: id,
            role: 'user',
            status: 'completed',
            time: { created: userCreatedAt, updated: userCreatedAt },
            parts: [{ id: `${userMessageId}-p0`, type: 'text', text: content, messageID: userMessageId, sessionID: id }],
          }
        }
      });

      // Mark session busy
      broadcastGlobalEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });

      // runClaude spawns the claude process and returns a promise that resolves with
      // { code, assistantText, usedResume } so the caller can decide whether to retry.
      function runClaude({ useResume }) {
        return new Promise((resolveRun) => {
          // Kill any existing running process for this session to prevent
          // concurrent prompts racing against each other.
          const existing = runningProcesses.get(id);
          if (existing && !existing.killed) {
            try { existing.stdin.end(); } catch { /* already closed */ }
            existing.kill('SIGTERM');
          }

          const sessionData = Object.hasOwn(sessions, id) ? sessions[id] : null;
          const sessionCwd = (sessionData && sessionData.directory) || _cwd;
          const claudeSessionId = useResume && sessionData ? sessionData.claudeSessionId : null;
          const sessionAgent = sessionData ? sessionData.agent : null;
          const args = [
            '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
            '--permission-mode', _permissionMode,
            '--permission-prompt-tool', 'stdio',
            ...(sessionAgent ? ['--agent', sessionAgent] : []),
            ...(claudeSessionId ? ['--resume', claudeSessionId] : []),
          ];
          // Strip Claude Code's own env vars so nested sessions aren't blocked
          const { CLAUDECODE: _cc, CLAUDE_CODE_ENTRYPOINT: _cce, ...spawnEnv } = process.env;
          console.log(`[claudecode-adapter] spawning: ${_claudeBinary} ${args.join(' ')}`);
          console.log(`[claudecode-adapter] spawn cwd=${sessionCwd}, permissionMode=${_permissionMode}`);
          const claudeProc = spawn(_claudeBinary, args, {
            cwd: sessionCwd,
            env: spawnEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          console.log(`[claudecode-adapter] spawn pid=${claudeProc.pid}`);

          // Track this process so concurrent prompts can kill it
          runningProcesses.set(id, claudeProc);

          // Write the user prompt as a stream-json message and keep stdin open.
          claudeProc.stdin.on('error', (err) => {
            console.error(`[claudecode-adapter] stdin error: ${err.message}`);
          });
          const userMsg = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
          console.log(`[claudecode-adapter] writing to stdin: ${userMsg.slice(0, 120)}...`);
          claudeProc.stdin.write(userMsg, 'utf8');

          let stdoutBuf = '';
          let stderrBuf = '';
          let assistantText = '';
          const allParts = [];       // track all emitted parts for the final message.updated
          let blockIndex = 0;        // monotonic counter for stable part IDs
          const seenToolIds = new Map(); // claude tool_use block.id → our part ID

          let timeoutHandle = null;
          let timeoutPaused = false;

          function startTimeout() {
            clearTimeout(timeoutHandle);
            if (timeoutPaused) return;
            timeoutHandle = setTimeout(() => {
              if (!claudeProc.killed) {
                console.log(`[claudecode-adapter] session ${id} timed out after ${TIMEOUT_MS / 1000}s of inactivity`);
                try { claudeProc.stdin.end(); } catch { /* already closed */ }
                claudeProc.kill('SIGTERM');
              }
            }, TIMEOUT_MS);
          }

          // Reset the inactivity timeout on activity (stdout data, permission response).
          function resetTimeout() {
            timeoutPaused = false;
            startTimeout();
          }

          // Pause the timeout while waiting for user input (permission prompts).
          function pauseTimeout() {
            timeoutPaused = true;
            clearTimeout(timeoutHandle);
          }

          startTimeout();

          const processLine = (line) => {
            if (!line.trim()) return;
            let parsed;
            try { parsed = JSON.parse(line); } catch {
              console.log(`[claudecode-adapter] non-JSON stdout: ${line.slice(0, 200)}`);
              return;
            }

            console.log(`[claudecode-adapter] stdout event: type=${parsed.type}${parsed.type === 'control_request' ? ` tool=${parsed.request?.tool_name}` : ''}`);

            if (parsed.type === 'result') {
              // Claude has finished — close stdin so the process can exit cleanly.
              try { claudeProc.stdin.end(); } catch { /* already closed */ }

              if (parsed.session_id && Object.hasOwn(sessions, id)) {
                // Capture (or update) the real claude session ID so subsequent
                // turns can use --resume to continue the same conversation.
                sessions[id].claudeSessionId = parsed.session_id;
                saveSessions().catch(() => {});
              }
            }

            // Handle control_request events from --permission-prompt-tool stdio.
            if (parsed.type === 'control_request') {
              const requestId = parsed.request_id;
              const req = parsed.request || {};
              const toolName = req.tool_name || 'unknown';
              const toolInput = req.input || {};

              // AskUserQuestion: forward Claude's questions directly to the UI
              if (toolName === 'AskUserQuestion' && Array.isArray(toolInput.questions)) {
                const question = {
                  id: requestId,
                  sessionID: id,
                  questions: toolInput.questions,
                };

                pendingQuestions[requestId] = {
                  question,
                  resolve: ({ answers }) => {
                    resetTimeout();
                    const response = JSON.stringify({
                      type: 'control_response',
                      response: {
                        request_id: requestId,
                        subtype: 'success',
                        response: {
                          behavior: 'allow',
                          updatedInput: { ...toolInput, answers: answers || {} },
                        },
                      },
                    }) + '\n';
                    claudeProc.stdin.write(response, 'utf8');
                  },
                };

                pauseTimeout();
                broadcastGlobalEvent({ type: 'question.asked', properties: question });
                return;
              }

              // Check permission rules from ~/.claude/settings.json before prompting.
              const permRules = loadPermissionRules(sessionCwd);
              const decision = evaluatePermission(toolName, toolInput, permRules);

              if (decision === 'allow') {
                console.log(`[claudecode-adapter] auto-allow ${toolName} (matched settings.json rule)`);
                const autoResponse = JSON.stringify({
                  type: 'control_response',
                  response: {
                    request_id: requestId,
                    subtype: 'success',
                    response: { behavior: 'allow', updatedInput: toolInput },
                  },
                }) + '\n';
                claudeProc.stdin.write(autoResponse, 'utf8');
                return;
              }

              if (decision === 'deny') {
                console.log(`[claudecode-adapter] auto-deny ${toolName} (matched settings.json deny rule)`);
                const denyResponse = JSON.stringify({
                  type: 'control_response',
                  response: {
                    request_id: requestId,
                    subtype: 'success',
                    response: { behavior: 'deny', message: 'Denied by settings.json rule' },
                  },
                }) + '\n';
                claudeProc.stdin.write(denyResponse, 'utf8');
                return;
              }

              // No rule matched — prompt the user
              const inputSummary = typeof toolInput === 'object'
                ? (toolInput.command || toolInput.path || JSON.stringify(toolInput).slice(0, 80))
                : String(toolInput).slice(0, 80);

              const question = {
                id: requestId,
                sessionID: id,
                questions: [{
                  question: `Allow ${toolName}?`,
                  header: toolName,
                  options: [
                    { label: 'Yes', description: `Allow ${toolName}: ${inputSummary}` },
                    { label: 'No', description: 'Deny this operation' },
                  ],
                }],
              };

              pendingQuestions[requestId] = {
                question,
                resolve: ({ allow }) => {
                  resetTimeout();
                  const response = JSON.stringify({
                    type: 'control_response',
                    response: {
                      request_id: requestId,
                      subtype: 'success',
                      response: allow
                        ? { behavior: 'allow', updatedInput: toolInput }
                        : { behavior: 'deny', message: 'User denied permission' },
                    },
                  }) + '\n';
                  claudeProc.stdin.write(response, 'utf8');
                },
              };

              pauseTimeout();
              broadcastGlobalEvent({ type: 'question.asked', properties: question });
              return;
            }

            if (parsed.type === 'assistant' && parsed.message && Array.isArray(parsed.message.content)) {
              for (const block of parsed.message.content) {
                if (block.type === 'text' && typeof block.text === 'string') {
                  assistantText += block.text;
                } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
                  const partId = `${assistantMessageId}-r${blockIndex++}`;
                  const reasoningPart = {
                    id: partId,
                    type: 'reasoning',
                    text: block.thinking,
                    messageID: assistantMessageId,
                    sessionID: id,
                    time: { start: Date.now() },
                  };
                  allParts.push(reasoningPart);
                  broadcastGlobalEvent({
                    type: 'message.part.updated',
                    properties: {
                      part: reasoningPart,
                      info: { id: assistantMessageId, sessionID: id, role: 'assistant' }
                    }
                  });
                } else if (block.type === 'tool_use') {
                  const partId = `${assistantMessageId}-t${blockIndex++}`;
                  if (block.id) seenToolIds.set(block.id, partId);
                  const toolPart = {
                    id: partId,
                    type: 'tool',
                    tool: block.name || 'unknown',
                    state: {
                      status: 'running',
                      input: block.input || {},
                      time: { start: Date.now() },
                    },
                    messageID: assistantMessageId,
                    sessionID: id,
                  };
                  allParts.push(toolPart);
                  broadcastGlobalEvent({
                    type: 'message.part.updated',
                    properties: {
                      part: toolPart,
                      info: { id: assistantMessageId, sessionID: id, role: 'assistant' }
                    }
                  });
                } else if (block.type === 'tool_result' && block.tool_use_id) {
                  // Update the matching tool part with results
                  const toolPartId = seenToolIds.get(block.tool_use_id);
                  if (toolPartId) {
                    const existing = allParts.find(p => p.id === toolPartId);
                    if (existing && existing.state) {
                      const output = Array.isArray(block.content)
                        ? block.content.map(c => c.text || '').join('\n')
                        : (typeof block.content === 'string' ? block.content : '');
                      existing.state.status = block.is_error ? 'error' : 'completed';
                      existing.state.output = output;
                      existing.state.time.end = Date.now();
                      broadcastGlobalEvent({
                        type: 'message.part.updated',
                        properties: {
                          part: existing,
                          info: { id: assistantMessageId, sessionID: id, role: 'assistant' }
                        }
                      });
                    }
                  }
                }
              }

              // Always broadcast text part (even if empty, to keep the stall detector happy)
              const textPart = {
                id: assistantPartId,
                type: 'text',
                text: assistantText,
                messageID: assistantMessageId,
                sessionID: id,
              };
              broadcastGlobalEvent({
                type: 'message.part.updated',
                properties: {
                  part: textPart,
                  info: { id: assistantMessageId, sessionID: id, role: 'assistant' }
                }
              });
            }
          };

          claudeProc.stdout.on('data', (chunk) => {
            resetTimeout();
            stdoutBuf += chunk.toString('utf8');
            const lines = stdoutBuf.split('\n');
            stdoutBuf = lines.pop() ?? '';
            for (const line of lines) processLine(line);
          });

          claudeProc.stderr.on('data', (chunk) => {
            const text = chunk.toString('utf8');
            console.log(`[claudecode-adapter] stderr: ${text.slice(0, 300)}`);
            if (stderrBuf.length < STDERR_MAX) stderrBuf += text;
          });

          claudeProc.on('error', (err) => {
            clearTimeout(timeoutHandle);
            if (runningProcesses.get(id) === claudeProc) {
              runningProcesses.delete(id);
            }
            console.error('[claudecode-adapter] Claude process error:', err.message);
            resolveRun({ code: 1, assistantText: '', allParts: [], usedResume: !!claudeSessionId, stderr: err.message });
          });

          claudeProc.on('close', (code) => {
            console.log(`[claudecode-adapter] process closed with code=${code}, assistantText.length=${assistantText.length}`);
            clearTimeout(timeoutHandle);
            // Remove from running processes tracking
            if (runningProcesses.get(id) === claudeProc) {
              runningProcesses.delete(id);
            }
            if (stdoutBuf.trim()) processLine(stdoutBuf.trim());
            // Clean up any pending questions for this session
            for (const [reqId, entry] of Object.entries(pendingQuestions)) {
              if (entry.question.sessionID === id) {
                delete pendingQuestions[reqId];
              }
            }
            resolveRun({ code, assistantText, allParts, usedResume: !!claudeSessionId, stderr: stderrBuf });
          });
        });
      }

      // Run claude, retrying without --resume if resume fails
      console.log(`[claudecode-adapter] running claude (useResume=true) for session=${id}`);
      let result = await runClaude({ useResume: true });

      console.log(`[claudecode-adapter] runClaude result: code=${result.code}, assistantText.length=${result.assistantText.length}, usedResume=${result.usedResume}, stderr=${result.stderr?.slice(0, 200)}`);

      if (result.code !== 0 && !result.assistantText && result.usedResume) {
        // --resume failed — clear stale session ID and retry with a fresh conversation
        console.error('[claudecode-adapter] --resume failed, retrying without --resume');
        if (Object.hasOwn(sessions, id)) {
          sessions[id].claudeSessionId = null;
          saveSessions().catch(() => {});
        }
        result = await runClaude({ useResume: false });
      }

      console.error(`[claudecode-adapter] Claude closed with code ${result.code}, assistantText.length=${result.assistantText.length}`);

      if (result.code !== 0 && !result.assistantText) {
        const errDetail = result.stderr.trim() || `Claude exited with code ${result.code}`;
        console.error('[claudecode-adapter] Claude failed:', errDetail);

        // Emit an error message to the SSE stream so the user sees what went wrong
        const errorText = `Error: ${errDetail}`;
        const errorCompletedAt = Date.now();
        broadcastGlobalEvent({
          type: 'message.updated',
          properties: {
            info: {
              id: assistantMessageId,
              sessionID: id,
              role: 'assistant',
              status: 'completed',
              finish: 'error',
              time: { created: errorCompletedAt, updated: errorCompletedAt, completed: errorCompletedAt },
              parts: [{ id: assistantPartId, type: 'text', text: errorText, messageID: assistantMessageId, sessionID: id }],
            }
          }
        });

        broadcastGlobalEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'idle' } } });
        return;
      }

      // Persist complete assistant message
      try {
        const msgs = await chainedAppendMessage(id, { id: assistantMessageId, role: 'assistant', content: result.assistantText, parts: result.allParts || [], createdAt: new Date().toISOString() });
        if (msgs && Object.hasOwn(sessions, id)) {
          sessions[id].updatedAt = new Date().toISOString();
          sessions[id].messageCount = msgs.length;
          await saveSessions();
        }
      } catch (err) {
        console.error('[claudecode-adapter] Failed to persist assistant message:', err.message);
      }

      // Emit final message.updated with all parts (reasoning, tools, text)
      const assistantCompletedAt = Date.now();
      const finalParts = [
        ...(result.allParts || []),
        { id: assistantPartId, type: 'text', text: result.assistantText, messageID: assistantMessageId, sessionID: id },
      ];
      broadcastGlobalEvent({
        type: 'message.updated',
        properties: {
          info: {
            id: assistantMessageId,
            sessionID: id,
            role: 'assistant',
            status: 'completed',
            finish: 'stop',
            time: { created: assistantCompletedAt, updated: assistantCompletedAt, completed: assistantCompletedAt },
            parts: finalParts,
          }
        }
      });

      broadcastGlobalEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'idle' } } });
      if (Object.hasOwn(sessions, id)) {
        broadcastGlobalEvent({ type: 'session.updated', properties: { info: toSdkSession(sessions[id]) } });
      }
    })().catch((err) => {
      console.error('[claudecode-adapter] Unhandled error in prompt_async handler:', err.message);
      broadcastGlobalEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'idle' } } });
    });
  });

  // Global SSE event streams
  app.get(['/event', '/global/event'], (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write('data: {"type":"connected"}\n\n');

    globalSseClients.add(res);
    console.log(`[claudecode-adapter] SSE client connected (total=${globalSseClients.size})`);

    req.on('close', () => {
      globalSseClients.delete(res);
      console.log(`[claudecode-adapter] SSE client disconnected (total=${globalSseClients.size})`);
    });
  });

  // Config stubs
  app.get('/config/settings', (_req, res) => {
    res.json({ theme: null, autoshare: false, keybinds: {}, defaultModel: 'claude/default' });
  });
  app.get('/config/providers', (_req, res) => {
    // Return a stub provider so the UI can auto-select a model and allow message submission.
    // Claude Code manages its own model selection; the specific model ID is ignored by the adapter.
    res.json({
      providers: [{
        id: 'claude',
        name: 'Claude Code',
        models: {
          default: { id: 'default', name: 'Default (Claude Code)' },
        },
      }],
      default: {},
    });
  });
  app.get('/config/agents', (_req, res) => {
    // Return a hidden stub agent so the UI's loadAgents() doesn't early-return before
    // applying model selection from settings (safeAgents.length === 0 causes an early return
    // that skips the defaultModel logic in bootstrapConfiguration).
    res.json([{
      name: 'build',
      mode: 'primary',
      hidden: true,
      model: { providerID: 'claude', modelID: 'default' },
    }]);
  });
  app.get('/config/commands', (_req, res) => {
    res.json([]);
  });
  app.get('/config/skills', (_req, res) => {
    res.json([]);
  });
  app.post('/config/reload', (_req, res) => {
    res.json({ ok: true });
  });

  // Stubs for UI polling endpoints
  app.get('/session/status', (_req, res) => {
    res.json({ sessions: {} });
  });
  app.get('/session/:id/todo', (_req, res) => {
    res.json([]);
  });
  app.get('/question', (_req, res) => {
    // Return any questions that are still pending (not yet answered)
    const pending = Object.values(pendingQuestions).map(q => q.question);
    res.json(pending);
  });
  app.post('/question/reply', (req, res) => {
    const { requestID, answers } = req.body || {};
    console.log(`[claudecode-adapter] question/reply: requestID=${requestID}, pending=${Object.keys(pendingQuestions).join(',')}`);
    if (!requestID || !Object.hasOwn(pendingQuestions, requestID)) {
      return res.status(404).json({ error: 'Question not found' });
    }
    const entry = pendingQuestions[requestID];
    delete pendingQuestions[requestID];
    console.log(`[claudecode-adapter] resolving question ${requestID} with allow=true`);
    entry.resolve({ allow: true, answers });
    const { sessionID } = entry.question;
    broadcastGlobalEvent({ type: 'question.replied', properties: { sessionID, requestID } });
    res.json(true);
  });
  app.post('/question/reject', (req, res) => {
    const { requestID } = req.body || {};
    console.log(`[claudecode-adapter] question/reject: requestID=${requestID}, pending=${Object.keys(pendingQuestions).join(',')}`);
    if (!requestID || !Object.hasOwn(pendingQuestions, requestID)) {
      return res.status(404).json({ error: 'Question not found' });
    }
    const entry = pendingQuestions[requestID];
    delete pendingQuestions[requestID];
    console.log(`[claudecode-adapter] resolving question ${requestID} with allow=false`);
    entry.resolve({ allow: false });
    const { sessionID } = entry.question;
    broadcastGlobalEvent({ type: 'question.rejected', properties: { sessionID, requestID } });
    res.json(true);
  });
  app.get('/permission', (_req, res) => {
    res.json([]);
  });

  // Filesystem / git / terminal stubs
  const notImplemented = (_req, res) => {
    res.status(501).json({ error: 'Not implemented for Claude Code backend' });
  };
  app.get('/fs/*path', notImplemented);
  app.get('/git/*path', notImplemented);
  app.get('/terminal/*path', notImplemented);
  app.post('/terminal/*path', notImplemented);

  // Unknown routes
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}

export async function startClaudeCodeAdapter({ port = 0, claudeBinary, cwd, permissionMode } = {}) {
  console.log(`[claudecode-adapter] starting: binary=${claudeBinary}, cwd=${cwd}, permissionMode=${permissionMode}`);
  if (claudeBinary) {
    _claudeBinary = claudeBinary;
  }
  if (cwd) {
    _cwd = cwd;
  }
  _permissionMode = permissionMode || 'default';

  await ensureDataDir();

  sessions = await loadSessions();

  const app = createApp(cwd || process.cwd());
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr) throw new Error('[claudecode-adapter] Server failed to bind');
  const boundPort = addr.port;
  _port = boundPort;

  function stop() {
    return new Promise((resolve, reject) => {
      // Close all SSE/keep-alive connections so shutdown completes promptly
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      server.close((err) => {
        if (err) return reject(err);
        _port = null;
        resolve();
      });
    });
  }

  return { port: boundPort, stop };
}

export function getAdapterPort() {
  return _port;
}

export function setPermissionMode(mode) {
  if (mode === 'default' || mode === 'acceptEdits' || mode === 'bypassPermissions') {
    _permissionMode = mode;
  }
}
