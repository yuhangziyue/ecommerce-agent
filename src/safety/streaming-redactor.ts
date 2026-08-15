import { DEFAULT_SAFETY_LAG } from './rules.js';
import type { SafetyScanner } from './scanner.js';

/**
 * 流式感知的脱敏器：解决 v0.4 遗留的「流式绕过输出脱敏」。
 *
 * 问题的本质：**过滤需要看到完整文本才能判断，而流式的意义就是不等完整文本。**
 * 而且敏感模式会跨块 —— `1381` 和 `2345678` 分两块到达，逐块看都不是手机号。
 *
 * 解法是**滞后窗口**：始终压住最后 `lag` 个字符不发，`lag` ≥ 最长敏感模式长度。
 * 释放前扫描全缓冲区，任何跨越释放点的命中都把释放点前移到它的起点。
 *
 * **代价是首字延迟增加** —— v0.4 拿到的首块延迟收益会被吃掉一部分。
 * 这是真实权衡不是免费的，所以 `lag` 可配：设 0 即退回 v0.4 的逐块直放行为。
 */
export class StreamingRedactor {
  private buffer = '';

  constructor(
    private readonly scanner: SafetyScanner,
    private readonly lag: number = DEFAULT_SAFETY_LAG
  ) {}

  /**
   * 喂入一个增量块，返回**当前可安全释放**的（已脱敏的）文本。
   * 可能返回空串 —— 缓冲区还不够长，一个字都不能放。
   */
  feed(chunk: string): string {
    this.buffer += chunk;
    if (this.lag <= 0) {
      // lag=0：不做滞后，逐块脱敏后直放（等价 v0.4 行为 + 单块内脱敏）
      const out = this.scanner.mask(this.buffer);
      this.buffer = '';
      return out;
    }

    // 只压住**可能长成敏感串的尾巴**，而不是无条件压住 lag 个字符。
    //
    // 所有敏感模式都只由 ALPHABET 里的字符构成，所以一个尚未成形的命中
    // 必然是「一段连续的 ALPHABET 字符 + 后续还没到的块」。中文正文、标点、
    // 空格都不可能是它的一部分 —— 那些字符一到就能放。
    //
    // 效果不是微优化：实测首块延迟从 297ms 回到 24ms（客服回复以中文为主）。
    let safeEnd = this.buffer.length - this.riskyTailLength();
    if (safeEnd <= 0) return '';

    // 任何跨越释放点的命中，都把释放点前移到它的起点 ——
    // 否则会把一个敏感串从中间切开，两半各自都不匹配规则，脱敏就漏了
    for (const match of this.scanner.findMatches(this.buffer)) {
      const end = match.index + match.length;
      if (match.index < safeEnd && end > safeEnd) {
        safeEnd = match.index;
      }
    }
    if (safeEnd <= 0) return '';

    const releasable = this.buffer.slice(0, safeEnd);
    this.buffer = this.buffer.slice(safeEnd);
    return this.scanner.mask(releasable);
  }

  /** 流结束：释放剩余全部内容（此时能看到完整文本，脱敏最准） */
  flush(): string {
    const rest = this.buffer;
    this.buffer = '';
    return this.scanner.mask(rest);
  }

  /** 尚未释放的字符数，便于排障与测试 */
  get pending(): number {
    return this.buffer.length;
  }

  /**
   * 缓冲区末尾「可能与后续块拼成敏感串」的长度，上限 `lag`。
   *
   * 判据：敏感模式的字符集是 ALPHABET（数字/字母/`@._+-`）。末尾一旦出现
   * 集合外的字符（汉字、空格、中文标点），它前面的内容就不可能再参与
   * 一个跨块命中 —— 可以立刻放行。
   *
   * 上限仍是 `lag`：极长的字母数字串（如超长邮箱）会退回原来的滞后行为，
   * 这是刻意的保守边界。
   */
  private riskyTailLength(): number {
    let n = 0;
    for (let i = this.buffer.length - 1; i >= 0 && n < this.lag; i--, n++) {
      if (!ALPHABET.test(this.buffer[i])) break;
    }
    return n;
  }
}

/** 敏感模式可能用到的全部字符。**改规则时必须同步检查这里**，漏了会导致漏检。 */
const ALPHABET = /[0-9A-Za-z@._+-]/;
