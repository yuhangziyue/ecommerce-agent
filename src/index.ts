import * as readline from 'node:readline';
import * as path from 'node:path';
import { AgentLoop, type EventHandler, type ConfirmHandler } from './core/agent-loop.js';
import { Session } from './core/session.js';
import { TokenTracker } from './core/token-tracker.js';
import { SYSTEM_PROMPT } from './prompts/system-prompt.js';
import { buildToolRegistry } from './tools/index.js';
import { buildDefaultPipeline } from './middleware/index.js';
import { openStores } from './store/index.js';
import { setRefundStore } from './tools/refund-store.js';
import { ResponseScorer } from './evaluation/response-scorer.js';
import { TrajectoryLogger } from './evaluation/trajectory-logger.js';
import type { AgentConfig } from './core/types.js';

/**
 * CLI 入口。
 *
 * v0.2 起这里只做「装配 + 渲染」两件事：
 * 工具定义在 src/tools/，横切能力在 src/middleware/，编排在 src/core/agent-loop.ts。
 * 此前本文件内联定义了 4 个与 src/tools/ 重复的工具（内联那套在跑但零测试，
 * src/tools/ 那套有测试但运行时零引用），现已统一。
 *
 * v0.6 会把这层换成 HTTP + SSE 服务，CLI 降级为服务的瘦客户端 —— 届时
 * 只有本文件需要改，AgentLoop 与中间件一行不动。
 */
async function main() {
  const config: AgentConfig = {
    model: process.env.AGENT_MODEL || 'claude-opus-5',
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxTurns: 10,
    maxTokensPerSession: 100_000,
    systemPrompt: SYSTEM_PROMPT,
    confirmHighRisk: true,
  };

  if (!config.apiKey) {
    console.error('请设置环境变量 ANTHROPIC_API_KEY');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  // ============ 装配 ============

  const registry = buildToolRegistry();

  // v0.5：会话落 PostgreSQL。无 DATABASE_URL 时走 PGlite（进程内真 Postgres，零配置）
  const stores = await openStores(process.env.DATABASE_URL);
  setRefundStore(stores.refunds);
  const session = await Session.create(stores.sessions, {
    userId: process.env.AGENT_USER_ID,
    tenantId: process.env.AGENT_TENANT_ID,
  });
  // tracker 必须在 Loop 与 BudgetGuard 之间共享，否则两边各记一份账、熔断永不触发
  const tracker = new TokenTracker();
  const pipeline = buildDefaultPipeline({
    tracker,
    maxTokens: config.maxTokensPerSession,
    maxMessages: 20,
    onWarn: (warning) => console.log(`\n⚠️  ${warning}`),
  });
  const trajectory = new TrajectoryLogger(
    path.join(process.cwd(), 'sessions', `${session.getId()}.events.jsonl`)
  );

  // 流式与输出脱敏存在固有矛盾：delta 是模型原始输出，而 afterTurn 的脱敏/合规改写
  // 发生在收口阶段 —— 也就是说未脱敏的内容**已经打到屏幕上了**。
  // v0.4 的处理是「诚实纠正」：累积流式文本，若最终回复与之不同，明确告知已改写并给出准据版本。
  // 真正的解法是流式感知的安全管道（逐块过滤 + 跨块模式的滞后窗口），归 v0.10。
  let streamedText = '';

  const onEvent: EventHandler = (event) => {
    switch (event.type) {
      case 'thinking':
        process.stdout.write('\n');
        break;
      case 'tool_start':
        console.log(`\n🔧 调用工具: ${event.toolName}`);
        break;
      case 'tool_end':
        console.log(
          `   ${event.result.isError ? '⚠️ ' : '✅'} 工具完成 (${event.durationMs}ms)`
        );
        break;
      case 'delta':
        // 逐块吐字：用户不再等全量生成完才看到第一个字
        if (streamedText === '') process.stdout.write('\n🤖 ');
        streamedText += event.text;
        process.stdout.write(event.text);
        break;
      case 'response':
        if (streamedText === '') {
          // provider 没走流式（或本轮无文本增量）—— 一次性打印
          console.log(`\n🤖 ${event.content}`);
        } else if (event.content !== streamedText) {
          // 已流式输出的内容被 afterTurn 改写过（脱敏/合规），必须告知并给准据版本
          console.log(
            `\n\n🛡️  上面的内容已被改写（脱敏/合规），以下为最终版本：\n🤖 ${event.content}`
          );
        } else {
          process.stdout.write('\n');
        }
        streamedText = '';
        break;
      case 'blocked':
        console.log(`\n🛡️  已拦截 [${event.by}]：${event.reason}`);
        break;
      case 'error':
        console.log(`\n❌ ${event.error}`);
        break;
      case 'done':
        // 静默，退出时打印汇总
        break;
    }
  };

  const onConfirm: ConfirmHandler = async (toolName, input) => {
    console.log(`\n⚠️  高风险操作确认`);
    console.log(`   工具: ${toolName}`);
    console.log(`   参数: ${JSON.stringify(input, null, 2)}`);
    const answer = await prompt('   是否继续？(y/n): ');
    return answer.trim().toLowerCase() === 'y';
  };

  const agent = new AgentLoop({
    config,
    registry,
    session,
    pipeline,
    tracker,
    onEvent,
    onConfirm,
    scorer: new ResponseScorer(),
    trajectory,
  });

  // ============ 交互 ============

  console.log('================================================');
  console.log('  好买电商 AI 客服');
  console.log('  输入您的问题，输入 exit 或 quit 退出');
  console.log(`  会话ID: ${session.getId()}`);
  console.log(`  存储引擎: ${stores.db.engine}${process.env.DATABASE_URL ? '' : '（PGlite，设 DATABASE_URL 可切真实 PG）'}`);
  console.log(`  已装载工具: ${registry.getAll().map((t) => t.name).join(', ')}`);
  console.log(`  已装载中间件: ${agent.getPipelineNames().join(' → ')}`);
  console.log('================================================\n');

  while (true) {
    const input = await prompt('👤 您: ');
    const trimmed = input.trim();

    if (!trimmed) continue;
    if (trimmed === 'exit' || trimmed === 'quit') break;

    await agent.run(trimmed);
  }

  const summary = agent.getTracker().getSummary();
  console.log('\n================================================');
  console.log('  会话结束，Token 和成本汇总');
  console.log('================================================');
  console.log(`  输入 tokens:  ${summary.totalInputTokens.toLocaleString()}`);
  console.log(`  输出 tokens:  ${summary.totalOutputTokens.toLocaleString()}`);
  console.log(`  总 tokens:    ${summary.totalTokens.toLocaleString()}`);
  console.log(`  API 调用次数: ${summary.callCount}`);
  console.log(`  总成本:       $${summary.totalCostUsd.toFixed(4)}`);
  if (summary.cacheReadTokens > 0) {
    console.log(`  缓存读取:     ${summary.cacheReadTokens.toLocaleString()} tokens`);
  }
  console.log('================================================\n');

  rl.close();
  await stores.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
