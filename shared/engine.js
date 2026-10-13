// shared/engine.js — 炉石简化版规则引擎（浏览器 / Node 共用，ES Module）
//
// 从 hearthstone-lite.html 的 ENGINE 段抽出，卡牌数据与规则保持一致，只做三处改动：
//   1. 全局 state / uidSeq → Game 实例成员：一个房间一局，同一进程可以同时跑多局
//   2. Math.random → 可注入的种子 RNG（mulberry32）：同一种子 + 同一操作序列 = 同一终局，可回放校验
//   3. 动作入口返回 { ok, code, events }：先校验再改状态，非法操作状态不变；
//      死亡 / 亡语用显式 FIFO 事件队列结算，并产出 events 供客户端演出
//
// 引擎不碰 DOM、不碰网络、不知道"视角"——信息隐藏由 server/view.js 做。

// ===================== 卡牌数据区 =====================
// 效果全部用原语组合（damage/summon/gainMana/damageEnemyHero），新卡只加数据不加代码
export const CARD_DB = {
  MURLOC:    { name: '鱼人猎潮者', cost: 1, type: 'minion', atk: 1, hp: 1,
               text: '战吼：召唤一个1/1鱼人', battlecry: { kind: 'summon', cardId: 'MURLOC_SCOUT', count: 1 } },
  MURLOC_SCOUT: { name: '鱼人斥候', cost: 1, type: 'minion', atk: 1, hp: 1, text: '', token: true },
  BOLT:      { name: '闪电箭', cost: 1, type: 'spell', text: '造成2点伤害',
               needTarget: true, effect: { kind: 'damage', amount: 2 } },
  WOLFRIDER: { name: '狼骑兵', cost: 2, type: 'minion', atk: 3, hp: 1, text: '冲锋', charge: true },
  GUNNER:    { name: '铁炉堡火枪手', cost: 2, type: 'minion', atk: 2, hp: 2,
               text: '战吼：造成1点伤害', battlecry: { kind: 'damage', amount: 1, needTarget: true } },
  BOMBER:    { name: '疯狂的炸弹客', cost: 2, type: 'minion', atk: 3, hp: 2,
               text: '亡语：对敌方英雄造成2点伤害', deathrattle: { kind: 'damageEnemyHero', amount: 2 } },
  GRIZZLY:   { name: '铁鬃灰熊', cost: 3, type: 'minion', atk: 3, hp: 3, text: '嘲讽', taunt: true },
  HARVESTER: { name: '收割机', cost: 3, type: 'minion', atk: 4, hp: 3,
               text: '亡语：召唤一个2/1零件', deathrattle: { kind: 'summon', cardId: 'PART', count: 1 } },
  PART:      { name: '零件机器人', cost: 1, type: 'minion', atk: 2, hp: 1, text: '', token: true },
  FIREBALL:  { name: '火球术', cost: 3, type: 'spell', text: '造成4点伤害',
               needTarget: true, effect: { kind: 'damage', amount: 4 } },
  YETI:      { name: '冰风雪人', cost: 4, type: 'minion', atk: 4, hp: 5, text: '' },
  SENJIN:    { name: '森金持盾卫士', cost: 4, type: 'minion', atk: 3, hp: 5, text: '嘲讽', taunt: true },
  COIN:      { name: '幸运币', cost: 0, type: 'spell', text: '本回合获得1点法力水晶',
               effect: { kind: 'gainMana', amount: 1 }, token: true },
  RECRUIT:   { name: '白银新兵', cost: 1, type: 'minion', atk: 1, hp: 1, text: '', token: true },
};

// 双方固定同卡组：10 种 ×2 = 20 张，覆盖嘲讽/冲锋/战吼/亡语/直伤全部机制
export const DECK_LIST = ['MURLOC', 'BOLT', 'WOLFRIDER', 'GUNNER', 'BOMBER',
                          'GRIZZLY', 'HARVESTER', 'FIREBALL', 'YETI', 'SENJIN']
                          .flatMap(id => [id, id]);

