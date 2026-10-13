// 规则引擎单测：确定性、合法性校验（非法操作状态不变）、信息隐藏、事件队列、回放一致性
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, ERR, CARD_DB, HERO_POWER, MAX_BOARD, db, other, debugAutoPlay } from '../../shared/engine.js';
import { viewFor, eventsFor } from '../view.js';
import { replayEntries } from '../replay.js';

// 跳过换牌、进入 p1 首回合
function started(seed = 1) {
  const g = new Game({ seed });
  g.mulligan('p1', []); g.mulligan('p2', []);
  return g;
}
// 给某一方手里塞一张指定牌（测试专用，直接改状态）
function give(g, side, cardId) {
  const uid = ++g.uidSeq;
  g.state[side].hand.push({ uid, cardId });
  return uid;
}
function summon(g, side, cardId, extra = {}) {
  const def = CARD_DB[cardId];
  const uid = ++g.uidSeq;
  g.state[side].board.push({ uid, cardId, atk: def.atk, hp: def.hp, hpMax: def.hp, taunt: !!def.taunt, ready: true, ...extra });
  return uid;
}
// 断言：一次非法操作返回指定错误码，并且状态摘要 / 快照完全不变
function assertRejected(g, fn, code) {
  const before = g.digest();
  const snap = g.snapshot();
  const r = fn();
  assert.equal(r.ok, false, `expected rejection ${code}, got ok`);
  assert.equal(r.code, code);
  assert.equal(g.digest(), before, 'digest changed after rejected intent');
  assert.deepEqual(g.snapshot(), snap, 'state changed after rejected intent');
}

test('同一种子 → 同样的洗牌、起手和 uid 序列（确定性）', () => {
  const a = new Game({ seed: 12345 });
  const b = new Game({ seed: 12345 });
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.equal(a.digest(), b.digest());
  const c = new Game({ seed: 54321 });
  assert.notEqual(a.digest(), c.digest());
});

test('开局：先手 3 张、后手 4 张 + 幸运币，牌库各 20-起手，阶段 mulligan', () => {
  const g = new Game({ seed: 7 });
  assert.equal(g.state.phase, 'mulligan');
  assert.equal(g.state.p1.hand.length, 3);
  assert.equal(g.state.p2.hand.length, 5);
  assert.equal(g.state.p2.hand.at(-1).cardId, 'COIN');
  assert.equal(g.state.p1.deck.length, 17);
  assert.equal(g.state.p2.deck.length, 16);
  // 两副牌库各自都是完整的 20 张卡组（各 10 种 ×2）
  for (const s of ['p1', 'p2']) {
    const ids = [...g.state[s].deck, ...g.state[s].hand].filter(c => c.cardId !== 'COIN').map(c => c.cardId).sort();
    assert.deepEqual(ids, ['BOLT', 'BOLT', 'BOMBER', 'BOMBER', 'FIREBALL', 'FIREBALL', 'GRIZZLY', 'GRIZZLY', 'GUNNER', 'GUNNER',
                           'HARVESTER', 'HARVESTER', 'MURLOC', 'MURLOC', 'SENJIN', 'SENJIN', 'WOLFRIDER', 'WOLFRIDER', 'YETI', 'YETI']);
  }
});

test('换牌：换掉的牌回牌库、手牌张数不变、幸运币不可换、换过不能再换、对局阶段不能换', () => {
  const g = new Game({ seed: 3 });
  const p1Hand = g.state.p1.hand.map(c => c.uid);
  const r = g.mulligan('p1', [p1Hand[0], p1Hand[1]]);
  assert.equal(r.ok, true);
  assert.equal(g.state.p1.hand.length, 3);
  assert.ok(!g.state.p1.hand.some(c => c.uid === p1Hand[0]));
  assert.ok(g.state.p1.deck.some(c => c.uid === p1Hand[0]), '换掉的牌应回到牌库');
  assert.equal(g.state.p1.deck.length, 17);
  assertRejected(g, () => g.mulligan('p1', []), ERR.MULLIGAN_DONE);
  // 幸运币换不掉
  const coin = g.state.p2.hand.find(c => c.cardId === 'COIN');
  g.mulligan('p2', [coin.uid]);
  assert.ok(g.state.p2.hand.some(c => c.cardId === 'COIN'));
  assert.equal(g.state.phase, 'play');
  assert.equal(g.state.active, 'p1');
  assert.equal(g.state.turn, 1);
  assert.equal(g.state.p1.mana, 1);
  assert.equal(g.state.p1.hand.length, 4, '首回合抽 1 张');
  assertRejected(g, () => g.mulligan('p1', []), ERR.WRONG_PHASE);
});

