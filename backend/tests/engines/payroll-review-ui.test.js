import { describe, expect, it, vi } from 'vitest';
import { cachePayrollPeriod, payrollStepLabel } from '../../../frontend/src/utils/payroll-workflow.js';
describe('Confirmed payroll review state', () => {
  it('cancels older reads before updating the confirmed state', async () => {
    let release;
    const gate = new Promise(r => release = r),
      client = {
        cancelQueries: vi.fn(() => gate),
        setQueryData: vi.fn()
      };
    const period = {
      period_ym: '2026-09',
      steps_submitted: [1]
    };
    const saved = cachePayrollPeriod(client, '2026-09', {
      data: period
    });
    expect(client.setQueryData).not.toHaveBeenCalled();
    release();
    expect(await saved).toBe(true);
    expect(client.setQueryData).toHaveBeenCalledWith(['period', '2026-09'], period);
  });
  it('never overwrites a different month or accepts an incomplete response', async () => {
    const client = {
      cancelQueries: vi.fn(),
      setQueryData: vi.fn()
    };
    expect(await cachePayrollPeriod(client, '2026-09', {
      data: {
        period_ym: '2026-10',
        steps_submitted: []
      }
    })).toBe(false);
    expect(await cachePayrollPeriod(client, '2026-09', {
      data: {
        period_ym: '2026-09'
      }
    })).toBe(false);
    expect(client.setQueryData).not.toHaveBeenCalled();
  });
  it('keeps familiar names for each review without exposing internal stage names', () => {
    expect(payrollStepLabel(3)).toBe('Employee checks');
    expect(payrollStepLabel(6)).toBe('One-time adjustments');
    expect(payrollStepLabel(7)).toBe('Generate payroll');
  });
});
