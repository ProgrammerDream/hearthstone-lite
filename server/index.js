// server/index.js — HTTP 静态服务 + WebSocket 对战入口 + /healthz /api/replay /api/stats
//
// 启动：node server/index.js   环境变量：PORT(8787) HOST(0.0.0.0) TURN_SECONDS(75)
//       RECONNECT_GRACE_SECONDS(60) ROOM_RETENTION_SECONDS(120) LOG_DIR(./logs)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Matchmaker } from './matchmaker.js';
import { RoomPhase } from './room.js';
import { replayEntries, parseJsonl } from './replay.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
};
// 只暴露这些静态文件 / 目录，其它（node_modules、logs、server 源码等）一律 404
const STATIC_FILES = new Set(['index.html', 'online.html', 'hearthstone-lite.html', 'hearthstone-lite.dist.html', 'README.md']);
const STATIC_DIRS = ['assets/', 'shared/', 'docs/'];

const envNum = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);

export function createApp(opts = {}) {
  const cfg = {
    host: opts.host ?? process.env.HOST ?? '0.0.0.0',
    port: opts.port ?? envNum('PORT', 8787),
    turnSeconds: opts.turnSeconds ?? envNum('TURN_SECONDS', 75),
    graceMs: opts.graceMs ?? envNum('RECONNECT_GRACE_SECONDS', 60) * 1000,
    retentionMs: opts.retentionMs ?? envNum('ROOM_RETENTION_SECONDS', 120) * 1000,
    logDir: opts.logDir ?? process.env.LOG_DIR ?? path.join(ROOT, 'logs'),
    heartbeatMs: opts.heartbeatMs ?? 30_000,
    quiet: !!opts.quiet,
  };
  const log = (...a) => { if (!cfg.quiet) { console.log(new Date().toISOString(), ...a); } };
  fs.mkdirSync(cfg.logDir, { recursive: true });

  // 对局日志落盘：logs/<roomId>.jsonl，一行一条，整文件覆写（对局结束 / 关房时）
  const writeLog = room => {
    const file = path.join(cfg.logDir, `${room.id}.jsonl`);
    fs.writeFileSync(file, room.log.map(e => JSON.stringify(e)).join('\n') + '\n');
  };
  const mm = new Matchmaker({ turnSeconds: cfg.turnSeconds, graceMs: cfg.graceMs, retentionMs: cfg.retentionMs, writeLog });
  const startedAt = Date.now();

  // ---------------- HTTP ----------------
  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (rel === '') { rel = 'online.html'; }
    const allowed = STATIC_FILES.has(rel) || STATIC_DIRS.some(d => rel.startsWith(d));
    const abs = path.resolve(ROOT, rel);
    if (!allowed || !abs.startsWith(ROOT + path.sep) || rel.includes('..')) { return json(res, 404, { error: 'not found' }); }
    fs.stat(abs, (err, st) => {
      if (err || !st.isFile()) { return json(res, 404, { error: 'not found' }); }
      const ext = path.extname(abs).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': ext === '.html' || ext === '.js' ? 'no-cache' : 'public, max-age=86400',
      });
      if (req.method === 'HEAD') { return res.end(); }
      fs.createReadStream(abs).pipe(res);
    });
  }

  function handleHttp(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (req.method !== 'GET' && req.method !== 'HEAD') { return json(res, 405, { error: 'method not allowed' }); }
    if (p === '/healthz') {
      return json(res, 200, { ok: true, version: VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
                              rooms: mm.rooms.size, clients: wss.clients.size, turnSeconds: cfg.turnSeconds });
    }
    if (p === '/api/stats') {
      return json(res, 200, { rooms: [...mm.rooms.values()].map(r => r.summary()), clients: wss.clients.size });
    }
    const m = p.match(/^\/api\/replay\/([0-9a-f]{8})$/);
    if (m) {
      const id = m[1];
      let entries;
      const room = mm.rooms.get(id);
      if (room) { entries = room.log; }
      else {
        const file = path.join(cfg.logDir, `${id}.jsonl`);
        if (!fs.existsSync(file)) { return json(res, 404, { error: 'room log not found' }); }
        entries = parseJsonl(fs.readFileSync(file, 'utf8'));
      }
      try {
        const r = replayEntries(entries);
        return json(res, 200, { roomId: id, entries: entries.length, source: room ? 'memory' : 'file',
                                intents: entries.filter(e => e.seat && ['mulligan', 'play', 'attack', 'hero_power', 'end_turn', 'forfeit'].includes(e.op)).length,
                                ...r });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p.startsWith('/api/')) { return json(res, 404, { error: 'not found' }); }
    serveStatic(req, res, p);
  }

  const server = http.createServer(handleHttp);

  // ---------------- WebSocket ----------------
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

  const RATE_CAP = 40, RATE_PER_SEC = 20;   // 令牌桶：突发 40 条，稳态 20 条/秒（真人远达不到，脚本洪水会被限）
  function allow(conn) {
    const now = Date.now();
    conn.tokens = Math.min(RATE_CAP, conn.tokens + (now - conn.lastRefill) / 1000 * RATE_PER_SEC);
    conn.lastRefill = now;
    if (conn.tokens < 1) { return false; }
    conn.tokens -= 1;
    return true;
  }
  const sendTo = (sock, msg) => { try { sock.send(JSON.stringify(msg)); } catch { /* ignore */ } };
  const activeRoom = conn => (conn.room && conn.room.phase !== RoomPhase.CLOSED ? conn.room : null);

  wss.on('connection', (sock, req) => {
    const conn = { sock, room: null, seat: null, tokens: RATE_CAP, lastRefill: Date.now(), strikes: 0, alive: true,
                   ip: req.socket.remoteAddress };
    sock.__conn = conn;   // 心跳扫描用
    sock.on('pong', () => { conn.alive = true; });
    sock.on('error', () => { /* 交给 close */ });
    sendTo(sock, { t: 'hello', version: VERSION, now: Date.now(), turnSeconds: cfg.turnSeconds });

    sock.on('message', raw => {
      if (!allow(conn)) {
        if (++conn.strikes > 30) { sock.close(4008, 'rate limit'); return; }
        let reqId;
        try { reqId = JSON.parse(raw.toString()).reqId; } catch { /* ignore */ }
        return sendTo(sock, { t: 'error', code: 'RATE_LIMITED', reqId });
      }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return sendTo(sock, { t: 'error', code: 'BAD_JSON' }); }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') { return sendTo(sock, { t: 'error', code: 'BAD_MESSAGE' }); }
      const room = activeRoom(conn);
      switch (msg.t) {
        case 'ping': return sendTo(sock, { t: 'pong', now: Date.now(), echo: msg.echo });
        case 'create': case 'join': case 'quick': {
          if (room) { return sendTo(sock, { t: 'error', code: 'ALREADY_IN_ROOM', reqId: msg.reqId }); }
          const r = msg.t === 'create' ? mm.create({ name: msg.name, sock })
                  : msg.t === 'join' ? mm.join({ code: msg.code, name: msg.name, sock })
                  : mm.quick({ name: msg.name, sock });
          if (r.error) { return sendTo(sock, { t: 'error', code: r.error, reqId: msg.reqId }); }
          conn.room = r.room; conn.seat = r.seat;
          log(`[ws] ${msg.t} room=${r.room.id} code=${r.room.code} seat=${r.seat} ip=${conn.ip}`);
          return;   // joined / snapshot 由 Room 自己发
        }
        case 'resume': {
          if (room) { return sendTo(sock, { t: 'error', code: 'ALREADY_IN_ROOM', reqId: msg.reqId }); }
          const r = mm.resume({ token: msg.token, sock });
          if (r.error) { return sendTo(sock, { t: 'error', code: r.error, reqId: msg.reqId }); }
          conn.room = r.room; conn.seat = r.seat;
          log(`[ws] resume room=${r.room.id} seat=${r.seat} ip=${conn.ip}`);
          return;
        }
        case 'intent':
          if (!room) { return sendTo(sock, { t: 'error', code: 'NOT_IN_ROOM', reqId: msg.reqId }); }
          return room.handleIntent(conn.seat, msg);
        case 'sync':
          if (!room) { return sendTo(sock, { t: 'error', code: 'NOT_IN_ROOM', reqId: msg.reqId }); }
          return room.sendSnapshot(conn.seat);
        case 'leave':
          if (room) { room.leave(conn.seat); }
          conn.room = null; conn.seat = null;
          return;
        default:
          return sendTo(sock, { t: 'error', code: 'BAD_MESSAGE', reqId: msg.reqId });
      }
    });

    sock.on('close', () => {
      const room = activeRoom(conn);
      if (room) { room.detach(conn.seat, sock); }
      conn.room = null;
    });
  });

  // 心跳：30 秒没回 pong 的连接直接掐掉（触发 close → detach → 重连宽限）
  const heartbeat = setInterval(() => {
    for (const sock of wss.clients) {
      const conn = sock.__conn;
      if (!conn) { continue; }
      if (!conn.alive) { sock.terminate(); continue; }
      conn.alive = false;
      try { sock.ping(); } catch { /* ignore */ }
    }
  }, cfg.heartbeatMs);
  heartbeat.unref();

  const app = {
    cfg, server, wss, mm,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, () => {
          const addr = server.address();
          app.port = addr.port;
          app.url = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${addr.port}`;
          log(`[http] hearthstone-lite v${VERSION} listening on ${cfg.host}:${addr.port} turn=${cfg.turnSeconds}s grace=${cfg.graceMs / 1000}s`);
          resolve(app);
        });
      });
    },
    close() {
      clearInterval(heartbeat);
      mm.closeAll('shutdown');
      for (const sock of wss.clients) { try { sock.close(1001, 'server shutdown'); } catch { /* ignore */ } }
      return new Promise(resolve => { wss.close(() => server.close(() => resolve())); });
    },
  };
  return app;
}

// 直接运行时启动；被测试 import 时不启动
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  await app.listen();
  const shutdown = sig => { console.log(`[http] ${sig} received, shutting down`); app.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
