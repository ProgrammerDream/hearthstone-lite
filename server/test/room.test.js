// 服务端端到端测试：真实 HTTP + WebSocket，两个 ws 客户端打完整局，校验权威校验 / 隐藏 / seq / 重连 / 计时 / 回放
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.js';
import { Client, pair, act, waitTurn, playGame, wsUrlOf } from './helpers.js';

async function startApp(opts = {}) {
  const app = createApp({ host: '127.0.0.1', port: 0, quiet: true,
                          logDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hs-logs-')), turnSeconds: 60, graceMs: 5000, ...opts });
  await app.listen();
  return app;
}
const getJson = async (app, p) => { const r = await fetch(`http://127.0.0.1:${app.port}${p}`); return { status: r.status, body: await r.json() }; };
async function mulliganBoth(a, b) {
  a.send({ t: 'intent', op: 'mulligan', uids: [] });
  await a.waitFor(m => m.t === 'update' && m.actor === 'p1', 4000, 'p1 mulligan update');
  b.send({ t: 'intent', op: 'mulligan', uids: [] });
  await Promise.all([a, b].map(c => c.waitFor(m => m.t === 'update' && m.view.phase === 'play', 4000, 'phase play')));
}

test('两个 ws 客户端端到端打完一局：seq 连续、无信息泄露、双方视角一致、日志可回放', async () => {
  const app = await startApp();
  try {
    const { a, b, roomId } = await pair(wsUrlOf(app));
    assert.equal(a.seat, 'p1'); assert.equal(b.seat, 'p2');
    assert.equal(a.view.phase, 'mulligan');
    assert.equal(a.view.me.hand.length, 3); assert.equal(b.view.me.hand.length, 5);
    assert.equal(a.view.opp.handCount, 5); assert.equal(b.view.opp.handCount, 3);
    const r = await playGame(a, b);
    assert.ok(['p1', 'p2', 'draw'].includes(r.winner), `winner=${r.winner}`);
    assert.equal(a.view.over, b.view.over);
    assert.equal(r.seqGaps, 0, 'seq 必须连续');
    assert.equal(a.seq, b.seq, '双方收到同样多的结算');
    assert.deepEqual(r.leaks, []);
    // 双方视角交叉一致：A 看到的对手 = B 的自己
    assert.equal(a.view.opp.heroHp, b.view.me.heroHp);
    assert.equal(a.view.opp.handCount, b.view.me.hand.length);
    assert.equal(a.view.opp.deckCount, b.view.me.deckCount);
    assert.deepEqual(a.view.opp.board, b.view.me.board);
    assert.equal(a.view.phase, 'over');
    assert.equal(a.view.result.reason, 'hp');
    assert.equal(a.view.turnDeadline, null);
    // 终局后操作被拒
    a.send({ t: 'intent', reqId: 'after', op: 'end_turn' });
    const e = await a.waitFor(m => m.t === 'error' && m.reqId === 'after');
    assert.equal(e.code, 'GAME_OVER');
    // 日志落盘 + 回放一致
    const file = path.join(app.cfg.logDir, `${roomId}.jsonl`);
    assert.ok(fs.existsSync(file), '对局日志应落盘');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(lines.some(l => l.op === 'start' && typeof l.payload.seed === 'number'));
    assert.ok(lines.filter(l => l.op === 'play' || l.op === 'attack').length > 0);
    // 日志里 seq 单调不减
    for (let i = 1; i < lines.length; i++) { assert.ok(lines[i].seq >= lines[i - 1].seq); }
    const rep = await getJson(app, `/api/replay/${roomId}`);
    assert.equal(rep.status, 200);
    assert.equal(rep.body.match, true, JSON.stringify(rep.body));
    assert.equal(rep.body.failed, 0);
    assert.equal(rep.body.over, r.winner);
    console.log(`    e2e: winner=${r.winner} rounds=${Math.ceil(r.engineTurn / 2)} seq=${a.seq} hp=${r.hpA}/${r.hpB} replay=${rep.body.digest}`);
    // 房间关闭后仍可从文件回放
    app.mm.rooms.get(roomId).close('test');
    const rep2 = await getJson(app, `/api/replay/${roomId}`);
    assert.equal(rep2.body.source, 'file'); assert.equal(rep2.body.match, true);
    await Promise.all([a.close(), b.close()]);
  } finally { await app.close(); }
});

test('服务器权威：非法 intent 被拒（错误码正确），seq 与状态摘要不变，对手收不到任何广播', async () => {
  const app = await startApp();
  try {
    const { a, b, roomId } = await pair(wsUrlOf(app));
    await mulliganBoth(a, b);
    const room = app.mm.rooms.get(roomId);
    const digest = room.game.digest();
    const seq = room.seq;
    const updatesB = b.msgs.filter(m => m.t === 'update').length;
    const expect = async (c, msg, code) => {
      c.send({ t: 'intent', reqId: msg.reqId, ...msg });
      const e = await c.waitFor(m => m.t === 'error' && m.reqId === msg.reqId, 4000, msg.reqId);
      assert.equal(e.code, code, `${msg.reqId}: expected ${code}, got ${e.code}`);
    };
    await expect(b, { reqId: 'e1', op: 'end_turn' }, 'NOT_YOUR_TURN');                             // 不是你的回合
    await expect(b, { reqId: 'e2', op: 'play', uid: b.view.me.hand[0].uid }, 'NOT_YOUR_TURN');
    await expect(a, { reqId: 'e3', op: 'play', uid: b.view.me.hand[0].uid }, 'NOT_IN_HAND');       // 打对手手里的牌
    await expect(a, { reqId: 'e4', op: 'play', uid: 'abc' }, 'NOT_IN_HAND');
    await expect(a, { reqId: 'e5', op: 'hero_power', target: { type: 'hero', side: 'p2' } }, 'NO_MANA');  // 1 费回合用 2 费技能
    await expect(a, { reqId: 'e6', op: 'attack', uid: 12345, target: { type: 'hero', side: 'p2' } }, 'NO_MINION');
    await expect(a, { reqId: 'e7', op: 'hack' }, 'BAD_INTENT');
    await expect(a, { reqId: 'e8', op: 'forfeit' }, 'BAD_INTENT');
    await expect(a, { reqId: 'e9', op: 'mulligan', uids: [] }, 'WRONG_PHASE');
    // 法力够但缺目标 / 坏目标：先给 p1 一张闪电箭（直接改服务端状态，模拟手里有法术）
    const uidSeqBefore = room.game.uidSeq;
    const bolt = ++room.game.uidSeq; room.game.state.p1.hand.push({ uid: bolt, cardId: 'BOLT' });
    const digest2 = room.game.digest();
    await expect(a, { reqId: 'e10', op: 'play', uid: bolt }, 'NEED_TARGET');
    await expect(a, { reqId: 'e11', op: 'play', uid: bolt, target: { type: 'minion', uid: 999 } }, 'BAD_TARGET');
    await expect(a, { reqId: 'e12', op: 'play', uid: bolt, target: { type: 'hero', side: 'nobody' } }, 'BAD_TARGET');
    assert.equal(room.game.digest(), digest2);
    room.game.state.p1.hand.pop(); room.game.uidSeq = uidSeqBefore;
    assert.equal(room.game.digest(), digest, '非法操作后状态摘要不变');
    assert.equal(room.seq, seq, '非法操作不产生 seq');
    assert.equal(b.msgs.filter(m => m.t === 'update').length, updatesB, '对手没有收到任何广播');
    // 坏消息
    a.ws.send('not json');
    assert.equal((await a.waitFor(m => m.t === 'error' && m.code === 'BAD_JSON')).code, 'BAD_JSON');
    a.send({ t: 'nonsense' });
    assert.equal((await a.waitFor(m => m.t === 'error' && m.code === 'BAD_MESSAGE')).code, 'BAD_MESSAGE');
    a.send({ t: 'create' });
    assert.equal((await a.waitFor(m => m.t === 'error' && m.code === 'ALREADY_IN_ROOM')).code, 'ALREADY_IN_ROOM');
    // 合法操作正常：p1 结束回合 → 双方收到同一 seq
    a.send({ t: 'intent', reqId: 'ok1', op: 'end_turn' });
    const [ua, ub] = await Promise.all([a.waitFor(m => m.t === 'update'), b.waitFor(m => m.t === 'update' && m.seq === seq + 1)]);
    assert.equal(ua.seq, seq + 1); assert.equal(ub.seq, seq + 1);
    assert.equal(ua.view.active, 'p2');
    assert.equal(ub.view.active, 'p2');
    await Promise.all([a.close(), b.close()]);
  } finally { await app.close(); }
});

test('断线重连：对手收到掉线 / 重连通知；重连 snapshot 与服务端视角一致；新连接顶替旧连接', async () => {
  const app = await startApp({ graceMs: 5000 });
  try {
    const { a, b, roomId } = await pair(wsUrlOf(app));
    await mulliganBoth(a, b);
    const room = app.mm.rooms.get(roomId);
    const token = b.token;
    await b.close();
    const dc = await a.waitFor(m => m.t === 'opponent' && m.status === 'disconnected', 4000, 'opponent disconnected');
    assert.ok(dc.graceUntil > dc.now);
    assert.equal(room.players.p2.connected, false);
    // B 掉线期间 A 继续打完自己的回合（状态前进、seq 前进）
    await act(a);
    assert.equal(room.game.state.active, 'p2');
    // B 用 token 重连
    const b2 = new Client(wsUrlOf(app), 'B2');
    await b2.open();
    b2.send({ t: 'resume', token });
    const snap = await b2.waitFor(m => m.t === 'snapshot', 4000, 'resume snapshot');
    assert.equal(snap.seq, room.seq, '快照 seq = 服务端当前 seq');
    const expected = room.view('p2'); delete expected.now;
    const got = { ...snap.view }; delete got.now;
    assert.deepEqual(got, expected, '重连快照与服务端此刻的 p2 视角一致');
    assert.equal(snap.view.active, 'p2');
    assert.equal(snap.view.me.hand.length, a.view.opp.handCount);
    assert.equal(snap.view.opp.heroHp, a.view.me.heroHp);
    assert.deepEqual(snap.view.opp.board, a.view.me.board);
    const rc = await a.waitFor(m => m.t === 'opponent' && m.status === 'reconnected', 4000, 'opponent reconnected');
    assert.ok(rc);
    assert.equal(room.players.p2.connected, true);
    // 重连后 B 正常行动，seq 继续连续
    await act(b2);
    assert.equal(b2.seqGaps, 0);
    assert.equal(room.game.state.active, 'p1');
    // 同一 token 再开一条连接 → 旧连接被服务端关闭（4001）
    const b3 = new Client(wsUrlOf(app), 'B3');
    await b3.open();
    b3.send({ t: 'resume', token });
    await b3.waitFor(m => m.t === 'snapshot');
    const closed = await b2.closed;
    assert.equal(closed.code, 4001);
    assert.equal(room.players.p2.connected, true, '被顶替不算掉线');
    // 坏 token
    const c = new Client(wsUrlOf(app), 'C'); await c.open();
    c.send({ t: 'resume', token: 'deadbeef' });
    assert.equal((await c.waitFor(m => m.t === 'error')).code, 'ROOM_GONE');
    await Promise.all([a.close(), b3.close(), c.close()]);
  } finally { await app.close(); }
});

test('掉线超过宽限期判负：对手收到 actor=server 的 forfeit 更新，结果 reason=abandon', async () => {
  const app = await startApp({ graceMs: 300 });
  try {
    const { a, b } = await pair(wsUrlOf(app));
    await mulliganBoth(a, b);
    await b.close();
    const u = await a.waitFor(m => m.t === 'update' && m.op === 'forfeit', 4000, 'forfeit update');
    assert.equal(u.actor, 'server');
    assert.equal(u.view.over, 'p1');
    assert.equal(u.view.phase, 'over');
    assert.equal(u.view.result.reason, 'abandon');
    assert.ok(u.events.some(e => e.type === 'game_over' && e.reason === 'abandon'));
    await a.close();
  } finally { await app.close(); }
});

test('回合计时：换牌超时自动完成；回合超时服务端自动结束回合（actor=server, op=timeout），新回合重置 deadline', async () => {
  const app = await startApp({ turnSeconds: 0.4 });
  try {
    const { a } = await pair(wsUrlOf(app));
    assert.ok(a.view.turnDeadline > a.view.now);
    const u1 = await a.waitFor(m => m.t === 'update' && m.op === 'mulligan_timeout', 4000, 'mulligan timeout');
    assert.equal(u1.actor, 'server');
    assert.equal(u1.view.phase, 'play'); assert.equal(u1.view.active, 'p1'); assert.equal(u1.view.turn, 1);
    const u2 = await a.waitFor(m => m.t === 'update' && m.op === 'timeout', 4000, 'turn timeout 1');
    assert.equal(u2.actor, 'server'); assert.equal(u2.view.active, 'p2'); assert.equal(u2.view.turn, 2);
    assert.ok(u2.view.turnDeadline > u1.view.turnDeadline);
    const u3 = await a.waitFor(m => m.t === 'update' && m.op === 'timeout', 4000, 'turn timeout 2');
    assert.equal(u3.view.active, 'p1'); assert.equal(u3.view.turn, 3);
    assert.equal(a.seqGaps, 0);
    await a.close();
  } finally { await app.close(); }
});

test('房间与匹配：快速匹配自动配对；房间码错误 / 房满 / 未进房被拒；昵称清洗', async () => {
  const app = await startApp();
  try {
    const url = wsUrlOf(app);
    const a = new Client(url, 'A'); const b = new Client(url, 'B'); const c = new Client(url, 'C');
    await Promise.all([a.open(), b.open(), c.open()]);
    // 未进房发 intent
    c.send({ t: 'intent', reqId: 'n1', op: 'end_turn' });
    assert.equal((await c.waitFor(m => m.t === 'error' && m.reqId === 'n1')).code, 'NOT_IN_ROOM');
    c.send({ t: 'join', code: 'nope', reqId: 'n2' });
    assert.equal((await c.waitFor(m => m.t === 'error' && m.reqId === 'n2')).code, 'ROOM_NOT_FOUND');
    a.send({ t: 'quick', name: '  <b>甲</b>  ' });
    const ja = await a.waitFor(m => m.t === 'joined');
    assert.equal(ja.waiting, true); assert.match(ja.code, /^\d{4}$/);
    assert.equal(ja.name, 'b甲/b', '昵称去掉尖括号与首尾空白');
    b.send({ t: 'quick', name: '乙' });
    const jb = await b.waitFor(m => m.t === 'joined');
    assert.equal(jb.roomId, ja.roomId, '第二个 quick 进同一房');
    assert.equal(jb.waiting, false);
    await Promise.all([a.waitFor(m => m.t === 'snapshot'), b.waitFor(m => m.t === 'snapshot')]);
    assert.equal(a.view.opp.name, '乙'); assert.equal(b.view.opp.name, 'b甲/b');
    c.send({ t: 'join', code: ja.code, reqId: 'n3' });
    assert.equal((await c.waitFor(m => m.t === 'error' && m.reqId === 'n3')).code, 'ROOM_FULL');
    // 第三个 quick 自己开新房等待
    c.send({ t: 'quick' });
    const jc = await c.waitFor(m => m.t === 'joined');
    assert.notEqual(jc.roomId, ja.roomId); assert.equal(jc.waiting, true); assert.equal(jc.name, '玩家1');
    const stats = await getJson(app, '/api/stats');
    assert.equal(stats.body.rooms.length, 2);
    assert.ok(!JSON.stringify(stats.body).includes('token'));
    // 等待中的创建者主动离开 → 房间关闭
    c.send({ t: 'leave' });
    await c.waitFor(m => m.t === 'room_closed');
    assert.equal(app.mm.rooms.size, 1);
    // 对局中主动退出 = 认输
    a.send({ t: 'leave' });
    const u = await b.waitFor(m => m.t === 'update' && m.op === 'forfeit');
    assert.equal(u.view.over, 'p2'); assert.equal(u.view.result.reason, 'forfeit');
    await Promise.all([a.close(), b.close(), c.close()]);
  } finally { await app.close(); }
});

test('HTTP：/healthz、静态文件白名单、路径穿越与源码不可访问', async () => {
  const app = await startApp();
  try {
    const h = await getJson(app, '/healthz');
    assert.equal(h.status, 200); assert.equal(h.body.ok, true); assert.equal(h.body.turnSeconds, 60);
    const base = `http://127.0.0.1:${app.port}`;
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200); assert.match(root.headers.get('content-type'), /text\/html/);
    const eng = await fetch(`${base}/shared/engine.js`);
    assert.equal(eng.status, 200); assert.match(eng.headers.get('content-type'), /javascript/);
    for (const p of ['/server/index.js', '/package.json', '/node_modules/ws/package.json', '/logs/x.jsonl', '/..%2fpackage.json', '/assets/../server/index.js', '/.git/config']) {
      const r = await fetch(`${base}${p}`);
      assert.equal(r.status, 404, `${p} should be 404`);
    }
    const bad = await fetch(`${base}/api/replay/zzzzzzzz`);
    assert.equal(bad.status, 404);
    const post = await fetch(`${base}/healthz`, { method: 'POST' });
    assert.equal(post.status, 405);
  } finally { await app.close(); }
});
