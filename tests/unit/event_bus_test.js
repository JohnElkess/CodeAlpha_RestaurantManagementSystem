const { EventBus } = require('../../src/events/event_bus');

const quietLogger = () => ({ error: jest.fn(), warn() {}, info() {}, debug() {} });

describe('EventBus (Observer)', () => {
  test('delivers the payload to every subscriber of an event, and only that event', async () => {
    const bus = new EventBus({ logger: quietLogger() });
    const a = jest.fn();
    const b = jest.fn();
    const other = jest.fn();
    bus.subscribe('x', a);
    bus.subscribe('x', b);
    bus.subscribe('y', other);
    await bus.publish('x', { n: 1 });
    expect(a).toHaveBeenCalledWith({ n: 1 }, 'x');
    expect(b).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  test('publish waits for async subscribers', async () => {
    const bus = new EventBus({ logger: quietLogger() });
    let done = false;
    bus.subscribe('x', async () => {
      await new Promise((r) => setTimeout(r, 20));
      done = true;
    });
    await bus.publish('x');
    expect(done).toBe(true);
  });

  test('a failing subscriber is logged and never breaks the publisher or the other subscribers', async () => {
    const logger = quietLogger();
    const bus = new EventBus({ logger });
    const ok = jest.fn();
    bus.subscribe('x', () => { throw new Error('boom'); });
    bus.subscribe('x', async () => Promise.reject(new Error('async boom')));
    bus.subscribe('x', ok);
    await expect(bus.publish('x')).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  test("'*' receives every event, and unsubscribe works", async () => {
    const bus = new EventBus({ logger: quietLogger() });
    const all = jest.fn();
    const only = jest.fn();
    bus.subscribe('*', all);
    const off = bus.subscribe('x', only);
    await bus.publish('x');
    await bus.publish('y');
    off();
    await bus.publish('x');
    expect(all).toHaveBeenCalledTimes(3);
    expect(only).toHaveBeenCalledTimes(1);
  });

  test('publishing an event nobody listens to is fine', async () => {
    await expect(new EventBus({ logger: quietLogger() }).publish('nobody')).resolves.toBeUndefined();
  });
});
