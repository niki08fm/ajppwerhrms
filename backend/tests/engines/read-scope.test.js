import { describe, expect, it, vi } from 'vitest';
import { scopedRead, withReadScope, scopeReadRequests } from '../../src/utils/read-scope.js';
import { mapConcurrent } from '../../src/utils/parallel.js';
describe('Read scope isolation', () => {
  it('shares a pending read and reuses it only in that read operation', async () => {
    const db = {},
      load = vi.fn(async () => ({
        value: 1
      }));
    await withReadScope(async () => {
      const [a, b] = await Promise.all([scopedRead(db, 'rates', load), scopedRead(db, 'rates', load)]);
      expect(a).toBe(b);
      expect(load).toHaveBeenCalledTimes(1);
    });
    await withReadScope(() => scopedRead(db, 'rates', load));
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('keeps parallel requests, database transactions and different keys independent', async () => {
    const a = {},
      b = {},
      load = vi.fn(async () => Math.random());
    await Promise.all([withReadScope(() => Promise.all([scopedRead(a, 'a', load), scopedRead(b, 'a', load), scopedRead(a, 'b', load)])), withReadScope(() => scopedRead(a, 'a', load))]);
    expect(load).toHaveBeenCalledTimes(4);
  });
  it('does not retain failed reads or cache mutation requests', async () => {
    const db = {},
      load = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue('ready');
    await withReadScope(async () => {
      await expect(scopedRead(db, 'x', load)).rejects.toThrow('down');
      expect(await scopedRead(db, 'x', load)).toBe('ready');
    });
    const write = vi.fn(async () => 1);
    await scopeReadRequests({
      method: 'POST'
    }, null, () => Promise.all([scopedRead(db, 'x', write), scopedRead(db, 'x', write)]));
    expect(write).toHaveBeenCalledTimes(2);
  });
  it('starts independent work together with a bounded concurrency and preserves order', async () => {
    let active = 0,
      maximum = 0;
    const gates = [];
    const task = mapConcurrent([0, 1, 2, 3], 2, async n => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise(r => gates[n] = r);
      active--;
      return n;
    });
    expect(active).toBe(2);
    gates[1]();
    await new Promise(r => setImmediate(r));
    expect(gates[2]).toBeTypeOf('function');
    gates[2]();
    await new Promise(r => setImmediate(r));
    gates[3]();
    gates[0]();
    expect(await task).toEqual([0, 1, 2, 3]);
    expect(maximum).toBe(2);
  });
});
