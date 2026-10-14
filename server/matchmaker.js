// server/matchmaker.js — 房间码 + 快速匹配队列 + token→席位索引
import { randomBytes, randomInt } from 'node:crypto';
import { Room, RoomPhase } from './room.js';

export class Matchmaker {
  /** @param {object} roomOpts 透传给 Room 的配置（turnSeconds / graceMs / retentionMs / writeLog） */
  constructor(roomOpts = {}) {
    this.roomOpts = roomOpts;
    this.rooms = new Map();    // roomId → Room
    this.codes = new Map();    // code   → roomId
    this.tokens = new Map();   // token  → roomId（重连用）
    this.quickWaiting = null;  // 等人的快速匹配房 id
  }

  newToken() { return randomBytes(16).toString('hex'); }
  newRoomId() { return randomBytes(4).toString('hex'); }
  // 4 位数字房间码，保证当前未被占用
  newCode() {
    if (this.codes.size >= 9000) { throw new Error('too many rooms'); }
    for (;;) {
      const c = String(randomInt(0, 10000)).padStart(4, '0');
      if (!this.codes.has(c)) { return c; }
    }
  }

  create({ name, sock, quick = false }) {
    const room = new Room({
      ...this.roomOpts,
      id: this.newRoomId(), code: this.newCode(), seed: randomInt(0, 0x100000000), quick,
      onClose: r => this.remove(r),
    });
    this.rooms.set(room.id, room);
    this.codes.set(room.code, room.id);
    return this.seat(room, name, sock);
  }

  join({ code, name, sock }) {
    const id = this.codes.get(String(code ?? '').trim());
    const room = id ? this.rooms.get(id) : null;
    if (!room || room.phase === RoomPhase.CLOSED) { return { error: 'ROOM_NOT_FOUND' }; }
    if (room.isFull) { return { error: 'ROOM_FULL' }; }
    if (this.quickWaiting === room.id) { this.quickWaiting = null; }
    return this.seat(room, name, sock);
  }

  // 快速匹配：有人在等就进他的房，否则自己开房等
  quick({ name, sock }) {
    const waiting = this.quickWaiting ? this.rooms.get(this.quickWaiting) : null;
    if (waiting && !waiting.isFull && waiting.phase === RoomPhase.WAITING && waiting.players.p1 && waiting.players.p1.connected) {
      this.quickWaiting = null;
      return this.seat(waiting, name, sock);
    }
    const r = this.create({ name, sock, quick: true });
    this.quickWaiting = r.room.id;
    return r;
  }

  resume({ token, sock }) {
    const id = typeof token === 'string' ? this.tokens.get(token) : null;
    const room = id ? this.rooms.get(id) : null;
    if (!room || room.phase === RoomPhase.CLOSED) { return { error: 'ROOM_GONE' }; }
    const seat = room.resume(token, sock);
    if (!seat) { return { error: 'ROOM_GONE' }; }
    return { room, seat, token };
  }

  seat(room, name, sock) {
    const token = this.newToken();
    const seat = room.addPlayer({ name, token, sock });
    if (!seat) { return { error: 'ROOM_FULL' }; }
    this.tokens.set(token, room.id);
    return { room, seat, token };
  }

  remove(room) {
    this.rooms.delete(room.id);
    if (this.codes.get(room.code) === room.id) { this.codes.delete(room.code); }
    for (const seat of ['p1', 'p2']) {
      const p = room.players[seat];
      if (p) { this.tokens.delete(p.token); }
    }
    if (this.quickWaiting === room.id) { this.quickWaiting = null; }
  }

  closeAll(reason) { for (const room of [...this.rooms.values()]) { room.close(reason); } }
}
