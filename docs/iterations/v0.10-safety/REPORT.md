# v0.10 迭代报告 · 文本安全检测

> 起点 `97b877b`（v0.9）｜ 用例 **344 → 390**（+46）｜ `npm run verify` exit 0
> **本版还清了 v0.4 欠的账：流式绕过输出脱敏。**

---

## 一、交付了什么

| # | 事项 | 落点 |
|---|---|---|
| 1 | 规则模型 + 输入/输出规则集 | [rules.ts](../../../src/safety/rules.ts) |
| 2 | `SafetyScanner`：扫描 → 四级裁决 | [scanner.ts](../../../src/safety/scanner.ts) |
| 3 | `StreamingRedactor`：流式感知脱敏 | [streaming-redactor.ts](../../../src/safety/streaming-redactor.ts) |
| 4 | `safety` 中间件（取代 input/output-filter）+ 审计 | [safety.mw.ts](../../../src/middleware/safety.mw.ts) |
| 5 | `AgentLoop` 的 delta 走脱敏器，收口前 flush | [agent-loop.ts](../../../src/core/agent-loop.ts) |
| 6 | SSE `safety` 事件 | [sse.ts](../../../src/server/sse.ts) |
| 7 | `safetyLag` 配置贯通 | [config.ts](../../../src/server/config.ts) |
| 8 | 修好 `bench:stream` + `scripts/` 纳入 typecheck | [bench-streaming.ts](../../../scripts/bench-streaming.ts) |

## 二、核心设计的实际结果

### ⚙️ 设计① 流式感知脱敏 —— 洞是真的，先证伪再修

这一版最重要的一个测试不是「脱敏后不泄露」，而是**它前面那半句**：

```ts
const off = await runWith('您可以拨打 13812345678 联系我们', false);
expect(off.streamed).toContain('13812345678');   // ← 洞确实存在
expect(off.reply).not.toContain('13812345678');  // ← 而返回值是干净的

const on = await runWith(text, true);
expect(on.streamed).not.toContain('13812345678');
```

中间那行是整件事的要害：**`afterTurn` 的脱敏一直是「有效」的 —— 它保护的是返回值，
而用户看的是流。** 两条路径分叉，测试只测了其中一条，于是绿了九个版本。

> 沉淀：一个能力有两条出口时，只测一条等于没测。
> 判断标准不是「有没有测这个功能」，而是「**用户实际接触的是哪条路径**」。

### ⚙️ 设计② 四级处置 —— `handoff` 不替模型说话

`block` 与 `handoff` 的差别不在严重程度，在**谁来组织语言**：

```ts
// block：整轮拦死，不调模型
if (verdict.action === 'block') return { action: 'block', reason: ... };

// handoff：照常调模型，只是往 systemAppends 里塞一句提示
ctx.systemAppends.push('## 安全提示\n...请先安抚客户情绪...再用 human_handoff 转接');
```

客户说「再不解决我就去起诉」，机械回一句「您的输入未通过安全检查」是**激化矛盾**。
真实客服场景里这类话是情绪表达而非攻击，处置方式应该是转人工，不是拒绝服务。

### ⚙️ 设计③ 审计不记原文

`SafetyMatch` 刻意**不含命中的文本**，只有 `ruleId / ruleName / index / length`：

```ts
expect(JSON.stringify(audit)).not.toContain('13812345678');
```

一个记录「我们脱敏了哪些手机号」的日志表，本身就是最好偷的那张表。
同理，SSE 的 `safety` 事件只发规则名。

## 三、实测：滞后窗口的代价，以及怎么把它降到 1ms

风险表里那条「滞后窗口吃掉 v0.4 的首块延迟收益」**真的发生了**：

```
模式                        首块延迟(中位)   全量延迟(中位)
非流式（v0.3 行为）                  613ms          613ms
流式·无脱敏（v0.4）                   22ms          609ms
流式·脱敏 lag=40（朴素实现）          297ms          613ms   ← 吃掉一半
```

朴素滞后窗口无条件压住最后 40 个字符 —— 而 40 个字符要攒够，就得等 14 个块。
**v0.4 花了一版换来的 27.9× 首块改善，被安全能力吃掉了一半。**

修法来自一个观察：**所有敏感模式都只由 `[0-9A-Za-z@._+-]` 构成。**
汉字、空格、中文标点不可能是手机号或邮箱的一部分 —— 它们一到就能放行。
于是滞后窗口只压「末尾那段连续的字母数字」，而不是无条件压 40 个字符：

```ts
private riskyTailLength(): number {
  let n = 0;
  for (let i = this.buffer.length - 1; i >= 0 && n < this.lag; i--, n++) {
    if (!ALPHABET.test(this.buffer[i])) break;   // 撞到汉字 → 前面全放
  }
  return n;
}
```

```
流式·脱敏 lag=40（v0.10 实际）        24ms          612ms   ← +1ms
```

