import { INPUT_RULES, OUTPUT_RULES, type SafetyAction, type SafetyRule } from './rules.js';

export interface SafetyMatch {
  ruleId: string;
  ruleName: string;
  action: Exclude<SafetyAction, 'allow'>;
  /** 命中位置。**刻意不记原始命中内容** —— 那本身就是敏感数据 */
  index: number;
  length: number;
}

export interface Verdict {
  action: SafetyAction;
  matches: SafetyMatch[];
  /** `mask` 时的改写结果；其余情况为原文 */
  text: string;
  /** `block` / `handoff` 时给出的原因 */
  reason?: string;
}

/** 处置优先级：越严重越优先 */
const SEVERITY: Record<SafetyAction, number> = {
  allow: 0,
  mask: 1,
  handoff: 2,
  block: 3,
};

export class SafetyScanner {
  constructor(private readonly rules: SafetyRule[]) {}

  static forInput(): SafetyScanner {
    return new SafetyScanner(INPUT_RULES);
  }

  static forOutput(): SafetyScanner {
    return new SafetyScanner(OUTPUT_RULES);
  }

  /** 只找命中，不做改写。流式脱敏器用它定位跨块边界。 */
  findMatches(text: string): SafetyMatch[] {
    const matches: SafetyMatch[] = [];

    for (const rule of this.rules) {
      // 全局正则带 lastIndex 状态，复用同一个实例会漏匹配 —— 每次新建
      const regex = new RegExp(rule.pattern.source, ensureGlobal(rule.pattern.flags));
      let m: RegExpExecArray | null;
      while ((m = regex.exec(text)) !== null) {
        matches.push({
          ruleId: rule.id,
          ruleName: rule.name,
          action: rule.action,
          index: m.index,
          length: m[0].length,
        });
        if (m[0].length === 0) regex.lastIndex++; // 防零宽匹配死循环
      }
    }

    return matches.sort((a, b) => a.index - b.index);
  }

  /**
   * 扫描并按最严重的处置给出裁决。
   * `mask` 会返回改写后的文本；`block` / `handoff` 返回原文与原因。
   */
  scan(text: string): Verdict {
    const matches = this.findMatches(text);
    if (matches.length === 0) {
      return { action: 'allow', matches: [], text };
    }

    const worst = matches.reduce((acc, m) =>
      SEVERITY[m.action] > SEVERITY[acc.action] ? m : acc
    );

    if (worst.action === 'block' || worst.action === 'handoff') {
      const rule = this.rules.find((r) => r.id === worst.ruleId);
      return {
        action: worst.action,
        matches,
        text,
        reason: rule?.reason ?? `命中安全规则 ${worst.ruleId}`,
      };
    }

    return { action: 'mask', matches, text: this.mask(text) };
  }

  /** 只做脱敏改写（不判级别），流式脱敏器用它处理可释放的片段 */
  mask(text: string): string {
    let result = text;
    for (const rule of this.rules) {
      if (rule.action !== 'mask' || !rule.replacement) continue;
      const regex = new RegExp(rule.pattern.source, ensureGlobal(rule.pattern.flags));
      result = result.replace(regex, rule.replacement);
    }
    return result;
  }
}

function ensureGlobal(flags: string): string {
  return flags.includes('g') ? flags : `${flags}g`;
}
