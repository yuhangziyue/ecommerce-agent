import { EventBus } from '../src/core/event-bus.js';
import type { AgentEvent } from '../src/core/types.js';

const ev = (text: string): AgentEvent => ({ type: 'delta', text });

describe('EventBus', () => {
  it('多个订阅者按注册顺序收到同一事件', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe(() => seen.push('a'));
    bus.subscribe(() => seen.push('b'));
    bus.subscribe(() => seen.push('c'));

    bus.emit(ev('x'));

    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('订阅者收到的是同一个事件对象', () => {
    const bus = new EventBus();
    const received: AgentEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const event = ev('hello');
    bus.emit(event);

    expect(received).toEqual([event]);
  });

  it('subscribe 返回的函数可退订', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const off = bus.subscribe(() => seen.push('a'));
    bus.subscribe(() => seen.push('b'));

    bus.emit(ev('1'));
    off();
    bus.emit(ev('2'));

    expect(seen).toEqual(['a', 'b', 'b']);
    expect(bus.subscriberCount).toBe(1);
  });

  it('重复退订是幂等的，不会误删别人', () => {
    const bus = new EventBus();
    const off = bus.subscribe(() => {});
    bus.subscribe(() => {});

    off();
    off();
    off();

    expect(bus.subscriberCount).toBe(1);
  });

  it('一个订阅者抛异常不影响其他订阅者', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const errors: unknown[] = [];

    bus.subscribe(() => seen.push('before'));
    bus.subscribe(() => {
      throw new Error('埋点挂了');
    });
    bus.subscribe(() => seen.push('after'));

    bus.emit(ev('x'), (err) => errors.push(err));

    // 关键：坏订阅者不该让后面的订阅者收不到事件
    expect(seen).toEqual(['before', 'after']);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('埋点挂了');
  });

  it('订阅者异常不外溢到 emit 的调用方（一个坏埋点不该搞挂对话）', () => {
    const bus = new EventBus();
    bus.subscribe(() => {
      throw new Error('boom');
    });

    expect(() => bus.emit(ev('x'), () => {})).not.toThrow();
  });

  it('无订阅者时 emit 是空操作', () => {
    const bus = new EventBus();
    expect(() => bus.emit(ev('x'))).not.toThrow();
    expect(bus.subscriberCount).toBe(0);
  });

  it('emit 期间新增的订阅者不参与本次分发（避免自触发死循环）', () => {
    const bus = new EventBus();
    const seen: string[] = [];

    bus.subscribe(() => {
      seen.push('a');
      bus.subscribe(() => seen.push('late'));
    });

    bus.emit(ev('1'));
    expect(seen).toEqual(['a']);

    bus.emit(ev('2'));
    expect(seen).toEqual(['a', 'a', 'late']);
  });
});
