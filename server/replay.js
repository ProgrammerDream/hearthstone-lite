// server/replay.js — 对局日志回放：用同一种子把成功的 intent 按序重放，比对终局摘要
import { Game } from '../shared/engine.js';

// 引擎认识的操作（服务端产生的 join/disconnect/resume/start/game_over 等只是日志，不改规则状态）
const ENGINE_OPS = new Set(['mulligan', 'play', 'attack', 'hero_power', 'end_turn', 'forfeit']);

/**
 * @param {Array<object>} entries 房间日志（Room.log 或 logs/<roomId>.jsonl 每行一条）
 * @returns {{applied:number, failed:number, digest:string, recordedDigest:string|null, match:boolean|null, over:any, turn:number}}
 */
export function replayEntries(entries) {
  const start = entries.find(e => e.op === 'start');
  if (!start) { throw new Error('log has no start entry'); }
  const game = new Game({ seed: start.payload.seed, names: start.payload.names });
  let applied = 0;
  let failed = 0;
  for (const e of entries) {
    if (!ENGINE_OPS.has(e.op) || !e.ok) { continue; }
    const r = game.apply(e.seat, e.op, e.payload || {});
    if (r.ok) { applied++; } else { failed++; }
  }
  const end = entries.find(e => e.op === 'game_over');
  const recordedDigest = end ? end.payload.digest : null;
  const digest = game.digest();
  return {
    applied, failed, digest, recordedDigest,
    match: recordedDigest ? recordedDigest === digest : null,
    over: game.state.over, turn: game.state.turn,
  };
}

export function parseJsonl(text) {
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}
