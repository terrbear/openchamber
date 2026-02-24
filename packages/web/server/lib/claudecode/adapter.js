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
      path: cwd,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
    sessions[id] = session;
    try {
      await saveSessions();
    } catch {
      // non-fatal
    }
    broadcastGlobalEvent({ type: 'session.updated', properties: { sessionID: session.id } });
    res.status(201).json(session);
  });

  // GET /session
  app.get('/session', (_req, res) => {
    const list = Object.values(sessions).sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
    );
    res.json(list);
  });

  // GET /session/:id
  app.get('/session/:id', (req, res) => {
    const { id } = req.params;
    if (!Object.hasOwn(sessions, id)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(sessions[id]);
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
    res.json(messages);
  });

  // POST /session/:id/message — streaming via claude --output-format=stream-json
  app.post('/session/:id/message', async (req, res) => {
    const { id } = req.params;
    if (!Object.hasOwn(sessions, id)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const body = req.body || {};
    const content = typeof body.content === 'string' ? body.content : '';
    if (!content.trim()) {
      return res.status(400).json({ error: 'content is required' });
    }

    // Update session title from first message if still default
    if (sessions[id].title === 'New Session') {
      sessions[id].title = content.slice(0, 60) + (content.length > 60 ? '…' : '');
    }

    // Persist user message
    const userMsgId = crypto.randomUUID();
    const userMessage = {
      id: userMsgId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    const existingMessages = await loadMessages(id);
    existingMessages.push(userMessage);

    const saveMessages = (msgs) =>
      fs.promises.writeFile(
        messagesFile(id),
        JSON.stringify(msgs, null, 2),
        'utf8'
      );

    try {
      await saveMessages(existingMessages);
    } catch (err) {
      console.error('[claudecode-adapter] Failed to persist user message:', err.message);
    }

    // SSE response headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const emitSse = (obj) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      }
    };

    // Emit session busy status
    emitSse({ type: 'session.status', properties: { sessionID: id, status: 'busy' } });

    // Spawn claude subprocess
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--resume', id,
      '--permission-mode', _permissionMode,
    ];
    const claudeProc = spawn(_claudeBinary, args, {
      cwd: sessions[id].path || _cwd,
      env: process.env,
    });

    // Write user message text to stdin then close it
    claudeProc.stdin.write(content, 'utf8');
    claudeProc.stdin.end();
    claudeProc.stdin.on('error', () => {
      // stdin errors are handled via the process 'error' or 'close' event
    });

    // Handle client disconnect
    const onClose = () => {
      if (!claudeProc.killed) {
        claudeProc.kill();
      }
    };
    res.on('close', onClose);

    let stdoutBuf = '';
    const assistantParts = [];
    let assistantMsgId = crypto.randomUUID();

    // 5-minute timeout watchdog
    const timeoutHandle = setTimeout(() => {
      if (!claudeProc.killed) {
        claudeProc.kill('SIGTERM');
      }
      emitSse({ type: 'session.status', properties: { sessionID: id, status: 'idle', error: 'Claude Code process timed out' } });
      if (!res.writableEnded) res.end();
    }, TIMEOUT_MS);

    claudeProc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          // not JSON, skip
          continue;
        }

        if (!event || typeof event.type !== 'string') continue;

        if (event.type === 'text' && typeof event.text === 'string') {
          const part = {
            id: crypto.randomUUID(),
            type: 'text',
            text: event.text,
            sessionID: id,
            messageID: assistantMsgId,
          };
          assistantParts.push(part);

          emitSse({
            type: 'message.part.updated',
            properties: {
              sessionID: id,
              messageID: assistantMsgId,
              info: { id: assistantMsgId, sessionID: id, role: 'assistant' },
              part,
            },
          });
        } else if (event.type === 'tool_use') {
          const part = {
            id: event.id || crypto.randomUUID(),
            type: 'tool',
            tool: event.name,
            input: event.input || {},
            sessionID: id,
            messageID: assistantMsgId,
            state: { status: 'running' },
          };
          assistantParts.push(part);

          emitSse({
            type: 'message.part.updated',
            properties: {
              sessionID: id,
              messageID: assistantMsgId,
              info: { id: assistantMsgId, sessionID: id, role: 'assistant' },
              part,
            },
          });
        } else if (event.type === 'result' && event.subtype === 'success') {
          // Persist assistant message
          const fullText = assistantParts
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('');

          const assistantText = fullText;

          const assistantMessage = {
            id: assistantMsgId,
            role: 'assistant',
            content: assistantText,
            parts: assistantParts,
            createdAt: new Date().toISOString(),
            cost_usd: event.total_cost_usd,
            duration_ms: event.duration_ms,
          };

          // Emit final message.updated event before persisting
          emitSse({
            type: 'message.updated',
            properties: {
              sessionID: id,
              messageID: assistantMsgId,
              info: {
                id: assistantMsgId,
                sessionID: id,
                role: 'assistant',
                finish: 'stop',
                status: 'completed',
              },
              parts: assistantParts,
            },
          });

          // Emit session idle
          emitSse({ type: 'session.status', properties: { sessionID: id, status: 'idle' } });

          async function persistAndClose() {
            try {
              const existing = [...existingMessages];
              existing.push(assistantMessage);
              await saveMessages(existing);
              if (Object.hasOwn(sessions, id)) {
                sessions[id].updatedAt = new Date().toISOString();
                sessions[id].messageCount = existing.length;
                await saveSessions();
              }
              broadcastGlobalEvent({ type: 'session.updated', properties: { sessionID: id } });
            } catch (err) {
              console.error('[claudecode-adapter] Failed to persist assistant message:', err.message);
              broadcastGlobalEvent({ type: 'session.updated', properties: { sessionID: id } });
            } finally {
              res.removeListener('close', onClose);
              if (!res.writableEnded) res.end();
            }
          }
          persistAndClose();
        } else if (event.type === 'result' && event.subtype === 'error') {
          const errMsg = typeof event.error === 'string' ? event.error : 'Claude error';

          // Persist error placeholder
          const errEntry = {
            role: 'assistant',
            content: `[Error: ${event.error || 'Unknown error'}]`,
            createdAt: new Date().toISOString(),
            error: true,
          };
          const msgs = [...existingMessages, errEntry];
          saveMessages(msgs).catch(() => {});
          if (Object.hasOwn(sessions, id)) {
            sessions[id].updatedAt = new Date().toISOString();
            sessions[id].messageCount = msgs.length;
            saveSessions();
          }

          broadcastGlobalEvent({ type: 'session.updated', properties: { sessionID: id } });
          emitSse({
            type: 'session.status',
            properties: { sessionID: id, status: 'idle', error: errMsg },
          });
          res.removeListener('close', onClose);
          if (!res.writableEnded) {
            res.end();
          }
        }
      }
    });

    let stderrBuf = '';
    claudeProc.stderr.on('data', (chunk) => {
      if (stderrBuf.length < STDERR_MAX) {
        stderrBuf += chunk.toString('utf8');
      }
    });

    claudeProc.on('close', (code) => {
      clearTimeout(timeoutHandle);

      // Process any remaining stdout content not followed by a newline
      if (stdoutBuf.trim()) {
        try {
          const parsed = JSON.parse(stdoutBuf.trim());
          if (parsed && typeof parsed.type === 'string') {
            if (parsed.type === 'result' && parsed.subtype === 'success') {
              // If we get a success result here, emit the completion events
              const fullText = assistantParts
                .filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join('');
              const assistantMessage = {
                id: assistantMsgId,
                role: 'assistant',
                content: fullText,
                parts: assistantParts,
                createdAt: new Date().toISOString(),
                cost_usd: parsed.total_cost_usd,
                duration_ms: parsed.duration_ms,
              };
              emitSse({
                type: 'message.updated',
                properties: {
                  sessionID: id,
                  messageID: assistantMsgId,
                  info: { id: assistantMsgId, sessionID: id, role: 'assistant', finish: 'stop', status: 'completed' },
                  parts: assistantParts,
                },
              });
              async function persistTrailingAndClose() {
                try {
                  const existing = [...existingMessages];
                  existing.push(assistantMessage);
                  await saveMessages(existing);
                  if (Object.hasOwn(sessions, id)) {
                    sessions[id].updatedAt = new Date().toISOString();
                    sessions[id].messageCount = existing.length;
                    await saveSessions();
                  }
                  broadcastGlobalEvent({ type: 'session.updated', properties: { sessionID: id } });
                } catch (err) {
                  console.error('[claudecode-adapter] Failed to persist assistant message:', err.message);
                  broadcastGlobalEvent({ type: 'session.updated', properties: { sessionID: id } });
                }
              }
              persistTrailingAndClose();
              emitSse({ type: 'session.status', properties: { sessionID: id, status: 'idle' } });
              res.removeListener('close', onClose);
              if (!res.writableEnded) res.end();
              return;
            }
          }
        } catch { /* ignore invalid JSON */ }
      }

      res.removeListener('close', onClose);

      if (code !== 0 && !res.writableEnded) {
        const errDetail = stderrBuf.trim() || `Claude exited with code ${code}`;
        console.error('[claudecode-adapter] claude process error:', errDetail);
        broadcastGlobalEvent({ type: 'session.updated', properties: { sessionID: id } });
        emitSse({ type: 'session.status', properties: { sessionID: id, status: 'idle', error: errDetail } });
        if (!res.writableEnded) res.end();
      } else if (!res.writableEnded) {
        // Clean exit but response not yet ended (shouldn't normally happen, but be safe)
        broadcastGlobalEvent({ type: 'session.updated', properties: { sessionID: id } });
        emitSse({ type: 'session.status', properties: { sessionID: id, status: 'idle' } });
        res.end();
      }
    });

    claudeProc.on('error', (err) => {
      console.error('[claudecode-adapter] Failed to spawn claude:', err.message);
      res.removeListener('close', onClose);
      if (!res.writableEnded) {
        emitSse({
          type: 'session.status',
          properties: { sessionID: id, status: 'idle', error: err.message },
        });
        res.end();
      }
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
    res.json({ theme: null, autoshare: false, keybinds: {} });
  });
  app.get('/config/agents', (_req, res) => {
    res.json([]);
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

  // Filesystem / git / terminal stubs
  const notImplemented = (_req, res) => {
    res.status(501).json({ error: 'Not implemented for Claude Code backend' });
  };
  app.get('/fs/*', notImplemented);
  app.get('/git/*', notImplemented);
  app.get('/terminal/*', notImplemented);
  app.post('/terminal/*', notImplemented);

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
