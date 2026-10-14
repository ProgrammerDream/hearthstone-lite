# 炉石简化版 Hearthstone Lite

简化版炉石卡牌对战：人机对战 + 双人同屏（单个 HTML，零后端、双击即玩），以及 **联机对战服务端**（Node.js + WebSocket，服务器权威、信息隐藏、断线重连、日志回放）。

**在线试玩：<https://programmerdream.github.io/hearthstone-lite/>**

| 对局 | 起手换牌 |
|---|---|
| ![对局画面](docs/screenshot-battle.png) | ![起手换牌](docs/screenshot-mulligan.png) |

## 玩法

- 双方 30 血、20 张固定同卡组、法力水晶每回合 +1（上限 8）、场上随从最多 5 个
- 关键词：**嘲讽 / 冲锋 / 战吼 / 亡语** + 直伤法术，死亡结算支持亡语连锁
- **英雄技能**（每回合一次，2 费）：玩家=法师·火焰冲击（造成 1 点伤害），电脑=圣骑士·白银之手（召唤 1/1 新兵）
- **起手换牌**：先手 3 张 / 后手 4 张 + 幸运币，可任选替换一次
- 后手补偿：多抽 1 张 + 幸运币；牌库抽空进入疲劳
- AI：贪心策略（斩杀检查 → 解场/铺场 → 有利交换否则打脸），与玩家走完全相同的动作入口

## 联机对战（服务端，`feat/server-mvp`）

两个浏览器窗口在线对战，所有规则在服务端结算，客户端只发"操作意图"。

```
shared/engine.js      规则引擎（从单文件 ENGINE 段抽出）：Game 类、种子 RNG、校验返回错误码、事件队列。浏览器 / Node 共用
server/index.js       HTTP 静态服务 + WebSocket(/ws) + /healthz /api/replay/:roomId /api/stats
server/room.js        房间：席位、状态机 waiting→mulligan→playing→over、seq、回合计时、断线宽限、append-only 日志
server/matchmaker.js  4 位房间码 + 快速匹配队列 + 重连 token
server/view.js        信息隐藏：viewFor(seat) 只给对手手牌 / 牌库张数；eventsFor 裁掉对手抽到的牌
server/replay.js      用同一种子重放日志里的 intent，比对终局摘要
server/test/          node:test：引擎单测 + 两个 ws 客户端端到端打完一局 + 重连 / 超时 / 匹配 / 静态白名单
online.html           联机客户端（复用原卡面 CSS）
deploy/               systemd unit + 部署脚本
```

### 面试要讲的服务端设计点

| # | 设计点 | 实现 |
|---|---|---|
| 1 | 服务器权威 | 客户端只发 `{t:'intent', op, uid, target}`；`Game.playCard/attack/useHeroPower/endTurn` 先校验（回合、阶段、法力、牌在手、目标存在且合法、嘲讽、召唤失调、技能次数）再改状态，非法返回 `error{code}` 且状态 / seq 不变 |
| 2 | 随机与信息隐藏 | 洗牌（Fisher-Yates）、抽牌都在服务端，每局一个 32 位种子（mulberry32），种子只进服务端日志；`viewFor` 对手手牌只给张数、双方牌库只给张数 |
| 3 | 对局状态机 | 房间：`waiting → mulligan → playing → over → closed`；引擎：`mulligan → play（回合开始 抽牌 / 法力+1 → 行动 → 回合结束）→ over` |
| 4 | 房间与匹配 | 创建房间得 4 位房间码，对手输入加入；`quick` 快速匹配，凑够两人自动开局；满员拒绝 |
| 5 | 状态同步 | 每次成功结算 `seq+1`，向双方分别广播 `{t:'update', seq, actor, op, events, view}`；客户端发现 seq 不连续发 `sync` 拿完整 `snapshot` |
| 6 | 断线重连 | 入座发 `token`（客户端存 localStorage）；断线后席位保留 60 秒，对手看到"对方掉线"；`resume{token}` 下发完整快照；超时判负 |
| 7 | 回合计时 | 服务端每回合 `TURN_SECONDS`（默认 75）秒计时，超时自动结束回合（换牌阶段超时视为不换）；只下发 `turnDeadline` 时间戳，客户端只负责显示 |
| 8 | 对局日志 | 房间内 append-only 记录每条 intent（含被拒的），结束写 `logs/<roomId>.jsonl`；`GET /api/replay/:roomId` 用同一种子重放，比对终局摘要 |
| 9 | 连锁结算 | 死亡 / 亡语用显式 FIFO 事件队列（炸弹客亡语炸脸、收割机亡语召唤），同时产出 events 供客户端演出 |

