import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('TDS check scenarios', () => {
  it('every scenario in scripts/tds-scenarios deducts exactly the tax owed', () => {
    const out = execFileSync(process.execPath, [path.resolve(__dirname, '../../scripts/tds-check.js'), '--all'], { encoding: 'utf8' });
    const verdicts = out.split('\n').filter((l) => /^(PASS|FAIL|SHORT|OVER|IN PROGRESS)/.test(l));
    expect(verdicts.length).toBeGreaterThanOrEqual(10);
    expect(verdicts.filter((l) => !l.startsWith('PASS'))).toEqual([]);
  });
});