// 英雄技能：每回合限一次、2 费；p1=法师直伤，p2=圣骑士召唤
export const HERO_POWER = {
  p1: { name: '火焰冲击', cost: 2, text: '造成1点伤害', needTarget: true, effect: { kind: 'damage', amount: 1 } },
  p2: { name: '白银之手', cost: 2, text: '召唤一个1/1新兵', effect: { kind: 'summon', cardId: 'RECRUIT', count: 1 } },
};

export const MAX_BOARD = 5;   // 场上随从上限
export const MAX_HAND = 8;    // 手牌上限，爆牌烧掉
export const MAX_MANA = 8;    // 法力水晶上限
export const SIDES = ['p1', 'p2'];

// 服务端拒绝非法操作时回给客户端的错误码（状态一律不变）
export const ERR = Object.freeze({
  BAD_INTENT: 'BAD_INTENT',           // 消息格式 / op 不认识
  GAME_OVER: 'GAME_OVER',             // 对局已结束
  WRONG_PHASE: 'WRONG_PHASE',         // 阶段不对（换牌阶段出牌、对局阶段换牌）
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',     // 不是你的回合
  MULLIGAN_DONE: 'MULLIGAN_DONE',     // 已经换过牌
  NOT_IN_HAND: 'NOT_IN_HAND',         // 牌不在你手里
  NO_MANA: 'NO_MANA',                 // 法力不够
  BOARD_FULL: 'BOARD_FULL',           // 场上随从已满
  NEED_TARGET: 'NEED_TARGET',         // 该牌 / 技能必须指定目标
  BAD_TARGET: 'BAD_TARGET',           // 目标不存在 / 形状不对 / 攻击自己人
  NO_MINION: 'NO_MINION',             // 攻击者不存在
  NOT_OWNER: 'NOT_OWNER',             // 攻击者不是你的随从
  NOT_READY: 'NOT_READY',             // 随从本回合不能攻击（召唤失调 / 已攻击）
  TAUNT: 'TAUNT',                     // 对方有嘲讽，必须先打嘲讽
  HERO_POWER_USED: 'HERO_POWER_USED', // 英雄技能本回合已用
});

// ===================== 工具 =====================
// mulberry32：32 位种子 PRNG，足够小、足够均匀，浏览器和 Node 结果一致
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a 32 位：给状态做稳定摘要（回放一致性校验、测试里比对"状态未变"）
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function db(x) { return CARD_DB[x.cardId || x]; }
export function other(sideId) { return sideId === 'p1' ? 'p2' : 'p1'; }
export function isSide(x) { return x === 'p1' || x === 'p2'; }
// 牌是否需要指定目标（法术目标 / 带目标的战吼）
export function needsTarget(def) { return !!(def.needTarget || (def.battlecry && def.battlecry.needTarget)); }
// 客户端高亮用的"可出"判断（不含目标）；服务端最终以 Game.playCard 的校验为准
export function cardPlayable(def, { mana, boardCount }) {
  if (mana < def.cost) { return false; }
  if (def.type === 'minion' && boardCount >= MAX_BOARD) { return false; }
  return true;
}

const ok = events => ({ ok: true, events });
const fail = code => ({ ok: false, code });

