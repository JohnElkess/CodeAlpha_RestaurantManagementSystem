jest.mock('node-cron', () => ({ schedule: jest.fn() }));

const cron = require('node-cron');
const { errorHandler, notFoundHandler } = require('../../src/middleware/error_handler');
const { startJobs } = require('../../src/jobs/scheduler');
const { createLogger } = require('../../src/utils/logger');
const { SystemClock, FixedClock } = require('../../src/utils/clock');
const { AppError, BadRequestError, UnauthorizedError, ForbiddenError, NotFoundError, ConflictError } = require('../../src/utils/errors');
const { isDuplicateKey, duplicateField } = require('../../src/utils/mongo_errors');

function fakeRes() {
  const res = { headersSent: false };
  res.status = jest.fn((code) => { res.code = code; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  return res;
}
const handle = (err, res = fakeRes()) => {
  const next = jest.fn();
  errorHandler(err, { method: 'GET', originalUrl: '/x' }, res, next);
  return { res, next };
};

describe('error handler', () => {
  test('known application errors keep their status, code, message and details', () => {
    const { res } = handle(new ConflictError('TABLE_TAKEN', 'Taken', { table: 4 }));
    expect([res.code, res.body]).toEqual([409, { error: { code: 'TABLE_TAKEN', message: 'Taken', details: { table: 4 } } }]);
  });

  test.each([
    [new BadRequestError('X', 'm'), 400],
    [new UnauthorizedError(), 401],
    [new ForbiddenError(), 403],
    [new NotFoundError(), 404],
    [new AppError(418, 'TEAPOT', 'short and stout'), 418],
  ])('%s maps to its status', (err, status) => expect(handle(err).res.code).toBe(status));

  test('Mongoose validation errors become a field-level 400', () => {
    const err = Object.assign(new Error('v'), { name: 'ValidationError', errors: { stock: { path: 'stock', message: 'must be whole' } } });
    const { res } = handle(err);
    expect(res.code).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ path: 'stock', message: 'must be whole' }] });
  });

  test('cast errors, duplicate keys and oversized bodies get their own status', () => {
    expect(handle(Object.assign(new Error('c'), { name: 'CastError' })).res.body.error.code).toBe('INVALID_ID');
    expect(handle(Object.assign(new Error('d'), { code: 11000 })).res).toMatchObject({ code: 409 });
    expect(handle(Object.assign(new Error('t'), { type: 'entity.too.large' })).res.code).toBe(413);
  });

  test('anything unexpected is a generic 500 that does not leak internals', () => {
    const { res } = handle(new Error('connection string mongodb://user:secret@host failed'));
    expect(res.code).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/secret|mongodb/);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  test('if a response has already started, the error is passed on instead of writing twice', () => {
    const res = fakeRes();
    res.headersSent = true;
    const { next } = handle(new Error('late'), res);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('unmatched routes answer with the same format and ignore the query string', () => {
    const res = fakeRes();
    notFoundHandler({ method: 'GET', originalUrl: '/api/x?token=secret' }, res);
    expect(res.code).toBe(404);
    expect(res.body.error.message).toBe('No route for GET /api/x');
  });
});

describe('mongo error helpers', () => {
  test('recognise duplicate-key errors and the offending field', () => {
    expect(isDuplicateKey({ code: 11000 })).toBe(true);
    expect(isDuplicateKey(new Error('x'))).toBe(false);
    expect(isDuplicateKey(null)).toBe(false);
    expect(duplicateField({ keyPattern: { phone: 1 } })).toBe('phone');
    expect(duplicateField({ keyValue: { email: 'a@b.c' } })).toBe('email');
    expect(duplicateField({})).toBeUndefined();
  });
});

describe('job scheduler', () => {
  test('schedules one task per minute that runs every job in order, and can be stopped', async () => {
    const stop = jest.fn();
    cron.schedule.mockReturnValue({ stop });
    const order = [];
    const jobs = [{ name: 'a', run: async () => order.push('a') }, { name: 'b', run: async () => order.push('b') }];
    const stopJobs = startJobs({ jobs, logger: { info: jest.fn() } });

    expect(cron.schedule).toHaveBeenCalledWith('* * * * *', expect.any(Function));
    await cron.schedule.mock.calls[0][1]();
    expect(order).toEqual(['a', 'b']);
    stopJobs();
    expect(stop).toHaveBeenCalled();
  });
});

describe('logger', () => {
  let log;
  let error;
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  test('silent writes nothing', () => {
    const logger = createLogger('silent');
    logger.error('x');
    logger.info('y');
    expect([log.mock.calls.length, error.mock.calls.length]).toEqual([0, 0]);
  });

  test('writes one JSON line per message, errors to stderr, and honours the level', () => {
    const logger = createLogger('warn');
    logger.info('hidden');
    logger.warn('careful', { table: 3 });
    logger.error('broken');
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ level: 'warn', message: 'careful', table: 3 });
    expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({ level: 'error', message: 'broken' });
  });
});

describe('clocks', () => {
  test('SystemClock returns the current time', () => {
    expect(Math.abs(new SystemClock().now() - Date.now())).toBeLessThan(1000);
  });

  test('FixedClock stands still until moved, and hands out copies', () => {
    const clock = new FixedClock('2026-11-10T15:00:00Z');
    const first = clock.now();
    first.setFullYear(1999); // mutating the returned date must not change the clock
    expect(clock.now().toISOString()).toBe('2026-11-10T15:00:00.000Z');
    clock.advanceMinutes(90);
    expect(clock.now().toISOString()).toBe('2026-11-10T16:30:00.000Z');
    clock.set('2027-01-01T00:00:00Z');
    expect(clock.now().getUTCFullYear()).toBe(2027);
  });

  test('an invalid date is refused at once', () => {
    expect(() => new FixedClock('not a date')).toThrow(/invalid date/);
  });
});
