import { Pipeline } from '../src/core/pipeline.js';
import type {
  AgentMiddleware,
  MiddlewareOutcome,
  TurnContext,
} from '../src/core/pipeline.js';
import type { Message } from '../src/core/types.js';

function ctx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    sessionId: 'sesn_test',
    userInput: 'hello',
    messages: [] as Message[],
    metadata: {},
    ...overrides,
  } as TurnContext;
}

function recorder(
  name: string,
  outcome: MiddlewareOutcome,
  calls: string[]
): AgentMiddleware {
  return {
    name,
    beforeTurn: () => {
      calls.push(name);
      return outcome;
    },
    beforeModel: () => {
      calls.push(name);
      return outcome;
    },
    afterTurn: () => {
      calls.push(name);
      return outcome;
    },
  };
}

describe('Pipeline', () => {
  it('无中间件时原样放行', async () => {
    const p = new Pipeline([]);
    const r = await p.runBeforeTurn(ctx());
    expect(r.blocked).toBeUndefined();
    expect(r.text).toBe('hello');
    expect(r.rewrittenBy).toEqual([]);
  });

  it('按注册顺序执行', async () => {
    const calls: string[] = [];
    const p = new Pipeline([
      recorder('a', { action: 'continue' }, calls),
      recorder('b', { action: 'continue' }, calls),
      recorder('c', { action: 'continue' }, calls),
    ]);
    await p.runBeforeTurn(ctx());
    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('block 立即短路，后续中间件不执行', async () => {
    const calls: string[] = [];
    const p = new Pipeline([
      recorder('a', { action: 'continue' }, calls),
      recorder('b', { action: 'block', reason: '命中提示词注入' }, calls),
      recorder('c', { action: 'continue' }, calls),
    ]);
    const r = await p.runBeforeTurn(ctx());
    expect(r.blocked).toEqual({ by: 'b', reason: '命中提示词注入' });
    expect(calls).toEqual(['a', 'b']);
  });

  it('beforeTurn 的 rewrite 写回 ctx.userInput', async () => {
    const c = ctx({ userInput: '原始' });
    const p = new Pipeline([
      { name: 'x', beforeTurn: () => ({ action: 'rewrite', text: '改写后' }) },
    ]);
    const r = await p.runBeforeTurn(c);
    expect(c.userInput).toBe('改写后');
    expect(r.text).toBe('改写后');
    expect(r.rewrittenBy).toEqual(['x']);
  });

  it('afterTurn 的 rewrite 逐级传递给后续中间件', async () => {
    const seen: string[] = [];
    const p = new Pipeline([
      {
        name: 'x',
        afterTurn: (_c, t) => {
          seen.push(t);
          return { action: 'rewrite', text: t + '1' };
        },
      },
      {
        name: 'y',
        afterTurn: (_c, t) => {
          seen.push(t);
          return { action: 'rewrite', text: t + '2' };
        },
      },
    ]);
    const r = await p.runAfterTurn(ctx(), 'a');
    expect(seen).toEqual(['a', 'a1']);
    expect(r.text).toBe('a12');
    expect(r.rewrittenBy).toEqual(['x', 'y']);
  });

  it('未实现某钩子的中间件被跳过而非报错', async () => {
    const calls: string[] = [];
    const p = new Pipeline([
      { name: 'onlyAfter', afterTurn: () => ({ action: 'continue' }) },
      recorder('both', { action: 'continue' }, calls),
    ]);
    await p.runBeforeModel(ctx());
    expect(calls).toEqual(['both']);
  });

  it('支持异步中间件', async () => {
    const p = new Pipeline([
      {
        name: 'async',
        beforeTurn: async () => {
          await Promise.resolve();
          return { action: 'block', reason: '异步拦截' };
        },
      },
    ]);
    const r = await p.runBeforeTurn(ctx());
    expect(r.blocked).toEqual({ by: 'async', reason: '异步拦截' });
  });

  it('names 暴露已装载的中间件名（便于启动时打印与排障）', () => {
    const p = new Pipeline([
      { name: 'input-filter' },
      { name: 'budget-guard' },
    ]);
    expect(p.names).toEqual(['input-filter', 'budget-guard']);
  });

  it('三个钩子互不影响：beforeModel 的 block 不影响后续 afterTurn 调用', async () => {
    const calls: string[] = [];
    const p = new Pipeline([
      recorder('a', { action: 'block', reason: 'x' }, calls),
    ]);
    await p.runBeforeModel(ctx());
    calls.length = 0;
    await p.runAfterTurn(ctx(), 'reply');
    expect(calls).toEqual(['a']);
  });
});
