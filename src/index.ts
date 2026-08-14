import * as readline from 'node:readline';
import * as path from 'node:path';
import { AgentLoop, type EventHandler, type ConfirmHandler } from './core/agent-loop.js';
import { Session } from './core/session.js';
import { TokenTracker } from './core/token-tracker.js';
import { SYSTEM_PROMPT } from './prompts/system-prompt.js';
import { buildToolRegistry } from './tools/index.js';
import { buildDefaultPipeline } from './middleware/index.js';
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
  const session = Session.create();
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

  const onEvent: EventHandler = (event) => {
    switch (event.type) {
      case 'thinking':
        console.log(`\n💭 ${event.content}`);
        break;
      case 'tool_start':
        console.log(`\n🔧 调用工具: ${event.toolName}`);
        break;
      case 'tool_end':
        console.log(
          `   ${event.result.isError ? '⚠️ ' : '✅'} 工具完成 (${event.durationMs}ms)`
        );
        break;
      case 'response':
        console.log(`\n🤖 ${event.content}`);
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
  process.exit(0);
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
