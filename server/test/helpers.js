// 测试 / 端到端脚本共用：ws 测试客户端、配对、按 bot 策略行动、打完一局
import { WebSocket } from 'ws';
import { nextIntent } from './bot.js';

export class Client {
  constructor(url, label = '') {
    this.label = label;
    this.ws = new WebSocket(url);
    this.msgs = [];      // 收到的全部消息（含 hello）
    this.cursor = 0;     // waitFor 消费位置
    this.waiters = [];
    this.seq = null;
    this.view = null;
    this.seqGaps = 0;    // update.seq 不连续的次数（应为 0）
    this.leaks = [];     // 信息隐藏检查失败记录
    this.closed = new Promise(res => this.ws.on('close', (code, reason) => res({ code, reason: String(reason) })));
    this.ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      this.msgs.push(m);
      if (m.t === 'joined') { Object.assign(this, { token: m.token, seat: m.seat, code: m.code, roomId: m.roomId }); }
      if (m.t === 'snapshot') { this.seq = m.seq; this.view = m.view; this.seat = m.view.seat; this.roomId = m.view.roomId; this.checkView(m.view); }
      if (m.t === 'update') {
        if (this.seq !== null && m.seq !== this.seq + 1) { this.seqGaps++; }
        this.seq = m.seq; this.view = m.view; this.checkView(m.view);
        for (const e of m.events) { if (e.type === 'draw' && e.side !== m.view.seat && (e.cardId || e.uid)) { this.leaks.push('opp draw cardId'); } }
      }
      for (const w of [...this.waiters]) {
        if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
      }
    });
  }
  // 每条 view 都做信息隐藏检查
  checkView(v) {
    if (v.opp.hand !== undefined) { this.leaks.push('opp.hand present'); }
    if (v.opp.deck !== undefined || v.me.deck !== undefined) { this.leaks.push('deck present'); }
    if (typeof v.opp.handCount !== 'number') { this.leaks.push('opp.handCount missing'); }
    const text = JSON.stringify(v);
    if (text.includes('"seed"') || text.includes('"token"')) { this.leaks.push('seed/token in view'); }
  }
  open() { return new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); }); }
  send(m) { this.ws.send(JSON.stringify(m)); }
  // 等一条满足条件的消息：先扫未消费的积压，再等新消息
  waitFor(pred, ms = 4000, label = 'message') {
    return new Promise((resolve, reject) => {
      for (let i = this.cursor; i < this.msgs.length; i++) {
        if (pred(this.msgs[i])) { this.cursor = i + 1; return resolve(this.msgs[i]); }
      }
      this.cursor = this.msgs.length;
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w.resolve !== done);
        reject(new Error(`[${this.label || this.seat}] timeout waiting for ${label}`));
      }, ms);
      const done = m => { clearTimeout(timer); this.cursor = this.msgs.length; resolve(m); };
      this.waiters.push({ pred, resolve: done });
    });
  }
  close() { this.ws.close(); return this.closed; }
}

export const wsUrlOf = app => `ws://127.0.0.1:${app.port}/ws`;

// 建房 + 加入 → 双方都拿到 snapshot
export async function pair(url, { nameA = 'Alice', nameB = 'Bob' } = {}) {
  const a = new Client(url, 'A');
  const b = new Client(url, 'B');
  await Promise.all([a.open(), b.open()]);
  a.send({ t: 'create', name: nameA });
  const ja = await a.waitFor(m => m.t === 'joined', 4000, 'joined(A)');
  b.send({ t: 'join', code: ja.code, name: nameB });
  await b.waitFor(m => m.t === 'joined', 4000, 'joined(B)');
  await Promise.all([a.waitFor(m => m.t === 'snapshot', 4000, 'snapshot(A)'), b.waitFor(m => m.t === 'snapshot', 4000, 'snapshot(B)')]);
  return { a, b, code: ja.code, roomId: ja.roomId };
}

// 按 bot 策略一直行动，直到轮不到自己 / 对局结束。每条 intent 等到自己的 update 或 error 再发下一条
export async function act(c, maxSteps = 300) {
  for (let i = 0; i < maxSteps; i++) {
    const intent = nextIntent(c.view);
    if (!intent) { return; }
    const reqId = `${c.seat}-${c.seq}-${i}`;
    c.send({ t: 'intent', reqId, ...intent });
    const m = await c.waitFor(x => (x.t === 'update' && x.actor === c.seat) || (x.t === 'error' && x.reqId === reqId), 4000, `response to ${intent.op}`);
    if (m.t === 'error') {
      if (m.code === 'RATE_LIMITED') { await sleep(150); continue; }   // 脚本太快被限流：歇一下重发
      throw new Error(`[${c.seat}] bot intent ${intent.op} rejected: ${m.code}`);
    }
  }
  throw new Error('bot exceeded max steps');
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// 等到客户端收到 >= seq 的状态（让两个客户端的视角对齐）
export async function waitSeq(c, seq, ms = 8000) {
  if (c.seq !== null && c.seq >= seq) { return; }
  await c.waitFor(m => (m.t === 'update' || m.t === 'snapshot') && m.seq >= seq, ms, `seq>=${seq}`);
}

// 等到轮到自己或对局结束
export async function waitTurn(c, ms = 8000) {
  if (c.view && (c.view.over || (c.view.phase === 'play' && c.view.active === c.seat))) { return; }
  await c.waitFor(m => (m.t === 'update' || m.t === 'snapshot') && (m.view.over || (m.view.phase === 'play' && m.view.active === c.seat)), ms, 'my turn');
}

// 两个客户端打完一局：换牌 → 轮流行动 → 结束。返回摘要
export async function playGame(a, b, { maxTurns = 120 } = {}) {
  await Promise.all([act(a), act(b)]);                 // 换牌（谁先换完谁可能直接开始 p1 回合）
  await Promise.all([waitSeq(a, b.seq), waitSeq(b, a.seq)]);   // 对齐双方视角
  let turns = 0;
  while (!a.view.over && turns < maxTurns) {
    const cur = a.view.active === a.seat ? a : b;      // 双方已对齐，active 可信
    const seqBefore = cur.seq;
    await act(cur);
    if (cur.seq === seqBefore && !cur.view.over) { throw new Error(`[${cur.seat}] no progress at seq ${cur.seq}`); }
    const nxt = cur === a ? b : a;
    await waitSeq(nxt, cur.seq);                       // 对手收到同样的 seq 后再轮到它
    turns++;
  }
  // 等双方都收到终局
  await Promise.all([a, b].map(c => c.view.over ? null : c.waitFor(m => m.t === 'update' && m.view.over, 4000, 'game over')));
  return { turns, winner: a.view.over, seqA: a.seq, seqB: b.seq, hpA: a.view.me.heroHp, hpB: b.view.me.heroHp,
           engineTurn: a.view.turn, seqGaps: a.seqGaps + b.seqGaps, leaks: [...a.leaks, ...b.leaks] };
}