// ===================== 规则引擎（一局 = 一个 Game 实例） =====================
export class Game {
  /**
   * @param {object} [opts]
   * @param {number} [opts.seed]   32 位种子；不传则随机。种子只存服务端，不下发客户端
   * @param {object} [opts.names]  { p1, p2 } 玩家显示名
   * @param {Function} [opts.rng]  自定义随机源（测试用）
   */
  constructor(opts = {}) {
    this.seed = (opts.seed === undefined ? (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) : opts.seed) >>> 0;
    this.rng = opts.rng || mulberry32(this.seed);
    this.uidSeq = 0;
    this.events = [];
    const names = Object.assign({ p1: '玩家1', p2: '玩家2' }, opts.names || {});
    this.state = {
      turn: 0, active: 'p1', over: null, phase: 'mulligan',
      mulliganDone: { p1: false, p2: false }, log: [],
      p1: this.makeSide(names.p1),
      p2: this.makeSide(names.p2),
    };
    // 发起手牌：先手 3 / 后手 4 + 幸运币；进入换牌阶段，双方换牌完成后才 startTurn
    this.drawCards('p1', 3);
    this.drawCards('p2', 4);
    this.state.p2.hand.push({ uid: ++this.uidSeq, cardId: 'COIN' });
    this.addLog('起手换牌阶段', 'turn-mark');
    this.events = [];
  }

  // ---------- 内部工具 ----------
  emit(type, data) { this.events.push(Object.assign({ type }, data)); }
  addLog(msg, cls) { this.state.log.push({ msg, cls: cls || '' }); }
  // Fisher-Yates，随机源来自种子 RNG
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  makeSide(name) {
    return { name, heroHp: 30, mana: 0, manaMax: 0, fatigue: 0, heroPowerUsed: false,
             deck: this.shuffle(DECK_LIST.map(id => ({ uid: ++this.uidSeq, cardId: id }))),
             hand: [], board: [] };
  }
  findMinion(uid) {
    for (const sideId of SIDES) {
      const m = this.state[sideId].board.find(x => x.uid === uid);
      if (m) { return { sideId, minion: m }; }
    }
    return null;
  }
  // 目标校验：形状合法且存在。返回规范化后的目标，否则 null
  normalizeTarget(target) {
    if (!target || typeof target !== 'object') { return null; }
    if (target.type === 'hero') { return isSide(target.side) ? { type: 'hero', side: target.side } : null; }
    if (target.type === 'minion') {
      const uid = Number(target.uid);
      return Number.isInteger(uid) && this.findMinion(uid) ? { type: 'minion', uid } : null;
    }
    return null;
  }
  // 所有动作共用的前置检查
  baseCheck(sideId, phase) {
    const s = this.state;
    if (!isSide(sideId)) { return ERR.BAD_INTENT; }
    if (s.over) { return ERR.GAME_OVER; }
    if (s.phase !== phase) { return ERR.WRONG_PHASE; }
    if (phase === 'play' && s.active !== sideId) { return ERR.NOT_YOUR_TURN; }
    return null;
  }

  // ---------- 起手换牌 ----------
  // 被换的牌先抽等量新牌再洗回牌库（避免立刻抽回原牌）；幸运币不可换
  mulligan(sideId, replaceUids) {
    this.events = [];
    const err = this.baseCheck(sideId, 'mulligan');
    if (err) { return fail(err); }
    const s = this.state;
    if (s.mulliganDone[sideId]) { return fail(ERR.MULLIGAN_DONE); }
    const side = s[sideId];
    const ids = new Set(Array.isArray(replaceUids) ? replaceUids.map(Number) : []);
    const toReplace = side.hand.filter(c => ids.has(c.uid) && c.cardId !== 'COIN');
    for (const c of toReplace) { side.hand.splice(side.hand.indexOf(c), 1); }
    for (let k = 0; k < toReplace.length && side.deck.length > 0; k++) { side.hand.push(side.deck.pop()); }
    for (const c of toReplace) { side.deck.push(c); }
    this.shuffle(side.deck);
    s.mulliganDone[sideId] = true;
    this.addLog(`${side.name} 换掉 ${toReplace.length} 张起手牌`);
    this.emit('mulligan', { side: sideId, replaced: toReplace.length });
    if (s.mulliganDone.p1 && s.mulliganDone.p2) {
      s.phase = 'play';
      this.startTurn('p1');
    }
    return ok(this.events);
  }

