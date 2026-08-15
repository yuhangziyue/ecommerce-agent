import { advance, renderIntentContext, stateFromUnknown } from '../intent/state-machine.js';
import type { IntentRecognizer } from '../intent/recognizer.js';
import type { IntentState } from '../intent/types.js';
import type { AgentMiddleware } from '../core/pipeline.js';
import type { Session } from '../core/session.js';

export const INTENT_METADATA_KEY = 'intent_state';

/** 从 session 的 metadata 事件里取回上一轮的意图状态（跨请求延续） */
export function readIntentState(session: Session): IntentState {
  const entries = session.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'metadata') continue;
    const data = entry.data as { key: string; value: unknown };
    if (data.key === INTENT_METADATA_KEY) {
      return data.value as IntentState;
    }
  }
  return stateFromUnknown();
}

/**
 * 多轮意图识别中间件。
 *
 * 挂在 `beforeTurn`：识别 → 推进状态机 → 注入 `systemAppends` → 落 session。
 *
 * 落 session 而不是只存内存：v0.6 起每个 HTTP 请求都是独立进程状态，
 * 状态不落盘就等于每轮从零开始，槽位继承与切换检测全部失效。
 */
export function createIntentMiddleware(opts: {
  recognizer: IntentRecognizer;
  session: Session;
  /** 识别结果的旁路通知（服务端用来发 SSE intent 事件） */
  onRecognized?: (state: IntentState) => void;
}): AgentMiddleware {
  return {
    name: 'intent',
    async beforeTurn(ctx) {
      const previous = readIntentState(opts.session);
      const result = await opts.recognizer.recognize(ctx.userInput, ctx.messages);
      const next = advance(previous, result);

      const context = renderIntentContext(next);
      if (context) ctx.systemAppends.push(context);

      ctx.metadata.intent = next;
      opts.onRecognized?.(next);

      // 只有识别出有效意图才落盘 —— 否则 unknown 会把上一轮的有效状态覆盖掉
      if (next.intent !== 'unknown') {
        await opts.session.appendMetadata(INTENT_METADATA_KEY, next);
      }

      return { action: 'continue' };
    },
  };
}