test('换牌阶段不能出牌 / 攻击 / 结束回合', () => {
  const g = new Game({ seed: 3 });
  const uid = g.state.p1.hand[0].uid;
  assertRejected(g, () => g.playCard('p1', uid, null), ERR.WRONG_PHASE);
  assertRejected(g, () => g.endTurn('p1'), ERR.WRONG_PHASE);
  assertRejected(g, () => g.useHeroPower('p1', { type: 'hero', side: 'p2' }), ERR.WRONG_PHASE);
});

test('服务器权威校验：不是你的回合 / 牌不在手里 / 法力不够 / 缺目标 / 坏目标 / 场满 —— 全部拒绝且状态不变', () => {
  const g = started(11);
  // p2 想在 p1 回合出牌
  const p2Card = g.state.p2.hand[0].uid;
  assertRejected(g, () => g.playCard('p2', p2Card, null), ERR.NOT_YOUR_TURN);
  assertRejected(g, () => g.endTurn('p2'), ERR.NOT_YOUR_TURN);
  // p1 打 p2 手里的牌
  assertRejected(g, () => g.playCard('p1', p2Card, null), ERR.NOT_IN_HAND);
  assertRejected(g, () => g.playCard('p1', 99999, null), ERR.NOT_IN_HAND);
  // 1 费回合打 3 费火球
  const fb = give(g, 'p1', 'FIREBALL');
  assertRejected(g, () => g.playCard('p1', fb, { type: 'hero', side: 'p2' }), ERR.NO_MANA);
  // 闪电箭不给目标 / 给不存在的随从 / 给坏形状
  const bolt = give(g, 'p1', 'BOLT');
  assertRejected(g, () => g.playCard('p1', bolt, null), ERR.NEED_TARGET);
  assertRejected(g, () => g.playCard('p1', bolt, { type: 'minion', uid: 4242 }), ERR.BAD_TARGET);
  assertRejected(g, () => g.playCard('p1', bolt, { type: 'hero', side: 'p9' }), ERR.BAD_TARGET);
  assertRejected(g, () => g.playCard('p1', bolt, { type: 'banana' }), ERR.BAD_TARGET);
  assertRejected(g, () => g.playCard('p1', bolt, 'p2'), ERR.BAD_TARGET);
  // 场满
  for (let i = 0; i < MAX_BOARD; i++) { summon(g, 'p1', 'MURLOC_SCOUT'); }
  const murloc = give(g, 'p1', 'MURLOC');
  assertRejected(g, () => g.playCard('p1', murloc, null), ERR.BOARD_FULL);
  // 未知 op
  assertRejected(g, () => g.apply('p1', 'hack', {}), ERR.BAD_INTENT);
  assertRejected(g, () => g.apply('p3', 'end_turn', {}), ERR.BAD_INTENT);
});

test('出牌成功：扣法力、离手入场、召唤失调；冲锋可立即攻击', () => {
  const g = started(5);
  g.state.p1.mana = 10;
  const yeti = give(g, 'p1', 'YETI');
  const r = g.playCard('p1', yeti, null);
  assert.equal(r.ok, true);
  assert.equal(g.state.p1.mana, 6);
  assert.ok(!g.state.p1.hand.some(c => c.uid === yeti));
  const m = g.state.p1.board.find(x => x.uid === yeti);
  assert.equal(m.ready, false, '普通随从入场当回合不能攻击');
  assert.ok(r.events.some(e => e.type === 'play_minion' && e.uid === yeti));
  assertRejected(g, () => g.attack('p1', yeti, { type: 'hero', side: 'p2' }), ERR.NOT_READY);
  const wolf = give(g, 'p1', 'WOLFRIDER');
  g.playCard('p1', wolf, null);
  const r2 = g.attack('p1', wolf, { type: 'hero', side: 'p2' });
  assert.equal(r2.ok, true);
  assert.equal(g.state.p2.heroHp, 27);
  assertRejected(g, () => g.attack('p1', wolf, { type: 'hero', side: 'p2' }), ERR.NOT_READY);
});

