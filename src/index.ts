import * as readline from 'node:readline';

/**
 * CLI —— **服务的瘦客户端**（v0.6 起）。
 *
 * 它不再自己跑 Agent，而是连 `POST /v1/chat` 的 SSE 流。
 * 这不是形式主义：如果 CLI 还能直接调 AgentLoop，说明服务化只是加了一层壳，
 * 核心仍与传输方式耦合。现在这个文件里**没有一行 Agent 逻辑** —— 解耦是真的。
 *
 * 用法：
 *   npm run serve   # 先起服务
 *   npm start       # 再开客户端
 */

const BASE_URL = process.env.AGENT_URL || 'http://127.0.0.1:3000';

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** 解析 SSE 字节流为事件序列 */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      const eventLine = block.split('\n').find((l) => l.startsWith('event: '));
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
      if (!eventLine || !dataLine) continue;

      yield { event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) };
    }
  }
}

async function checkServer(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (!(await checkServer())) {
    console.error(`\n❌ 连不上服务 ${BASE_URL}`);
    console.error('   请先在另一个终端启动服务：\n');
    console.error('     npm run serve\n');
    console.error('   或用 AGENT_URL 指定服务地址。\n');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const prompt = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  let sessionId: string | undefined;
  let totalCost = 0;
  let turns = 0;

  console.log('================================================');
  console.log('  好买电商 AI 客服 · CLI 客户端');
  console.log(`  服务: ${BASE_URL}`);
  console.log('  输入您的问题，输入 exit 或 quit 退出');
  console.log('================================================\n');

  while (true) {
    const input = (await prompt('👤 您: ')).trim();
    if (!input) continue;
    if (input === 'exit' || input === 'quit') break;

    const res = await fetch(`${BASE_URL}/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ message: input, session_id: sessionId }),
    });

    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
      console.log(`\n❌ ${(err as any).error?.message ?? '请求失败'}\n`);
      continue;
    }

    let streamed = '';

    for await (const { event, data } of readSse(res.body)) {
      switch (event) {
        case 'session':
          sessionId = data.session_id as string;
          break;
        case 'delta':
          if (streamed === '') process.stdout.write('\n🤖 ');
          streamed += data.text as string;
          process.stdout.write(data.text as string);
          break;
        case 'thinking':
          process.stdout.write('\n');
          break;
        case 'tool_start':
          console.log(`\n🔧 调用工具: ${data.tool}`);
          break;
        case 'tool_end':
          console.log(`   ${data.is_error ? '⚠️ ' : '✅'} 工具完成 (${data.duration_ms}ms)`);
          break;
        case 'response':
          if (streamed === '') {
            console.log(`\n🤖 ${data.content}`);
          } else if (data.content !== streamed) {
            // 服务端 afterTurn 改写过（脱敏/合规）—— 必须给准据版本
            console.log(
              `\n\n🛡️  上面的内容已被改写（脱敏/合规），以下为最终版本：\n🤖 ${data.content}`
            );
          } else {
            process.stdout.write('\n');
          }
          streamed = '';
          break;
        case 'blocked':
          console.log(`\n🛡️  已拦截 [${data.by}]：${data.reason}`);
          break;
        case 'error':
          // 错误**不走 🤖 前缀** —— 它不是客服的回答。
          // v1.2 之前服务端把 `LLM调用失败: xxx` 当回复正文返回，
          // 逐字打给用户看，用户以为客服真的这么说
          console.log(`\n❌ ${data.message}`);
          if (data.retryable) console.log('   （这是临时故障，可以再试一次）');
          break;
        case 'done':
          totalCost += (data.cost_usd as number) ?? 0;
          turns += 1;
          break;
      }
    }
    console.log('');
  }

  console.log('\n================================================');
  console.log(`  会话结束 ｜ 会话ID: ${sessionId ?? '（未创建）'}`);
  console.log(`  轮次: ${turns} ｜ 累计成本: $${totalCost.toFixed(4)}`);
  console.log('================================================\n');

  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('客户端异常:', err);
  process.exit(1);
});
