// server/view.js — 信息隐藏：把服务端完整状态裁成"某个席位能看到的视角"
//
// 对手只给手牌张数、牌库张数；自己的牌库顺序也不下发（只给张数）；种子永远不出服务端。
// events 同理：对手 draw 事件只保留"抽了一张"，不带 cardId / uid。
import { other } from '../shared/engine.js';

const publicSide = side => ({
  name: side.name,
  heroHp: side.heroHp,
  mana: side.mana,
  manaMax: side.manaMax,
  fatigue: side.fatigue,
  heroPowerUsed: side.heroPowerUsed,
  deckCount: side.deck.length,
  board: side.board.map(m => ({ ...m })),
});

/**
 * @param {import('../shared/engine.js').Game} game
 * @param {'p1'|'p2'} seat   观看者席位
 * @param {object} [extra]   房间层附加字段（turnDeadline / now / players / result …）
 */
export function viewFor(game, seat, extra = {}) {
  const s = game.state;
  const me = s[seat];
  const opp = s[other(seat)];
  return {
    seat,
    phase: s.phase,              // mulligan | play | over
    turn: s.turn,
    active: s.active,
    over: s.over,                // null | 'p1' | 'p2' | 'draw'
    mulliganDone: { ...s.mulliganDone },
    me: { ...publicSide(me), hand: me.hand.map(c => ({ uid: c.uid, cardId: c.cardId })) },
    opp: { ...publicSide(opp), handCount: opp.hand.length },
    log: s.log.slice(-30),
    ...extra,
  };
}

// 按席位裁剪事件：对手抽到什么牌不可见
export function eventsFor(events, seat) {
  return (events || []).map(e => {
    if (e.type === 'draw' && e.side !== seat) { return { type: 'draw', side: e.side }; }
    return e;
  });
}