  // ---------- 回合 ----------
  startTurn(sideId) {
    const s = this.state;
    const side = s[sideId];
    s.active = sideId;
    s.turn++;
    side.manaMax = Math.min(MAX_MANA, side.manaMax + 1);
    side.mana = side.manaMax;
    side.heroPowerUsed = false;   // 英雄技能每回合重置
    side.board.forEach(m => { m.ready = true; });
    this.addLog(`—— ${side.name} 的回合 ——`, 'turn-mark');
    this.emit('turn_start', { side: sideId, turn: s.turn, mana: side.mana, manaMax: side.manaMax });
    this.drawCards(sideId, 1);
  }

  drawCards(sideId, n) {
    const side = this.state[sideId];
    for (let i = 0; i < n; i++) {
      // 疲劳：牌库抽空后每次抽牌累加 1 点伤害
      if (side.deck.length === 0) {
        side.fatigue++;
        side.heroHp -= side.fatigue;
        this.addLog(`${side.name} 牌库已空，受到 ${side.fatigue} 点疲劳伤害`);
        this.emit('fatigue', { side: sideId, amount: side.fatigue, hp: side.heroHp });
        continue;
      }
      const card = side.deck.pop();
      // 手牌上限 8：爆牌直接烧掉
      if (side.hand.length >= MAX_HAND) {
        this.addLog(`${side.name} 手牌已满，${db(card).name} 被烧掉了`);
        this.emit('burn', { side: sideId, uid: card.uid, cardId: card.cardId });
        continue;
      }
      side.hand.push(card);
      // draw 事件带 cardId，下发给对手前由 view.eventsFor 裁掉
      this.emit('draw', { side: sideId, uid: card.uid, cardId: card.cardId });
    }
    this.checkGameOver();
  }

  // 玩家主动结束回合必须是当前行动方；服务端计时器超时调用时不传 sideId
  endTurn(sideId) {
    this.events = [];
    const s = this.state;
    if (s.over) { return fail(ERR.GAME_OVER); }
    if (s.phase !== 'play') { return fail(ERR.WRONG_PHASE); }
    if (sideId !== undefined && sideId !== null) {
      if (!isSide(sideId)) { return fail(ERR.BAD_INTENT); }
      if (s.active !== sideId) { return fail(ERR.NOT_YOUR_TURN); }
    }
    this.emit('turn_end', { side: s.active });
    this.startTurn(other(s.active));
    return ok(this.events);
  }

  // ---------- 出牌 ----------
  // 前置校验（不改状态）：null = 合法，否则错误码
  playCheck(sideId, uid, target) {
    const err = this.baseCheck(sideId, 'play');
    if (err) { return err; }
    const side = this.state[sideId];
    const card = side.hand.find(c => c.uid === uid);
    if (!card) { return ERR.NOT_IN_HAND; }
    const def = db(card);
    if (side.mana < def.cost) { return ERR.NO_MANA; }
    if (def.type === 'minion' && side.board.length >= MAX_BOARD) { return ERR.BOARD_FULL; }
    if (needsTarget(def)) {
      if (!target) { return ERR.NEED_TARGET; }
      if (!this.normalizeTarget(target)) { return ERR.BAD_TARGET; }
    }
    return null;
  }
  canPlayCard(sideId, card) {
    const err = this.baseCheck(sideId, 'play');
    if (err) { return false; }
    return cardPlayable(db(card), { mana: this.state[sideId].mana, boardCount: this.state[sideId].board.length });
  }

