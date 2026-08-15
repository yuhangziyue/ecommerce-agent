/**
 * 最小指标注册表（v0.14）。
 *
 * **刻意不引入 OpenTelemetry SDK**：本项目要的是 counter / gauge / histogram
 * 三种东西，而 OTel 带来的是完整的 trace + context propagation + exporter 生态 ——
 * 用不上的部分远多于用得上的。依赖越少，v0.15 拆服务时越容易。
 *
 * 导出的是 Prometheus 文本格式，接哪个后端是部署选择，不是代码选择。
 */

export type Labels = Record<string, string>;

/** 标签序列化。**键排序**，否则 `{a,b}` 与 `{b,a}` 会被当成两条独立时间序列 */
function labelKey(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}=${v}`).join(',');
}

function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  const inner = entries
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',');
  return `{${inner}}`;
}

/** Prometheus 规定标签值里的 `\`、`"`、换行必须转义，否则整个抓取会解析失败 */
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

interface Series<T> {
  labels: Labels;
  value: T;
}

abstract class Metric<T> {
  protected readonly series = new Map<string, Series<T>>();

  constructor(
    readonly name: string,
    readonly help: string,
    /** 允许出现的标签名。**白名单是防基数爆炸的第一道闸** */
    readonly labelNames: string[] = []
  ) {}

  protected resolve(labels: Labels): Series<T> {
    for (const k of Object.keys(labels)) {
      if (!this.labelNames.includes(k)) {
        throw new Error(
          `指标 ${this.name} 不接受标签 ${k}（允许：${this.labelNames.join(', ') || '无'}）`
        );
      }
    }

    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, value: this.initial() };
      this.series.set(key, s);
    }
    return s;
  }

  protected abstract initial(): T;
  abstract render(): string[];

  reset(): void {
    this.series.clear();
  }
}

export class Counter extends Metric<number> {
  protected initial(): number {
    return 0;
  }

  inc(labels: Labels = {}, delta = 1): void {
    if (delta < 0) throw new Error(`Counter ${this.name} 不能减少`);
    this.resolve(labels).value += delta;
  }

  get(labels: Labels = {}): number {
    return this.series.get(labelKey(labels))?.value ?? 0;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const s of this.series.values()) {
      lines.push(`${this.name}${renderLabels(s.labels)} ${s.value}`);
    }
    return lines;
  }
}

export class Gauge extends Metric<number> {
  protected initial(): number {
    return 0;
  }

  set(value: number, labels: Labels = {}): void {
    this.resolve(labels).value = value;
  }

  get(labels: Labels = {}): number {
    return this.series.get(labelKey(labels))?.value ?? 0;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const s of this.series.values()) {
      lines.push(`${this.name}${renderLabels(s.labels)} ${s.value}`);
    }
    return lines;
  }
}

interface HistogramState {
  /** 每个桶的累计计数（Prometheus 的 `le` 是**累计**语义，不是区间计数） */
  buckets: number[];
  sum: number;
  count: number;
  /** 保留原始样本用于精确分位数。仅本进程内用，不导出 */
  samples: number[];
}

/** 按秒计的默认桶边界，覆盖 5ms ~ 30s */
export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export class Histogram extends Metric<HistogramState> {
  constructor(
    name: string,
    help: string,
    labelNames: string[] = [],
    readonly buckets: number[] = DEFAULT_BUCKETS
  ) {
    super(name, help, labelNames);
    // 桶必须升序，否则累计计数是错的 —— 装配时就炸，别等抓取时才发现
    for (let i = 1; i < buckets.length; i++) {
      if (buckets[i] <= buckets[i - 1]) {
        throw new Error(`直方图 ${name} 的桶边界必须严格升序`);
      }
    }
  }

  protected initial(): HistogramState {
    return {
      buckets: new Array(this.buckets.length).fill(0),
      sum: 0,
      count: 0,
      samples: [],
    };
  }

  observe(value: number, labels: Labels = {}): void {
    const s = this.resolve(labels).value;
    s.sum += value;
    s.count++;
    // 只留最近 10000 个样本 —— 分位数不需要全量，而无上限的数组是内存泄漏
    s.samples.push(value);
    if (s.samples.length > 10_000) s.samples.shift();

    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) s.buckets[i]++;
    }
  }

  /**
   * 精确分位数（基于保留的样本，不是桶插值）。
   *
   * 桶插值在样本落在同一个桶里时误差巨大，而本项目的延迟分布正是那样
   * （绝大多数请求集中在几十毫秒）。进程内算精确值没有额外成本。
   */
  quantile(q: number, labels: Labels = {}): number {
    const s = this.series.get(labelKey(labels))?.value;
    if (!s || s.samples.length === 0) return 0;

    const sorted = [...s.samples].sort((a, b) => a - b);
    // 最近秩法：向上取整，q=1 取最大值
    const rank = Math.ceil(q * sorted.length);
    return sorted[Math.min(Math.max(rank, 1) - 1, sorted.length - 1)];
  }

  count(labels: Labels = {}): number {
    return this.series.get(labelKey(labels))?.value.count ?? 0;
  }

  sum(labels: Labels = {}): number {
    return this.series.get(labelKey(labels))?.value.sum ?? 0;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        const l = renderLabels({ ...s.labels, le: String(this.buckets[i]) });
        lines.push(`${this.name}_bucket${l} ${s.value.buckets[i]}`);
      }
      // `+Inf` 桶是 Prometheus 必需的，缺了它抓取端会算不出总数
      lines.push(
        `${this.name}_bucket${renderLabels({ ...s.labels, le: '+Inf' })} ${s.value.count}`
      );
      lines.push(`${this.name}_sum${renderLabels(s.labels)} ${s.value.sum}`);
      lines.push(`${this.name}_count${renderLabels(s.labels)} ${s.value.count}`);
    }
    return lines;
  }
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric<any>>();

  counter(name: string, help: string, labelNames?: string[]): Counter {
    return this.register(new Counter(name, help, labelNames));
  }

  gauge(name: string, help: string, labelNames?: string[]): Gauge {
    return this.register(new Gauge(name, help, labelNames));
  }

  histogram(
    name: string,
    help: string,
    labelNames?: string[],
    buckets?: number[]
  ): Histogram {
    return this.register(new Histogram(name, help, labelNames, buckets));
  }

  /** 重复注册返回已有实例 —— 多处装配同一个指标是常态，不该是错误 */
  private register<T extends Metric<any>>(metric: T): T {
    const existing = this.metrics.get(metric.name);
    if (existing) return existing as T;
    this.metrics.set(metric.name, metric);
    return metric;
  }

  /** Prometheus 文本格式（`text/plain; version=0.0.4`） */
  render(): string {
    const chunks: string[] = [];
    // 按名字排序，让输出稳定 —— 便于 diff 与用例断言
    for (const name of [...this.metrics.keys()].sort()) {
      chunks.push(this.metrics.get(name)!.render().join('\n'));
    }
    return chunks.join('\n') + (chunks.length > 0 ? '\n' : '');
  }

  resetAll(): void {
    for (const m of this.metrics.values()) m.reset();
  }
}