### 协议（WebSocket JSON，`/ws`）

- 客户端 → 服务端：`create{name}` / `join{code,name}` / `quick{name}` / `resume{token}` / `intent{op:'mulligan'|'play'|'attack'|'hero_power'|'end_turn', uid?, uids?, target?, reqId?}` / `sync` / `leave` / `ping`
- 服务端 → 客户端：`hello` / `joined{roomId,code,seat,token,waiting}` / `snapshot{seq,view}` / `update{seq,actor,op,events,view}` / `error{code,reqId}` / `opponent{status,graceUntil}` / `room_closed{roomId,reason}` / `pong`
- `target`：`{type:'hero', side:'p1'|'p2'}` 或 `{type:'minion', uid}`

### 运行

```bash
npm ci
npm test                                   # 引擎单测 + 服务端端到端（两个 ws 客户端打完一局）
PORT=8787 TURN_SECONDS=75 npm start        # http://localhost:8787/  （联机）  http://localhost:8787/index.html（单机）
node server/test/e2e-clients.js ws://127.0.0.1:8787/ws   # 对运行中的服务端跑一局，打印摘要
```

部署（Ubuntu + systemd）：`bash deploy/deploy.sh`，服务名 `hearthstone-lite`，监听 `0.0.0.0:8787`。测试直接使用退出码作为门禁，任何测试失败都会在服务重启之前停止；不得以 TAP/spec 文本匹配判断成功。用 `bash deploy/test-gate.sh` 验证失败不重启及不同输出格式下的成功路径。

### 双人演示步骤

1. 用两个不同的浏览器配置，或普通窗口 + 无痕窗口，各打开服务端的 `/online.html`。同一配置双标签共享 localStorage 重连 token，会把另一个标签的连接顶掉（4001）。
2. 玩家 A 创建房间，将四位房间码交给玩家 B；B 输入房间码加入。
3. 双方确认换牌，轮流出牌、攻击或结束回合，直至出现胜负。
4. 对局中刷新其中一个窗口，可验证 token 重连；结束后选择“再来一局”，创建/加入新房。
5. 离房时服务端解绑旧 socket；客户端只处理当前 roomId 的关闭通知，旧房清理不会清空新局。

服务启停：`sudo systemctl stop hearthstone-lite` / `sudo systemctl restart hearthstone-lite`。工作树 SHA、运行进程、healthz、完整 WS 对局和浏览器对局应分别核对；仅测试通过不等于上线验收通过。

### MVP 已知限制

房间和重连席位在内存中，服务重启会结束当前对局；终局日志写入服务端 logs。32 位种子与公开 PRNG 仍存在离线推断隐藏牌的设计风险，进行中的 replay digest 会帮助验证猜测；未完成攻击验证及 RNG 加固。本项目适合作品演示，尚未验证高并发、长期稳定性或生产级反作弊。

## 本地运行

下载 [`index.html`](index.html)（或 `hearthstone-lite.dist.html`，同一文件）双击打开即可，所有插画已内联，无需联网。

开发版为 `hearthstone-lite.html` + `assets/art/`（原始 768² 插画）。

## 技术

- **单文件架构**：卡牌数据 / 纯函数规则引擎 / AI / UI / 动画层 五区分层，引擎不碰 DOM
- **插画**：本地 Stable Diffusion（Forge + DreamShaper XL v2.1 Turbo）批量生成，提示词与种子见 [`assets-gen/card-art.json`](assets-gen/card-art.json)，`gen-art.ps1` 一键重出
- **卡框**：纯 CSS/SVG，`:has(.catk)` 自动区分随从（暖木金框）与法术（尖顶奥术紫框），数值文字全部代码渲染保证清晰
- **动画层**：monkey-patch 引擎动作入口 → 状态快照 diff 派生事件流 → 串行动画队列逐个演出（AoE 逐个碎裂）→ 队列排空后一次全量渲染对齐，引擎零改动
- **音效**：WebAudio 现场合成，无音频文件
- **构建**：`assets-gen/build-inline.ps1` 把插画降采样转 JPEG data URI 内联，产出 1.1MB 自包含单文件

设计文档：[一期（规则与引擎）](炉石简化版设计方案.md) · [二期（美术与动效）](炉石二期实现方案.md) · [三期（玩法深度）](炉石三期实现方案.md)

## 声明

本项目为个人学习作品（AI 辅助编程练习），非商用。卡牌名称借用自《炉石传说》以便理解，插画为本地 AI 生成，与暴雪娱乐无关。