  playCard(sideId, uid, target) {
    this.events = [];
    uid = Number(uid);
    const err = this.playCheck(sideId, uid, target);
    if (err) { return fail(err); }
    const side = this.state[sideId];
    const idx = side.hand.findIndex(c => c.uid === uid);
    const card = side.hand[idx];
    const def = db(card);
    const tgt = needsTarget(def) ? this.normalizeTarget(target) : null;

    side.mana -= def.cost;
    side.hand.splice(idx, 1);

    if (def.type === 'minion') {
      // 入场当回合不能攻击（冲锋豁免）
      side.board.push({ uid: card.uid, cardId: card.cardId, atk: def.atk, hp: def.hp,
                        hpMax: def.hp, taunt: !!def.taunt, ready: !!def.charge });
      this.addLog(`${side.name} 打出 ${def.name}`);
      this.emit('play_minion', { side: sideId, uid: card.uid, cardId: card.cardId, target: tgt });
      if (def.battlecry) { this.resolveEffect(sideId, def.battlecry, tgt); }
    } else {
      this.addLog(`${side.name} 使用 ${def.name}`);
      this.emit('play_spell', { side: sideId, uid: card.uid, cardId: card.cardId, target: tgt });
      this.resolveEffect(sideId, def.effect, tgt);
    }
    this.resolveDeaths();
    return ok(this.events);
  }

  resolveEffect(sideId, eff, target) {
    const s = this.state;
    if (eff.kind === 'damage') {
      if (!target) { return; }
      this.applyDamage(target, eff.amount);
      return;
    }
    if (eff.kind === 'damageEnemyHero') {
      this.applyDamage({ type: 'hero', side: other(sideId) }, eff.amount);
      return;
    }
    if (eff.kind === 'summon') {
      const side = s[sideId];
      for (let i = 0; i < eff.count; i++) {
        if (side.board.length >= MAX_BOARD) { break; }
        const def = CARD_DB[eff.cardId];
        const uid = ++this.uidSeq;
        side.board.push({ uid, cardId: eff.cardId, atk: def.atk, hp: def.hp,
                          hpMax: def.hp, taunt: !!def.taunt, ready: !!def.charge });
        this.addLog(`${side.name} 召唤了 ${def.name}`);
        this.emit('summon', { side: sideId, uid, cardId: eff.cardId });
      }
      return;
    }
    if (eff.kind === 'gainMana') {
      s[sideId].mana += eff.amount;
      this.emit('mana', { side: sideId, mana: s[sideId].mana });
    }
  }

  applyDamage(target, n) {
    if (target.type === 'hero') {
      const side = this.state[target.side];
      side.heroHp -= n;
      this.addLog(`${side.name} 的英雄受到 ${n} 点伤害`);
      this.emit('damage', { target, amount: n, hp: side.heroHp });
      return;
    }
    const found = this.findMinion(target.uid);
    if (!found) { return; }
    found.minion.hp -= n;
    this.addLog(`${db(found.minion).name} 受到 ${n} 点伤害`);
    this.emit('damage', { target, amount: n, hp: found.minion.hp });
  }

  // 死亡结算：显式 FIFO 事件队列。
  // 先把所有阵亡随从移出场面并入队，再逐个结算亡语；亡语造成的新死亡继续入队，直到队列排空。
  // 禁止在伤害函数里就地删随从，全部走这里统一结算。
  resolveDeaths() {
    const queue = [];
    const collect = () => {
      for (const sideId of SIDES) {
        const side = this.state[sideId];
        const dead = side.board.filter(m => m.hp <= 0);
        if (dead.length === 0) { continue; }
        side.board = side.board.filter(m => m.hp > 0);
        for (const m of dead) { queue.push({ sideId, minion: m }); }
      }
    };
    collect();
    while (queue.length > 0) {
      const { sideId, minion } = queue.shift();
      const def = db(minion);
      this.addLog(`${def.name} 死亡`);
      this.emit('death', { side: sideId, uid: minion.uid, cardId: minion.cardId });
      if (def.deathrattle) {
        this.emit('deathrattle', { side: sideId, uid: minion.uid, cardId: minion.cardId });
        this.resolveEffect(sideId, def.deathrattle, null);
        collect();   // 亡语可能炸死新的随从（炸弹客连环）
      }
    }
    this.checkGameOver();
  }

