import type { AgentEvent } from './types.js';

export type EventSubscriber = (event: AgentEvent) => void;
export type SubscriberErrorHandler = (error: unknown, event: AgentEvent) => void;

/**
 * Agent 事件的多订阅者分发总线。
 *
 * 为什么 v0.4 要把单回调换成总线：v0.6 做 SSE 服务时，同一条事件流需要被多方消费 ——
 * SSE 写出器、轨迹落盘、以及 v0.14 的指标埋点。原来的 `onEvent` 单回调 +
 * `trajectory?.log()` 是两套并行机制，每加一个消费者就要改 AgentLoop 一次。
 *
 * 两条关键性质：
 * 1. **异常隔离** —— 一个订阅者抛异常，其余订阅者照常收到事件，且不外溢到 emit 调用方。
 *    一个坏掉的埋点不该搞挂正在进行的对话。
 * 2. **分发快照** —— emit 期间新增的订阅者不参与本次分发，避免订阅者内再订阅造成自触发。
 */
export class EventBus {
  private subscribers: EventSubscriber[] = [];

  /** @returns 退订函数（幂等，重复调用不会误删他人） */
  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.push(subscriber);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const index = this.subscribers.indexOf(subscriber);
      if (index !== -1) this.subscribers.splice(index, 1);
    };
  }

  /**
   * @param onSubscriberError 订阅者抛异常时的处理；缺省走 stderr 降级告警。
   *        暴露出来是为了让测试断言异常确实被捕获，而不是被吞掉。
   */
  emit(event: AgentEvent, onSubscriberError?: SubscriberErrorHandler): void {
    // 快照：emit 期间的订阅变化不影响本次分发
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(event);
      } catch (error) {
        if (onSubscriberError) {
          onSubscriberError(error, event);
        } else {
          console.error(
            `[EventBus] 订阅者处理 ${event.type} 事件时抛出异常，已隔离：`,
            error
          );
        }
      }
    }
  }

  get subscriberCount(): number {
    return this.subscribers.length;
  }
}
