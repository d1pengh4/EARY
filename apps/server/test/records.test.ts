import { describe, expect, test } from 'bun:test';
import { initialState } from '@eary/core';
import { CallRecords } from '../src/records';

describe('통화 기록 저장', () => {
  test('저장·삭제·보관 기간', async () => {
    const r = new CallRecords(':memory:', 7);
    const s = { ...initialState('c1'), startedAt: new Date().toISOString(), review: { title: 't', durationMs: 1, endedAt: new Date().toISOString(), summary: { text: 's', by: 'rule' as const }, moments: [], open: [] } };
    r.save(s);
    expect(r.has('c1')).toBe(true);
    expect(r.list()[0]!.title).toBe('t');
    expect(r.delete('c1')).toBe(true);
    expect(r.has('c1')).toBe(false);
    const old = new CallRecords(':memory:', 0);
    old.save(s);
    await Bun.sleep(5);
    expect(old.purge()).toBe(1);
  });
});