  // ---------- 攻击 ----------
  legalAttackTargets(sideId) {
    // 嘲讽约束：对方场上有嘲讽随从时只能攻击嘲讽
    const enemyId = other(sideId);
    const taunts = this.state[enemyId].board.filter(m => m.taunt);
    if (taunts.length > 0) { return { minions: taunts.map(m => m.uid), heroes: [] }; }
    return { minions: this.state[enemyId].board.map(m => m.uid), heroes: [enemyId] };
  }

  attackCheck(sideId, attackerUid, target) {
    const err = this.baseCheck(sideId, 'play');
    if (err) { return err; }
    const found = this.findMinion(attackerUid);
    if (!found) { return ERR.NO_MINION; }
    if (found.sideId !== sideId) { return ERR.NOT_OWNER; }
    if (!found.minion.ready) { return ERR.NOT_READY; }
    const tgt = this.normalizeTarget(target);
    if (!tgt) { return ERR.BAD_TARGET; }
    const legal = this.legalAttackTargets(sideId);
    if (tgt.type === 'hero') {
      if (tgt.side === sideId) { return ERR.BAD_TARGET; }
      if (!legal.heroes.includes(tgt.side)) { return ERR.TAUNT; }
    } else {
      if (this.findMinion(tgt.uid).sideId === sideId) { return ERR.BAD_TARGET; }
      if (!legal.minions.includes(tgt.uid)) { return ERR.TAUNT; }
    }
    return null;
  }

  attack(sideId, attackerUid, target) {
    this.events = [];
    attackerUid = Number(attackerUid);
    const err = this.attackCheck(sideId, attackerUid, target);
    if (err) { return fail(err); }
    const m = this.findMinion(attackerUid).minion;
    const tgt = this.normalizeTarget(target);
    m.ready = false;
    this.emit('attack', { side: sideId, uid: attackerUid, target: tgt });
    if (tgt.type === 'hero') {
      const hero = this.state[tgt.side];
      hero.heroHp -= m.atk;
      this.addLog(`${db(m).name} 攻击英雄，造成 ${m.atk} 点伤害`);
      this.emit('damage', { target: tgt, amount: m.atk, hp: hero.heroHp });
      this.resolveDeaths();
      return ok(this.events);
    }
    // 随从互殴双方同时结算伤害
    const t = this.findMinion(tgt.uid).minion;
    t.hp -= m.atk;
    m.hp -= t.atk;
    this.addLog(`${db(m).name} 与 ${db(t).name} 交战`);
    this.emit('damage', { target: tgt, amount: m.atk, hp: t.hp });
    if (t.atk > 0) { this.emit('damage', { target: { type: 'minion', uid: m.uid }, amount: t.atk, hp: m.hp }); }
    this.resolveDeaths();
    return ok(this.events);
  }

  // ---------- 英雄技能：每回合限一次、耗 2 费，复用效果原语 + 统一死亡结算 ----------
  heroPowerCheck(sideId, target, ignoreTarget) {
    const err = this.baseCheck(sideId, 'play');
    if (err) { return err; }
    const side = this.state[sideId];
    const hp = HERO_POWER[sideId];
    if (side.heroPowerUsed) { return ERR.HERO_POWER_USED; }
    if (side.mana < hp.cost) { return ERR.NO_MANA; }
    if (!ignoreTarget && hp.needTarget) {
      if (!target) { return ERR.NEED_TARGET; }
      if (!this.normalizeTarget(target)) { return ERR.BAD_TARGET; }
    }
    return null;
  }
  canUseHeroPower(sideId) { return this.heroPowerCheck(sideId, null, true) === null; }

  useHeroPower(sideId, target) {
    this.events = [];
    const err = this.heroPowerCheck(sideId, target, false);
    if (err) { return fail(err); }
    const hp = HERO_POWER[sideId];
    const side = this.state[sideId];
    const tgt = hp.needTarget ? this.normalizeTarget(target) : null;
    side.mana -= hp.cost;
    side.heroPowerUsed = true;
    this.addLog(`${side.name} 发动英雄技能：${hp.name}`);
    this.emit('hero_power', { side: sideId, target: tgt });
    this.resolveEffect(sideId, hp.effect, tgt);
    this.resolveDeaths();
    return ok(this.events);
  }

