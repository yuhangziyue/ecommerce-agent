import { SafetyScanner } from '../safety/scanner.js';
import type { SafetyMatch } from '../safety/scanner.js';
import type { AgentMiddleware } from '../core/pipeline.js';
import type { Session } from '../core/session.js';

export const SAFETY_AUDIT_KEY = 'safety_audit';

export interface SafetyAuditEntry {
  stage: 'input' | 'output';
  action: 'mask' | 'block' | 'handoff';
  /** 只记规则 id / 名称 / 位置 —— **不记原始命中内容**，那本身就是敏感数据 */
  matches: SafetyMatch[];
  at: number;
}

/**
 * 安全中间件：取代 v0.2 的 input-filter / output-filter。
 *
 * 相比旧版多三件事：
 * 1. **四级处置**（allow / mask / block / handoff）而不是「拦截或脱敏」二选一
 * 2. **审计留痕** —— 没有留痕就无法回答「我们拦了多少、错拦了多少」（v0.14 度量的数据源）
 * 3. `handoff` **不直接回复用户**，注入 systemAppends 让模型自己组织语言
 */
export function createSafetyMiddleware(opts: {
  session?: Session;
  onVerdict?: (entry: SafetyAuditEntry) => void;
  inputScanner?: SafetyScanner;
  outputScanner?: SafetyScanner;
}): AgentMiddleware {
  const input = opts.inputScanner ?? SafetyScanner.forInput();
  const output = opts.outputScanner ?? SafetyScanner.forOutput();

  const audit = async (entry: SafetyAuditEntry): Promise<void> => {
    opts.onVerdict?.(entry);
    try {
      await opts.session?.appendMetadata(SAFETY_AUDIT_KEY, entry);
    } catch (err) {
      // 审计写入失败不该拖垮对话（与 v0.7 压缩失败同一原则）
      console.warn(`[safety] 审计写入失败：${(err as Error).message}`);
    }
  };

  return {
    name: 'safety',

    async beforeTurn(ctx) {
      if (!ctx.userInput.trim()) {
        return { action: 'block', reason: '输入不能为空' };
      }

      const verdict = input.scan(ctx.userInput);
      if (verdict.action === 'allow') return { action: 'continue' };

      await audit({
        stage: 'input',
        action: verdict.action,
        matches: verdict.matches,
        at: Date.now(),
      });

      if (verdict.action === 'block') {
        return { action: 'block', reason: verdict.reason ?? '输入未通过安全检查' };
      }

      // handoff：不替模型回复，只告诉它「这事该转人工」
      ctx.systemAppends.push(
        `## 安全提示\n${verdict.reason}。请先安抚客户情绪、确认具体诉求，` +
          `然后使用 human_handoff 转接人工客服，不要自行承诺处理结果。`
      );
      return { action: 'continue' };
    },

    async afterTurn(_ctx, reply) {
      const verdict = output.scan(reply);
      if (verdict.action === 'allow') return { action: 'continue' };

      await audit({
        stage: 'output',
        action: 'mask',
        matches: verdict.matches,
        at: Date.now(),
      });

      return { action: 'rewrite', text: verdict.text };
    },
  };
}

/** 从 session 里取回全部安全审计条目（排障与 v0.14 度量用） */
export function readSafetyAudit(session: Session): SafetyAuditEntry[] {
  return session
    .getEntries()
    .filter((e) => e.type === 'metadata')
    .map((e) => e.data as { key: string; value: unknown })
    .filter((d) => d.key === SAFETY_AUDIT_KEY)
    .map((d) => d.value as SafetyAuditEntry);
}
