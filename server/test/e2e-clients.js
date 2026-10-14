// 端到端脚本：对一个正在运行的服务端，用两个 ws 客户端建房 → 加入 → 换牌 → 贪心打完一局，
// 校验 seq 连续、信息隐藏、双方视角一致、回放一致，打印摘要。部署后验收用。
//   node server/test/e2e-clients.js [ws://host:port/ws]      默认 ws://127.0.0.1:8787/ws
import assert from 'node:assert/strict';
import { pair, playGame } from './helpers.js';

const wsUrl = process.argv[2] || process.env.WS_URL || 'ws://127.0.0.1:8787/ws';
const httpBase = wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
const t0 = Date.now();

const { a, b, code, roomId } = await pair(wsUrl, { nameA: 'e2e-甲', nameB: 'e2e-乙' });
console.log(`[e2e] room=${roomId} code=${code} seats=${a.seat}/${b.seat} server=${wsUrl}`);
const r = await playGame(a, b);
assert.ok(['p1', 'p2', 'draw'].includes(r.winner), 'game must finish');
assert.equal(r.seqGaps, 0, 'seq gaps');
assert.equal(a.seq, b.seq, 'both clients saw the same number of updates');
assert.deepEqual(r.leaks, [], 'information leaks');
assert.equal(a.view.opp.heroHp, b.view.me.heroHp);
assert.equal(a.view.opp.handCount, b.view.me.hand.length);
assert.deepEqual(a.view.opp.board, b.view.me.board);
const rep = await (await fetch(`${httpBase}/api/replay/${roomId}`)).json();
assert.equal(rep.match, true, `replay mismatch: ${JSON.stringify(rep)}`);
const health = await (await fetch(`${httpBase}/healthz`)).json();
await Promise.all([a.close(), b.close()]);
console.log(JSON.stringify({
  ok: true, winner: r.winner, rounds: Math.ceil(r.engineTurn / 2), engineTurns: r.engineTurn, updates: a.seq,
  finalHp: { [a.seat]: r.hpA, [b.seat]: r.hpB }, seqGaps: r.seqGaps, leaks: r.leaks.length,
  replay: { match: rep.match, intents: rep.intents, applied: rep.applied, digest: rep.digest },
  server: { version: health.version, turnSeconds: health.turnSeconds }, ms: Date.now() - t0,
}, null, 2));