  // ---------- 认输 / 判负（断线超时、主动退出）：由服务端调用 ----------
  forfeit(sideId, reason) {
    this.events = [];
    const s = this.state;
    if (!isSide(sideId)) { return fail(ERR.BAD_INTENT); }
    if (s.over) { return fail(ERR.GAME_OVER); }
    s.over = other(sideId);
    s.phase = 'over';
    this.addLog(`${s[sideId].name} ${reason === 'abandon' ? '掉线超时' : '退出对局'}，${s[s.over].name} 获胜！`, 'turn-mark');
    this.emit('game_over', { winner: s.over, reason: reason || 'forfeit' });
    return ok(this.events);
  }

  checkGameOver() {
    const s = this.state;
    if (s.over) { return; }
    const d1 = s.p1.heroHp <= 0;
    const d2 = s.p2.heroHp <= 0;
    if (!d1 && !d2) { return; }
    if (d1 && d2) { s.over = 'draw'; this.addLog('双方同归于尽，平局！', 'turn-mark'); }
    else if (d2) { s.over = 'p1'; this.addLog(`${s.p1.name} 获胜！`, 'turn-mark'); }
    else { s.over = 'p2'; this.addLog(`${s.p2.name} 获胜！`, 'turn-mark'); }
    s.phase = 'over';
    this.emit('game_over', { winner: s.over, reason: 'hp' });
  }

  // ---------- 统一意图入口（服务端处理 intent、日志回放共用） ----------
  apply(sideId, op, payload = {}) {
    switch (op) {
      case 'mulligan':   return this.mulligan(sideId, payload.uids);
      case 'play':       return this.playCard(sideId, payload.uid, payload.target);
      case 'attack':     return this.attack(sideId, payload.uid, payload.target);
      case 'hero_power': return this.useHeroPower(sideId, payload.target);
      case 'end_turn':   return this.endTurn(sideId);
      case 'forfeit':    return this.forfeit(sideId, payload.reason);
      default:           this.events = []; return fail(ERR.BAD_INTENT);
    }
  }

  // ---------- 快照 / 摘要 ----------
  snapshot() { return JSON.parse(JSON.stringify(this.state)); }
  // 不含日志文本的状态摘要：回放一致性校验用
  digest() {
    const { log, ...rest } = this.state;
    return fnv1a(JSON.stringify({ rest, uidSeq: this.uidSeq }));
  }