**275ms → 1ms。** 客服回复以中文为主，绝大多数时刻窗口是空的；
代价只落在长串字母数字上（订单号、运单号会晚几十毫秒出现）。

> 这个优化能成立，靠的是**规则集的字符集是封闭的**。所以 `ALPHABET` 上写了
> 一句警告：改规则时必须同步检查它 —— 哪天加一条含中文的规则而忘了改这里，
> 就会静默漏检。这是本版引入的、真实存在的耦合，写在代码里而不是藏在脑子里。

## 四、过程中发现的问题

### 🔴 `bench:stream` 自 v0.5 起已经坏了五个版本

跑基准直接崩：`deps.session.getMessages is not a function`。
v0.5 把 `Session.create()` 改成 `await Session.create(store, ...)`，
基准脚本没跟着改 —— 而 `scripts/` **不在任何 typecheck 范围内**，
tsc 一声不响，`npm test` 也不碰它，于是坏了五个版本无人知晓。

这和 v0.3 那次「测试代码不过类型检查」是**同一个洞的第二次发作**：
当时补了 `tsconfig.test.json` 把 `tests/` 纳进来，却没想到 `scripts/` 也在外面。

处置：把 `scripts/**/*` 加进 `tsconfig.test.json` 的 include，修好脚本。
现在 `npm run typecheck` 覆盖 `src` + `tests` + `scripts` —— 仓库里已无 tsc 看不见的 TS。

> 为什么本版修它而不是记债：它是本版风险表点名要求的**测量仪器**。
> 仪器坏着就拿不到「滞后窗口代价是多少」这个验收数字。
> 这符合 ROADMAP 的当版补洞准入线 —— 不补会在本版内继续误导验收。

### 🟡 `AGENT_SAFETY_LAG=0` 差点被自己写的 falsy 判断吃掉

初版写的是 `Number(process.env.AGENT_SAFETY_LAG ?? '') || undefined`。
`Number('0')` 是 `0`，falsy，于是 `|| undefined` 把它变回缺省 —— 
**唯一一个有人会专门去设的值，恰好是唯一失效的值。** 想关掉滞后的人会发现设了没用，
而且没有任何报错。

改成显式解析，并单独一条用例钉住：

```ts
it('🔴 "0" 必须解析成 0 而不是被当成空值吃掉（那是唯一想关掉它的值）', () => {
  expect(parseSafetyLag('0')).toBe(0);
});
```

顺带把它从 `server.ts` 挪到 `server/config.ts` —— 前者在模块加载时就 `main()`，
测试一 import 就真的去连库并 `process.exit`。**纯函数不该被入口的副作用绑架。**

## 五、验收

| # | 判据 | 结果 |
|---|---|---|
| I1 | 注入 → `block`，不调模型 | ✅ `provider.calls === 0` |
| I2 | PII → `mask`，回复继续 | ✅ |
| I3 | 高危不宜拒绝 → `handoff` 注入转人工指引 | ✅ |
| I4 | 未命中 → 零改动 | ✅ 逐字符投喂输出与原文全等 |
| I5 | 跨块手机号被脱敏 | ✅ 含逐字符与 7 种切分大小 |
| I6 | 窗口内内容不提前放出 | ✅ |
| I7 | `flush()` 释放并完成脱敏 | ✅ |
| I8 | `lag=0` 等价逐块直放 | ✅（并显式记录了它漏跨块的代价） |
| I9 | **流式 delta 不再泄露 PII** | ✅ 带负向对照 |
| I10 | 审计落 session 且不含原文 | ✅ 含跨会话重建验证 |
| I11 | SSE 出现 `safety` 事件 | ✅ 红绿验证过 |
| I12 | 用例不净减（基线 344） | ✅ **390** |
| I13 | `npm run verify` exit 0 | ✅ 连跑 3 次稳定 |
| I14 | 滞后窗口首块延迟增量 < 50ms | ✅ **+1ms** |
| I15 | `AGENT_SAFETY_LAG=0` 真能关掉 | ✅ |

### 红绿验证记录

| 断掉什么 | 转红的用例 |
|---|---|
| 拆掉 `redactor` 接线 | SSE delta 已脱敏（1 条） |
| 拆掉 `onSafety` 接线 | safety 事件（2 条） |
| 不挂 redactor 跑 Loop | 负向对照断言原文确实泄露（同一用例内） |

## 六、留给后面的

| 事项 | 去向 |
|---|---|
| 误杀率度量（审计数据已就位） | v0.14 |
| 按租户配不同规则集 | v0.11 |
| 工具参数的安全检查 | v0.12 |
| 模型侧内容审核 | 不做（正则 + 分级已覆盖电商客服主要风险） |
| `ALPHABET` 与规则集的隐式耦合 | 已写进代码注释；若将来规则集变复杂，改为从规则里自动推导字符集 |
