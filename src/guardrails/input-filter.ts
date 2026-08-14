export interface FilterResult {
  passed: boolean;
  reason?: string;
}

export class InputFilter {
  private patterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, reason: '检测到提示词注入尝试：忽略先前指令' },
    { pattern: /^system:/i, reason: '检测到提示词注入尝试：伪造系统消息' },
    { pattern: /你现在是/i, reason: '检测到提示词注入尝试：角色劫持' },
    { pattern: /forget\s+(all\s+)?your\s+(previous\s+)?instructions/i, reason: '检测到提示词注入尝试：遗忘指令' },
    { pattern: /disregard\s+(all\s+)?previous/i, reason: '检测到提示词注入尝试：忽视先前内容' },
  ];

  /** Check if input passes all filters */
  check(input: string): FilterResult {
    if (!input || input.trim().length === 0) {
      return { passed: false, reason: '输入不能为空' };
    }

    for (const { pattern, reason } of this.patterns) {
      if (pattern.test(input)) {
        return { passed: false, reason };
      }
    }

    return { passed: true };
  }

  /** Add a custom filter pattern */
  addPattern(pattern: RegExp, reason: string): void {
    this.patterns.push({ pattern, reason });
  }
}
