export interface OutputFilterResult {
  passed: boolean;
  filtered?: string;
  reason?: string;
}

export class OutputFilter {
  private sensitivePatterns: Array<{ pattern: RegExp; replacement: string; reason: string }> = [
    { pattern: /(1[3-9]\d)\d{4}(\d{4})/g, replacement: '$1****$2', reason: '手机号脱敏' },
    { pattern: /\b\d{18}\b/g, replacement: '******', reason: '身份证号脱敏' },
    { pattern: /sk-[a-zA-Z0-9]+/g, replacement: 'sk-****', reason: 'API密钥脱敏' },
  ];

  check(output: string): OutputFilterResult {
    let filtered = output;
    let modified = false;

    for (const { pattern, replacement } of this.sensitivePatterns) {
      const newFiltered = filtered.replace(pattern, replacement);
      if (newFiltered !== filtered) {
        modified = true;
        filtered = newFiltered;
      }
    }

    return {
      passed: !modified,
      filtered: modified ? filtered : undefined,
    };
  }
}
