// server/room.js — 房间：两个席位、对局状态机、递增 seq、回合计时、断线重连、append-only 日志
//
// 房间状态机：waiting → mulligan → playing → over → closed
//   waiting : 只有一个人，等对手（房间码 / 快速匹配）
//   mulligan: 两人到齐，new Game(seed)，双方换牌（有超时）
//   playing : 引擎内部 回合开始(抽牌、法力+1) → 行动 → 回合结束 循环，每回合服务端计时
//   over    : 分出胜负（打空血量 / 掉线超时判负 / 主动退出），保留一段时间供查看与重连
//   closed  : 清理计时器、落日志、从匹配器移除
//
// 唯一改规则状态的入口是 handleIntent / onTurnTimeout / onGraceExpired，全部走 game.apply，
// 成功才 seq+1 并广播；失败只给操作者回 error，seq 不变、状态不变。
import { Game, other, SIDES } from '../shared/engine.js';
import { viewFor, eventsFor } from './view.js';

export const RoomPhase = Object.freeze({
  WAITING: 'waiting', MULLIGAN: 'mulligan', PLAYING: 'playing', OVER: 'over', CLOSED: 'closed',
});

const DEFAULTS = {
  turnSeconds: 75,      // 每回合 / 换牌阶段时长
  graceMs: 60_000,      // 断线后保留席位的时间，超时判负
  retentionMs: 120_000, // 对局结束后房间保留时间（看结果、重连看终局）
};