  // ===================== AI（人机 / 自测用；联机服务端不调用） =====================
  aiMulligan(sideId) {
    const side = this.state[sideId];
    const replace = side.hand.filter(c => c.cardId !== 'COIN' && db(c).cost >= 4).map(c => c.uid);
    return this.mulligan(sideId, replace).ok;
  }
  aiAct(sideId) {
    const s = this.state;
    if (s.over || s.active !== sideId) { return false; }
    if (this.aiTryPlay(sideId)) { return true; }
    if (this.aiTryHeroPower(sideId)) { return true; }
    if (this.aiTryAttack(sideId)) { return true; }
    return false;
  }
  aiTryHeroPower(sideId) {
    if (!this.canUseHeroPower(sideId)) { return false; }
    const hp = HERO_POWER[sideId];
    const enemyId = other(sideId);
    const enemy = this.state[enemyId];
    const side = this.state[sideId];
    if (hp.needTarget) {
      if (enemy.heroHp <= hp.effect.amount) { return this.useHeroPower(sideId, { type: 'hero', side: enemyId }).ok; }
      const kill = enemy.board.find(m => m.hp <= hp.effect.amount);
      if (kill) { return this.useHeroPower(sideId, { type: 'minion', uid: kill.uid }).ok; }
      return this.useHeroPower(sideId, { type: 'hero', side: enemyId }).ok;
    }
    if (side.board.length < MAX_BOARD) { return this.useHeroPower(sideId, null).ok; }
    return false;
  }
  aiTryPlay(sideId) {
    const side = this.state[sideId];
    const enemyId = other(sideId);
    const enemy = this.state[enemyId];
    const coin = side.hand.find(c => c.cardId === 'COIN');
    if (coin && side.hand.some(c => c.cardId !== 'COIN' && db(c).cost === side.mana + 1
        && (db(c).type === 'spell' || side.board.length < MAX_BOARD))) {
      return this.playCard(sideId, coin.uid, null).ok;
    }
    const spells = side.hand.filter(c => db(c).type === 'spell'
        && db(c).effect.kind === 'damage' && db(c).cost <= side.mana);
    for (const sp of spells) {
      const amount = db(sp).effect.amount;
      if (enemy.heroHp <= amount) { return this.playCard(sideId, sp.uid, { type: 'hero', side: enemyId }).ok; }
      const kills = enemy.board.filter(m => m.hp <= amount && m.atk >= 3).sort((a, b) => b.atk - a.atk);
      if (kills.length > 0) { return this.playCard(sideId, sp.uid, { type: 'minion', uid: kills[0].uid }).ok; }
    }
    const minions = side.hand.filter(c => db(c).type === 'minion' && db(c).cost <= side.mana)
                             .sort((a, b) => db(b).cost - db(a).cost);
    if (minions.length > 0 && side.board.length < MAX_BOARD) {
      const pick = minions[0];
      let target = null;
      if (db(pick).battlecry && db(pick).battlecry.needTarget) {
        const finish = enemy.board.find(m => m.hp === 1);
        target = finish ? { type: 'minion', uid: finish.uid } : { type: 'hero', side: enemyId };
      }
      return this.playCard(sideId, pick.uid, target).ok;
    }
    return false;
  }
  aiTryAttack(sideId) {
    const side = this.state[sideId];
    const enemyId = other(sideId);
    const enemy = this.state[enemyId];
    const ready = side.board.filter(m => m.ready);
    if (ready.length === 0) { return false; }
    const m = ready[0];
    const taunts = enemy.board.filter(x => x.taunt);
    const totalAtk = ready.reduce((sum, x) => sum + x.atk, 0);
    if (taunts.length === 0 && totalAtk >= enemy.heroHp) {
      return this.attack(sideId, m.uid, { type: 'hero', side: enemyId }).ok;
    }
    const pool = taunts.length > 0 ? taunts : enemy.board;
    const good = pool.filter(t => m.atk >= t.hp && t.atk < m.hp).sort((a, b) => b.atk - a.atk);
    if (good.length > 0) { return this.attack(sideId, m.uid, { type: 'minion', uid: good[0].uid }).ok; }
    if (taunts.length > 0) {
      const t = taunts.slice().sort((a, b) => a.hp - b.hp)[0];
      return this.attack(sideId, m.uid, { type: 'minion', uid: t.uid }).ok;
    }
    return this.attack(sideId, m.uid, { type: 'hero', side: enemyId }).ok;
  }
}

// 调试 / 自测：AI 对打 n 局（种子递增），返回胜率与平均回合数
export function debugAutoPlay(games, seed = 1) {
  const result = { p1: 0, p2: 0, draw: 0, avgTurn: 0 };
  let turnSum = 0;
  for (let g = 0; g < games; g++) {
    const game = new Game({ seed: seed + g });
    game.aiMulligan('p1'); game.aiMulligan('p2');
    let guard = 0;
    while (!game.state.over && guard++ < 2000) {
      if (!game.aiAct(game.state.active)) { game.endTurn(); }
    }
    result[game.state.over || 'draw']++;
    turnSum += game.state.turn;
  }
  result.avgTurn = Math.round(turnSum / games / 2 * 10) / 10;
  return result;
}