test('攻击校验：嘲讽必须先打、不能打自己人、不能用对手的随从、目标必须存在', () => {
  const g = started(8);
  const mine = summon(g, 'p1', 'YETI');
  const taunt = summon(g, 'p2', 'GRIZZLY');
  const soft = summon(g, 'p2', 'MURLOC_SCOUT');
  assertRejected(g, () => g.attack('p1', mine, { type: 'hero', side: 'p2' }), ERR.TAUNT);
  assertRejected(g, () => g.attack('p1', mine, { type: 'minion', uid: soft }), ERR.TAUNT);
  assertRejected(g, () => g.attack('p1', mine, { type: 'hero', side: 'p1' }), ERR.BAD_TARGET);
  assertRejected(g, () => g.attack('p1', taunt, { type: 'hero', side: 'p1' }), ERR.NOT_OWNER);
  assertRejected(g, () => g.attack('p1', 777, { type: 'hero', side: 'p2' }), ERR.NO_MINION);
  assertRejected(g, () => g.attack('p1', mine, { type: 'minion', uid: 777 }), ERR.BAD_TARGET);
  assertRejected(g, () => g.attack('p1', mine, {}), ERR.BAD_TARGET);
  const r = g.attack('p1', mine, { type: 'minion', uid: taunt });
  assert.equal(r.ok, true);
  assert.ok(!g.state.p2.board.some(m => m.uid === taunt), '灰熊 3/3 被 4 攻击杀');
  assert.equal(g.state.p1.board.find(m => m.uid === mine).hp, 2, '雪人吃 3 伤');
  assert.ok(r.events.some(e => e.type === 'death' && e.uid === taunt));
});

test('英雄技能：每回合一次、2 费、需要目标的必须给目标', () => {
  const g = started(9);
  g.state.p1.mana = 3;
  assertRejected(g, () => g.useHeroPower('p1', null), ERR.NEED_TARGET);
  assertRejected(g, () => g.useHeroPower('p1', { type: 'minion', uid: 1 }), ERR.BAD_TARGET);
  const r = g.useHeroPower('p1', { type: 'hero', side: 'p2' });
  assert.equal(r.ok, true);
  assert.equal(g.state.p2.heroHp, 29);
  assert.equal(g.state.p1.mana, 1);
  assertRejected(g, () => g.useHeroPower('p1', { type: 'hero', side: 'p2' }), ERR.HERO_POWER_USED);
  g.endTurn('p1');
  g.state.p2.mana = 1;
  assertRejected(g, () => g.useHeroPower('p2', null), ERR.NO_MANA);
  g.state.p2.mana = 2;
  const r2 = g.useHeroPower('p2', null);
  assert.equal(r2.ok, true);
  assert.equal(g.state.p2.board.at(-1).cardId, 'RECRUIT');
});

test('事件队列：亡语连锁（炸弹客亡语炸脸、收割机亡语召唤零件）按 FIFO 结算，events 有序', () => {
  const g = started(13);
  g.state.p1.mana = 10;
  const bomber = summon(g, 'p2', 'BOMBER');       // 3/2，亡语对敌方英雄（p1）造成 2 点
  const harvester = summon(g, 'p2', 'HARVESTER'); // 4/3，亡语召唤 2/1 零件
  const fb = give(g, 'p1', 'FIREBALL');
  const r = g.playCard('p1', fb, { type: 'minion', uid: bomber });
  assert.equal(r.ok, true);
  assert.equal(g.state.p1.heroHp, 28, '炸弹客亡语炸 p1 英雄 2 点');
  const types = r.events.map(e => e.type);
  assert.deepEqual(types, ['play_spell', 'damage', 'death', 'deathrattle', 'damage']);
  const fb2 = give(g, 'p1', 'FIREBALL');
  const r2 = g.playCard('p1', fb2, { type: 'minion', uid: harvester });
  assert.ok(r2.events.some(e => e.type === 'summon' && e.cardId === 'PART'));
  assert.equal(g.state.p2.board.length, 1);
  assert.equal(g.state.p2.board[0].cardId, 'PART');
});

