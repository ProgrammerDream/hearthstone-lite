// server/test/bot.js — 测试用贪心机器人：只看自己的 view，产出下一条 intent
// （和真人客户端一样只知道视角信息；合法性仍由服务端裁决）
import { db, other, HERO_POWER, cardPlayable, needsTarget } from '../../shared/engine.js';

export function nextIntent(view) {
  const seat = view.seat;
  const oppSeat = other(seat);
  const me = view.me;
  const opp = view.opp;
  if (view.over) { return null; }
  if (view.phase === 'mulligan') {
    if (view.mulliganDone[seat]) { return null; }
    return { op: 'mulligan', uids: me.hand.filter(c => db(c).cost >= 4).map(c => c.uid) };
  }
  if (view.phase !== 'play' || view.active !== seat) { return null; }

  // 1. 出牌：从贵到便宜；幸运币只在能多下一张牌时用
  const playable = me.hand
    .filter(c => cardPlayable(db(c), { mana: me.mana, boardCount: me.board.length }))
    .sort((a, b) => db(b).cost - db(a).cost);
  for (const c of playable) {
    const def = db(c);
    if (c.cardId === 'COIN' && !me.hand.some(x => x.cardId !== 'COIN' && db(x).cost === me.mana + 1)) { continue; }
    let target;
    if (needsTarget(def)) {
      const amount = def.effect ? def.effect.amount : def.battlecry.amount;
      const kill = opp.board.find(m => m.hp <= amount);
      target = kill ? { type: 'minion', uid: kill.uid } : { type: 'hero', side: oppSeat };
    }
    return { op: 'play', uid: c.uid, target };
  }
  // 2. 英雄技能
  const hp = HERO_POWER[seat];
  if (!me.heroPowerUsed && me.mana >= hp.cost && (hp.needTarget || me.board.length < 5)) {
    return { op: 'hero_power', target: hp.needTarget ? { type: 'hero', side: oppSeat } : undefined };
  }
  // 3. 攻击：有嘲讽先打嘲讽，否则打脸
  const ready = me.board.find(m => m.ready);
  if (ready) {
    const taunt = opp.board.find(m => m.taunt);
    return { op: 'attack', uid: ready.uid, target: taunt ? { type: 'minion', uid: taunt.uid } : { type: 'hero', side: oppSeat } };
  }
  return { op: 'end_turn' };
}
