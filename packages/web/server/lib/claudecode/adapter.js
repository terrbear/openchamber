import express from 'express';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

const DATA_DIR = path.join(os.homedir(), '.local', 'share', 'openchamber');
const SESSIONS_FILE = path.join(DATA_DIR, 'claudecode-sessions.json');

const TIMEOUT_MS = 5 * 60 * 1000;
const STDERR_MAX = 64 * 1024; // 64KB

let _port = null;
let sessions = {};
let _claudeBinary = 'claude';
let _cwd = process.cwd();
let _permissionMode = 'acceptEdits';

// Pending permission questions keyed by requestId: { resolve, question }
const pendingQuestions = {};

const globalSseClients = new Set();

function broadcastGlobalEvent(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
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
  return {
    info: {
      id: msg.id,
      sessionID: sessionId,
      role: msg.role,
      time: { created: createdMs, updated: createdMs },
      status: 'completed',
      ...(msg.role === 'assistant' ? { finish: 'stop' } : {}),
    },
    parts: msg.content
      ? [{ id: `${msg.id}-p0`, type: 'text', text: msg.content, messageID: msg.id, sessionID: sessionId }]
      : [],
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
    const session = {
      id,
      title,
      directory: cwd,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      claudeSessionId: null, // set after first successful claude run
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
      sessions[id] = {
        id,
        title: 'New Session',
        directory: cwd,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        claudeSessionId: null,
      };
      saveSessions().catch(() => {});
    }

    // Extract text from parts array (OpenCode API format)
    const body = req.body || {};
    const parts = Array.isArray(body.parts) ? body.parts : [];
    const textPart = parts.find(p => p && p.type === 'text');
    const content = (typeof textPart?.text === 'string') ? textPart.text.trim() : '';
    if (!content) {
      return res.status(400).json({ error: 'Message must contain a text part' });
    }

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
      const existingMessages = await loadMessages(id);
      existingMessages.push({ id: userMessageId, role: 'user', content, createdAt: new Date().toISOString() });
      await saveMessages(id, existingMessages);

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
          const sessionCwd = (Object.hasOwn(sessions, id) && sessions[id].directory) || _cwd;
          const claudeSessionId = useResume && Object.hasOwn(sessions, id) ? sessions[id].claudeSessionId : null;
          const args = [
            '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
            '--permission-mode', _permissionMode,
            '--permission-prompt-tool', 'stdio',
            ...(claudeSessionId ? ['--resume', claudeSessionId] : []),
          ];
          // Strip Claude Code's own env vars so nested sessions aren't blocked
          const { CLAUDECODE: _cc, CLAUDE_CODE_ENTRYPOINT: _cce, ...spawnEnv } = process.env;
          const claudeProc = spawn(_claudeBinary, args, {
            cwd: sessionCwd,
            env: spawnEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          // Write the user prompt as a stream-json message and keep stdin open.
          claudeProc.stdin.on('error', () => {});
          const userMsg = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
          claudeProc.stdin.write(userMsg, 'utf8');

          let stdoutBuf = '';
          let stderrBuf = '';
          let assistantText = '';

          const timeoutHandle = setTimeout(() => {
            if (!claudeProc.killed) claudeProc.kill('SIGTERM');
          }, TIMEOUT_MS);

          const processLine = (line) => {
            if (!line.trim()) return;
            let parsed;
            try { parsed = JSON.parse(line); } catch { return; }

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

                broadcastGlobalEvent({ type: 'question.asked', properties: question });
                return;
              }

              // Other tool permissions (Bash, Edit, etc.): show Yes/No
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

              broadcastGlobalEvent({ type: 'question.asked', properties: question });
              return;
            }

            if (parsed.type === 'assistant' && parsed.message && Array.isArray(parsed.message.content)) {
              for (const block of parsed.message.content) {
                if (block.type === 'text' && typeof block.text === 'string') {
                  assistantText += block.text;
                }
              }
              broadcastGlobalEvent({
                type: 'message.part.updated',
                properties: {
                  part: {
                    id: assistantPartId,
                    type: 'text',
                    text: assistantText,
                    messageID: assistantMessageId,
                    sessionID: id,
                  },
                  info: { id: assistantMessageId, sessionID: id, role: 'assistant' }
                }
              });
            }
          };

          claudeProc.stdout.on('data', (chunk) => {
            stdoutBuf += chunk.toString('utf8');
            const lines = stdoutBuf.split('\n');
            stdoutBuf = lines.pop() ?? '';
            for (const line of lines) processLine(line);
          });

          claudeProc.stderr.on('data', (chunk) => {
            if (stderrBuf.length < STDERR_MAX) stderrBuf += chunk.toString('utf8');
          });

          claudeProc.on('error', (err) => {
            clearTimeout(timeoutHandle);
            console.error('[claudecode-adapter] Claude process error:', err.message);
            resolveRun({ code: 1, assistantText: '', usedResume: !!claudeSessionId, stderr: err.message });
          });

          claudeProc.on('close', (code) => {
            clearTimeout(timeoutHandle);
            if (stdoutBuf.trim()) processLine(stdoutBuf.trim());
            // Clean up any pending questions for this session
            for (const [reqId, entry] of Object.entries(pendingQuestions)) {
              if (entry.question.sessionID === id) {
                delete pendingQuestions[reqId];
              }
            }
            resolveRun({ code, assistantText, usedResume: !!claudeSessionId, stderr: stderrBuf });
          });
        });
      }

      // Run claude, retrying without --resume if resume fails
      let result = await runClaude({ useResume: true });

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
        broadcastGlobalEvent({ type: 'session.status', properties: { sessionID: id, status: { type: 'idle' } } });
        return;
      }

      // Persist complete assistant message
      try {
        const msgs = await loadMessages(id);
        msgs.push({ id: assistantMessageId, role: 'assistant', content: result.assistantText, createdAt: new Date().toISOString() });
        await saveMessages(id, msgs);
        if (Object.hasOwn(sessions, id)) {
          sessions[id].updatedAt = new Date().toISOString();
          sessions[id].messageCount = msgs.length;
          await saveSessions();
        }
      } catch (err) {
        console.error('[claudecode-adapter] Failed to persist assistant message:', err.message);
      }

      // Emit final message.updated with complete content
      const assistantCompletedAt = Date.now();
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
            parts: [{ id: assistantPartId, type: 'text', text: result.assistantText, messageID: assistantMessageId, sessionID: id }],
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

    req.on('close', () => {
      globalSseClients.delete(res);
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
    if (!requestID || !Object.hasOwn(pendingQuestions, requestID)) {
      return res.status(404).json({ error: 'Question not found' });
    }
    const entry = pendingQuestions[requestID];
    delete pendingQuestions[requestID];
    entry.resolve({ allow: true, answers });
    const { sessionID } = entry.question;
    broadcastGlobalEvent({ type: 'question.replied', properties: { sessionID, requestID } });
    res.json(true);
  });
  app.post('/question/reject', (req, res) => {
    const { requestID } = req.body || {};
    if (!requestID || !Object.hasOwn(pendingQuestions, requestID)) {
      return res.status(404).json({ error: 'Question not found' });
    }
    const entry = pendingQuestions[requestID];
    delete pendingQuestions[requestID];
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
  if (claudeBinary) {
    _claudeBinary = claudeBinary;
  }
  if (cwd) {
    _cwd = cwd;
  }
  _permissionMode = permissionMode || 'acceptEdits';

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