test('战吼：火枪手需要目标并造成 1 点伤害；鱼人召唤 1/1', () => {
  const g = started(21);
  g.state.p1.mana = 10;
  const gunner = give(g, 'p1', 'GUNNER');
  assertRejected(g, () => g.playCard('p1', gunner, null), ERR.NEED_TARGET);
  const r = g.playCard('p1', gunner, { type: 'hero', side: 'p2' });
  assert.equal(r.ok, true);
  assert.equal(g.state.p2.heroHp, 29);
  const murloc = give(g, 'p1', 'MURLOC');
  g.playCard('p1', murloc, null);
  assert.equal(g.state.p1.board.filter(m => m.cardId === 'MURLOC_SCOUT').length, 1);
});

test('回合流转：法力 +1（上限 8）、抽 1 张、随从就绪、技能重置；疲劳伤害；手牌满烧牌', () => {
  const g = started(2);
  for (let i = 0; i < 20; i++) { g.endTurn(g.state.active); }
  assert.equal(g.state.p1.manaMax, 8);
  assert.equal(g.state.p2.manaMax, 8);
  // 抽空牌库后疲劳递增
  const g2 = started(2);
  g2.state.p1.deck = [];
  g2.state.p1.hand = [];
  g2.endTurn('p1'); g2.endTurn('p2');   // p1 回合开始抽牌 → 疲劳 1
  assert.equal(g2.state.p1.fatigue, 1);
  assert.equal(g2.state.p1.heroHp, 29);
  g2.endTurn('p1'); g2.endTurn('p2');
  assert.equal(g2.state.p1.fatigue, 2);
  assert.equal(g2.state.p1.heroHp, 27);
  // 爆牌
  const g3 = started(2);
  g3.state.p1.hand = Array.from({ length: 8 }, () => ({ uid: ++g3.uidSeq, cardId: 'YETI' }));
  const deckBefore = g3.state.p1.deck.length;
  g3.endTurn('p1'); const r = g3.endTurn('p2');
  assert.equal(g3.state.p1.hand.length, 8);
  assert.equal(g3.state.p1.deck.length, deckBefore - 1);
  assert.ok(r.events.some(e => e.type === 'burn'));
});

test('胜负判定：英雄血量 ≤0 结束，之后任何操作被拒；认输 / 判负', () => {
  const g = started(4);
  const wolf = summon(g, 'p1', 'WOLFRIDER');
  g.state.p2.heroHp = 3;
  const r = g.attack('p1', wolf, { type: 'hero', side: 'p2' });
  assert.equal(r.ok, true);
  assert.equal(g.state.over, 'p1');
  assert.equal(g.state.phase, 'over');
  assert.ok(r.events.some(e => e.type === 'game_over' && e.winner === 'p1'));
  assertRejected(g, () => g.endTurn('p1'), ERR.GAME_OVER);
  assertRejected(g, () => g.forfeit('p1'), ERR.GAME_OVER);
  const g2 = started(4);
  const r2 = g2.apply('p2', 'forfeit', { reason: 'abandon' });
  assert.equal(r2.ok, true);
  assert.equal(g2.state.over, 'p1');
});

test('viewFor：对手手牌只给张数，牌库只给张数，没有种子；自己手牌完整', () => {
  const g = started(6);
  const v1 = viewFor(g, 'p1', { turnDeadline: 123 });
  const v2 = viewFor(g, 'p2');
  const text = JSON.stringify(v1);
  assert.equal(v1.seat, 'p1');
  assert.equal(v1.me.hand.length, g.state.p1.hand.length);
  assert.equal(v1.opp.hand, undefined, '对手手牌不下发');
  assert.equal(v1.opp.handCount, g.state.p2.hand.length);
  assert.equal(v1.me.deck, undefined, '自己的牌库顺序也不下发');
  assert.equal(v1.opp.deck, undefined);
  assert.equal(v1.me.deckCount, g.state.p1.deck.length);
  assert.ok(!('seed' in v1) && !text.includes('"seed"'), '种子不出现在视角里');
  assert.ok(!text.includes('"rng"'));
  // 对手手牌里的 cardId 不应出现在 p1 的视角文本中（排除公共信息：日志、场面、自己手牌）
  const v1NoLog = { ...v1, log: undefined };
  const t = JSON.stringify(v1NoLog);
  const oppSecretUids = g.state.p2.hand.map(c => `"uid":${c.uid}`);
  for (const s of oppSecretUids) { assert.ok(!t.includes(s), `对手手牌 uid 泄露: ${s}`); }
  assert.equal(v1.turnDeadline, 123);
  assert.equal(v2.me.hand.length, g.state.p2.hand.length);
  // 视角是拷贝，不是引用：改视角不影响状态
  v1.me.board.push({ uid: 1 }); v1.me.hand.length = 0;
  assert.equal(g.state.p1.board.length, 0);
  assert.ok(g.state.p1.hand.length > 0);
});