export function sanitizeName(name, fallback) {
  const s = String(name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
  return s || fallback;
}

const publicPlayer = p => (p ? { name: p.name, connected: p.connected } : null);

export class Room {
  /**
   * @param {object} o
   * @param {string} o.id              房间 id（日志文件名）
   * @param {string} o.code            4 位房间码
   * @param {number} o.seed            引擎种子（只进日志，不下发）
   * @param {boolean} [o.quick]        是否快速匹配房
   * @param {Function} [o.onClose]     房间关闭回调（匹配器用来删索引）
   * @param {Function} [o.writeLog]    落盘回调 (room) => void
   * @param {Function} [o.now]         时钟（测试可注入）
   */
  constructor(o) {
    Object.assign(this, DEFAULTS, {
      turnSeconds: o.turnSeconds, graceMs: o.graceMs, retentionMs: o.retentionMs,
    });
    for (const k of Object.keys(DEFAULTS)) { if (this[k] === undefined) { this[k] = DEFAULTS[k]; } }
    this.id = o.id;
    this.code = o.code;
    this.seed = o.seed >>> 0;
    this.quick = !!o.quick;
    this.onClose = o.onClose || (() => {});
    this.writeLog = o.writeLog || (() => {});
    this.now = o.now || (() => Date.now());

    this.phase = RoomPhase.WAITING;
    this.players = { p1: null, p2: null };
    this.game = null;
    this.seq = 0;                 // 每次成功结算 +1，随 update 广播；客户端据此发现丢包并 sync
    this.log = [];                // append-only：{ts, seq, actor, seat, op, payload, ok, code}
    this.result = null;           // { winner, reason: 'hp'|'abandon'|'forfeit' }
    this.turnDeadline = null;     // 当前阶段截止时间戳（毫秒），下发给客户端做倒计时
    this.turnTimer = null;
    this.closeTimer = null;
    this.createdAt = this.now();
    this.startedAt = null;
    this.endedAt = null;
    this.record({ actor: 'server', op: 'create', payload: { code: this.code, quick: this.quick }, ok: true });
  }

  get isFull() { return !!(this.players.p1 && this.players.p2); }
  get live() { return this.phase === RoomPhase.MULLIGAN || this.phase === RoomPhase.PLAYING; }

  seatOf(token) {
    for (const seat of SIDES) { if (this.players[seat] && this.players[seat].token === token) { return seat; } }
    return null;
  }

  // ---------- 入座 / 开局 ----------
  addPlayer({ name, token, sock }) {
    const seat = !this.players.p1 ? 'p1' : (!this.players.p2 ? 'p2' : null);
    if (!seat) { return null; }
    this.players[seat] = { seat, name: sanitizeName(name, seat === 'p1' ? '玩家1' : '玩家2'),
                           token, sock, connected: true, disconnectedAt: null, graceTimer: null };
    this.record({ actor: seat, seat, op: 'join', payload: { name: this.players[seat].name }, ok: true });
    this.send(seat, this.joinedMsg(seat));
    if (this.isFull) { this.start(); }
    return seat;
  }

  joinedMsg(seat) {
    const p = this.players[seat];
    return { t: 'joined', roomId: this.id, code: this.code, seat, token: p.token, name: p.name,
             waiting: !this.isFull, now: this.now() };
  }

  start() {
    const names = { p1: this.players.p1.name, p2: this.players.p2.name };
    this.game = new Game({ seed: this.seed, names });
    this.phase = RoomPhase.MULLIGAN;
    this.startedAt = this.now();
    // 种子只写服务端日志（回放用），永远不进 view
    this.record({ actor: 'server', op: 'start', payload: { seed: this.seed, names }, ok: true });
    this.armTurnTimer();
    for (const seat of SIDES) { this.sendSnapshot(seat); }
  }

  // ---------- 视角与下发 ----------
  extra() {
    return {
      roomId: this.id, code: this.code, turnDeadline: this.turnDeadline, now: this.now(),
      players: { p1: publicPlayer(this.players.p1), p2: publicPlayer(this.players.p2) },
      result: this.result,
    };
  }
  view(seat) { return viewFor(this.game, seat, this.extra()); }

  send(seat, msg) {
    const p = this.players[seat];
    if (!p || !p.sock || !p.connected) { return; }
    try { p.sock.send(JSON.stringify(msg)); } catch { /* 对端已断，等 close 事件处理 */ }
  }
  sendError(seat, code, reqId) { this.send(seat, { t: 'error', code, reqId }); }
  sendSnapshot(seat) {
    if (!this.game) { this.send(seat, this.joinedMsg(seat)); return; }
    this.send(seat, { t: 'snapshot', seq: this.seq, view: this.view(seat) });
  }
  broadcastUpdate(actor, op, events) {
    for (const seat of SIDES) {
      this.send(seat, { t: 'update', seq: this.seq, actor, op, events: eventsFor(events, seat), view: this.view(seat) });
    }
  }

  // ---------- 意图处理（客户端唯一能影响状态的途径） ----------
  handleIntent(seat, msg) {
    const reqId = msg.reqId;
    if (!this.game) { return this.sendError(seat, 'NOT_STARTED', reqId); }
    if (this.phase === RoomPhase.OVER || this.phase === RoomPhase.CLOSED) { return this.sendError(seat, 'GAME_OVER', reqId); }
    const op = typeof msg.op === 'string' ? msg.op : '';
    if (op === 'forfeit') { return this.sendError(seat, 'BAD_INTENT', reqId); }   // 认输走 leave 消息
    const payload = {};
    if (msg.uids !== undefined) { payload.uids = msg.uids; }
    if (msg.uid !== undefined) { payload.uid = msg.uid; }
    if (msg.target !== undefined) { payload.target = msg.target; }
    const turnBefore = this.game.state.turn;
    const r = this.game.apply(seat, op, payload);
    this.record({ actor: seat, seat, op, payload, ok: r.ok, code: r.code });
    if (!r.ok) { return this.sendError(seat, r.code, reqId); }
    this.afterChange(seat, op, r.events, turnBefore);
  }

  // 成功结算后的统一收尾：seq+1、同步房间阶段、重置计时、广播、必要时收尾
  afterChange(actor, op, events, turnBefore) {
    this.seq++;
    const s = this.game.state;
    if (s.over) {
      const go = events.find(e => e.type === 'game_over');
      this.setResult(s.over, (go && go.reason) || 'hp');
    } else {
      if (s.phase === 'play') { this.phase = RoomPhase.PLAYING; }
      if (s.turn !== turnBefore) { this.armTurnTimer(); }   // 新回合（含换牌→首回合）重新计时
    }
    this.broadcastUpdate(actor, op, events);
    if (s.over) { this.scheduleClose(); }
  }

  setResult(winner, reason) {
    this.phase = RoomPhase.OVER;
    this.result = { winner, reason };
    this.endedAt = this.now();
    this.clearTurnTimer();
    this.turnDeadline = null;
    this.record({ actor: 'server', op: 'game_over', payload: { winner, reason, digest: this.game.digest(), turn: this.game.state.turn }, ok: true });
    this.flushLog();
  }

  // ---------- 回合计时（服务端权威，客户端只显示倒计时） ----------
  armTurnTimer() {
    this.clearTurnTimer();
    const ms = Math.max(50, Math.round(this.turnSeconds * 1000));
    this.turnDeadline = this.now() + ms;
    this.turnTimer = setTimeout(() => this.onTurnTimeout(), ms);
  }
  clearTurnTimer() {
    if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }
  }
  onTurnTimeout() {
    this.turnTimer = null;
    if (!this.game || !this.live) { return; }
    const s = this.game.state;
    const turnBefore = s.turn;
    if (s.phase === 'mulligan') {
      // 超时未换牌的一方视为"不换"
      let events = [];
      for (const seat of SIDES) {
        if (s.mulliganDone[seat]) { continue; }
        const r = this.game.mulligan(seat, []);
        this.record({ actor: 'server', seat, op: 'mulligan', payload: { uids: [] }, ok: r.ok, code: r.code });
        if (r.ok) { events = events.concat(r.events); }
      }
      this.afterChange('server', 'mulligan_timeout', events, turnBefore);
      return;
    }
    const seat = s.active;
    const r = this.game.endTurn();
    this.record({ actor: 'server', seat, op: 'end_turn', payload: {}, ok: r.ok, code: r.code });
    if (r.ok) { this.afterChange('server', 'timeout', r.events, turnBefore); }
  }

  // ---------- 连接管理 ----------
  // 连接断开：席位保留 graceMs，期间对手看到"对方掉线"；超时判负
  detach(seat, sock) {
    const p = this.players[seat];
    if (!p || (sock && p.sock && p.sock !== sock)) { return; }   // 已被新连接顶替的旧 socket，忽略
    p.connected = false;
    p.sock = null;
    p.disconnectedAt = this.now();
    this.record({ actor: seat, seat, op: 'disconnect', ok: true });
    if (!this.live && this.phase !== RoomPhase.WAITING) { this.maybeCloseAfterOver(); return; }
    const graceUntil = p.disconnectedAt + this.graceMs;
    if (this.live) { this.send(other(seat), { t: 'opponent', status: 'disconnected', graceUntil, now: this.now() }); }
    if (p.graceTimer) { clearTimeout(p.graceTimer); }
    p.graceTimer = setTimeout(() => this.onGraceExpired(seat), this.graceMs);
  }

  onGraceExpired(seat) {
    const p = this.players[seat];
    if (!p || p.connected) { return; }
    p.graceTimer = null;
    if (this.phase === RoomPhase.WAITING) { this.close('abandoned'); return; }
    if (!this.live) { return; }
    const turnBefore = this.game.state.turn;
    const r = this.game.apply(seat, 'forfeit', { reason: 'abandon' });
    this.record({ actor: 'server', seat, op: 'forfeit', payload: { reason: 'abandon' }, ok: r.ok, code: r.code });
    if (r.ok) { this.afterChange('server', 'forfeit', r.events, turnBefore); }
  }

  // 主动退出：对局中 = 认输；等待中 = 关房
  leave(seat) {
    if (this.phase === RoomPhase.WAITING) { this.close('left'); return; }
    if (!this.live) { return; }
    const turnBefore = this.game.state.turn;
    const r = this.game.apply(seat, 'forfeit', { reason: 'forfeit' });
    this.record({ actor: seat, seat, op: 'forfeit', payload: { reason: 'forfeit' }, ok: r.ok, code: r.code });
    if (r.ok) { this.afterChange(seat, 'forfeit', r.events, turnBefore); }
  }

  // 重连：token 对席位，换上新 socket，下发完整快照；对手收到"已重连"
  resume(token, sock) {
    const seat = this.seatOf(token);
    if (!seat) { return null; }
    const p = this.players[seat];
    if (p.sock && p.sock !== sock) {
      const old = p.sock;
      p.sock = null;
      try { old.close(4001, 'replaced by new connection'); } catch { /* ignore */ }
    }
    if (p.graceTimer) { clearTimeout(p.graceTimer); p.graceTimer = null; }
    const wasDisconnected = !p.connected;
    p.sock = sock;
    p.connected = true;
    p.disconnectedAt = null;
    this.record({ actor: seat, seat, op: 'resume', ok: true });
    this.sendSnapshot(seat);
    if (wasDisconnected && this.live) { this.send(other(seat), { t: 'opponent', status: 'reconnected', now: this.now() }); }
    return seat;
  }

  // ---------- 生命周期 ----------
  scheduleClose() {
    if (this.closeTimer) { return; }
    this.closeTimer = setTimeout(() => this.close('finished'), this.retentionMs);
  }
  maybeCloseAfterOver() {
    if (this.phase === RoomPhase.OVER && !SIDES.some(s => this.players[s] && this.players[s].connected)) { this.close('finished'); }
  }
  close(reason) {
    if (this.phase === RoomPhase.CLOSED) { return; }
    this.clearTurnTimer();
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
    for (const seat of SIDES) {
      const p = this.players[seat];
      if (!p) { continue; }
      if (p.graceTimer) { clearTimeout(p.graceTimer); p.graceTimer = null; }
      this.send(seat, { t: 'room_closed', reason });
    }
    this.phase = RoomPhase.CLOSED;
    this.record({ actor: 'server', op: 'close', payload: { reason }, ok: true });
    if (this.game) { this.flushLog(); }
    this.onClose(this);
  }

  // ---------- 日志 ----------
  record(entry) { this.log.push({ ts: this.now(), seq: this.seq, ...entry }); }
  flushLog() { try { this.writeLog(this); } catch (e) { console.error('[room] write log failed', this.id, e.message); } }

  // 给 /api/stats 用的公开摘要（无 token、无种子）
  summary() {
    return { id: this.id, code: this.code, phase: this.phase, seq: this.seq, turn: this.game ? this.game.state.turn : 0,
             players: { p1: publicPlayer(this.players.p1), p2: publicPlayer(this.players.p2) },
             result: this.result, createdAt: this.createdAt };
  }
}