test('eventsFor：对手抽牌事件不带 cardId / uid，自己的带', () => {
  const events = [{ type: 'draw', side: 'p1', uid: 5, cardId: 'YETI' }, { type: 'draw', side: 'p2', uid: 6, cardId: 'BOLT' }, { type: 'turn_start', side: 'p2' }];
  const forP1 = eventsFor(events, 'p1');
  assert.deepEqual(forP1[0], { type: 'draw', side: 'p1', uid: 5, cardId: 'YETI' });
  assert.deepEqual(forP1[1], { type: 'draw', side: 'p2' });
  assert.deepEqual(forP1[2], { type: 'turn_start', side: 'p2' });
});

test('回放一致性（脚本化 intent）：record → replayEntries 摘要一致，并能检出被篡改的日志', () => {
  const seed = 2024;
  const g = new Game({ seed, names: { p1: 'A', p2: 'B' } });
  const entries = [{ op: 'start', ok: true, payload: { seed, names: { p1: 'A', p2: 'B' } } }];
  const record = (seat, op, payload) => { const r = g.apply(seat, op, payload); entries.push({ seat, op, payload, ok: r.ok, code: r.code }); return r; };
  record('p1', 'mulligan', { uids: [g.state.p1.hand[0].uid] });
  record('p2', 'mulligan', { uids: [] });
  let guard = 0;
  while (!g.state.over && guard++ < 400) {
    const seat = g.state.active;
    const side = g.state[seat];
    const enemy = other(seat);
    const playable = side.hand.filter(c => db(c).cost <= side.mana && (db(c).type === 'spell' || side.board.length < MAX_BOARD));
    if (playable.length) {
      const c = playable[0];
      const def = db(c);
      const needT = def.needTarget || (def.battlecry && def.battlecry.needTarget);
      record(seat, 'play', { uid: c.uid, target: needT ? { type: 'hero', side: enemy } : undefined });
      continue;
    }
    if (!side.heroPowerUsed && side.mana >= 2) {
      record(seat, 'hero_power', { target: HERO_POWER[seat].needTarget ? { type: 'hero', side: enemy } : undefined });
      continue;
    }
    const ready = side.board.find(m => m.ready);
    if (ready) {
      const taunt = g.state[enemy].board.find(m => m.taunt);
      record(seat, 'attack', { uid: ready.uid, target: taunt ? { type: 'minion', uid: taunt.uid } : { type: 'hero', side: enemy } });
      continue;
    }
    // 掺一条非法操作：对手在非自己回合结束回合 → 记为 ok:false，回放时应被跳过
    record(enemy, 'end_turn', {});
    record(seat, 'end_turn', {});
  }
  assert.ok(g.state.over, '脚本应打完一局');
  entries.push({ op: 'game_over', ok: true, payload: { winner: g.state.over, digest: g.digest() } });
  const r = replayEntries(entries);
  assert.equal(r.match, true);
  assert.equal(r.digest, g.digest());
  assert.equal(r.failed, 0);
  assert.equal(r.over, g.state.over);
  // 篡改一条 intent（把一次攻击目标改掉）→ 摘要不一致
  const tampered = entries.map(e => ({ ...e, payload: e.payload ? JSON.parse(JSON.stringify(e.payload)) : e.payload }));
  const atk = tampered.find(e => e.op === 'attack' && e.ok && e.payload.target.type === 'hero');
  assert.ok(atk);
  atk.payload.target = { type: 'hero', side: atk.seat };   // 改成打自己 → 回放时被拒
  const r2 = replayEntries(tampered);
  assert.equal(r2.match, false);
  assert.ok(r2.failed >= 1);
});

test('AI 自对弈 50 局不崩、都能分出胜负', () => {
  const r = debugAutoPlay(50, 1000);
  assert.equal(r.p1 + r.p2 + r.draw, 50);
  assert.ok(r.avgTurn > 3 && r.avgTurn < 60, `avgTurn=${r.avgTurn}`);
});
