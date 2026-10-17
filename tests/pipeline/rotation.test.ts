import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rotateTail, recordRotation, RotationOpts } from '../../src/pipeline/rotation';
import { ScoredRepo } from '../../src/pipeline/select';
import { makeRepo } from '../helpers';

// 生态榜尾部轮换(ADR-0003 决策 2 修订):
// 头部槽位稳态常驻, 尾部按独立记忆做短周期轮换。
describe('pipeline/rotation.ts', () => {
  let dir: string;
  let memoryPath: string;
  const now = new Date('2026-10-16T12:00:00Z');
  const opts: RotationOpts = { headSlots: 3, retentionDays: 1 };

  const daysAgoStr = (days: number) =>
    new Date(now.getTime() - days * 86400e3).toISOString().slice(0, 10);

  // 造 n 个按名次递减的 scored repo, 名字 r0..r(n-1)
  function pool(n: number): ScoredRepo[] {
    return Array.from({ length: n }, (_, i) => ({
      ...makeRepo({ name: `eco/r${i}`, stargazerCount: 1000 - i }),
      score: 100 - i,
    }));
  }

  const names = (repos: ScoredRepo[]) => repos.map(r => r.nameWithOwner);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-trends-rotation-'));
    memoryPath = path.join(dir, 'published_ecosystem.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('头部槽位原样保留, 不参与轮换', () => {
    // 头部三个全部"昨天上过榜", 仍应留在头部
    fs.writeFileSync(
      memoryPath,
      JSON.stringify({
        'eco/r0': daysAgoStr(1),
        'eco/r1': daysAgoStr(1),
        'eco/r2': daysAgoStr(1),
      })
    );

    const out = rotateTail(pool(10), 6, opts, memoryPath, now);

    expect(names(out).slice(0, 3)).toEqual(['eco/r0', 'eco/r1', 'eco/r2']);
  });

  it('尾部剔除保留期内已上榜项目, 由后续名次顶上', () => {
    fs.writeFileSync(
      memoryPath,
      JSON.stringify({ 'eco/r3': daysAgoStr(1), 'eco/r4': daysAgoStr(1) })
    );

    const out = rotateTail(pool(10), 6, opts, memoryPath, now);

    // 头部 r0-r2 不动; r3/r4 昨天上过榜被剔, 由 r5/r6/r7 顶上
    expect(names(out)).toEqual(['eco/r0', 'eco/r1', 'eco/r2', 'eco/r5', 'eco/r6', 'eco/r7']);
  });

  it('保留期外的记录不影响轮换', () => {
    fs.writeFileSync(memoryPath, JSON.stringify({ 'eco/r3': daysAgoStr(5) }));

    const out = rotateTail(pool(10), 6, opts, memoryPath, now);

    expect(names(out)).toEqual(['eco/r0', 'eco/r1', 'eco/r2', 'eco/r3', 'eco/r4', 'eco/r5']);
  });

  it('候选不足时按原排序回退填满, 并 WARN', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 尾部池只有 r3/r4 两个, 且都昨天上过榜 -> 只能回退
    fs.writeFileSync(
      memoryPath,
      JSON.stringify({ 'eco/r3': daysAgoStr(1), 'eco/r4': daysAgoStr(1) })
    );

    const out = rotateTail(pool(5), 6, opts, memoryPath, now);

    expect(out).toHaveLength(5);
    expect(names(out)).toEqual(['eco/r0', 'eco/r1', 'eco/r2', 'eco/r3', 'eco/r4']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('eco'));
  });

  it('记忆文件缺失时全部视为未上榜', () => {
    const out = rotateTail(pool(10), 6, opts, memoryPath, now);

    expect(names(out)).toEqual(['eco/r0', 'eco/r1', 'eco/r2', 'eco/r3', 'eco/r4', 'eco/r5']);
  });

  it('记忆文件损坏时降级为全通过, 不抛异常', () => {
    fs.writeFileSync(memoryPath, '{not valid json');

    const out = rotateTail(pool(10), 6, opts, memoryPath, now);

    expect(out).toHaveLength(6);
  });

  it('retentionDays <= 0 时关闭轮换, 原样返回前 topN', () => {
    fs.writeFileSync(memoryPath, JSON.stringify({ 'eco/r3': daysAgoStr(0) }));

    const out = rotateTail(pool(10), 6, { headSlots: 3, retentionDays: 0 }, memoryPath, now);

    expect(names(out)).toEqual(['eco/r0', 'eco/r1', 'eco/r2', 'eco/r3', 'eco/r4', 'eco/r5']);
  });

  it('池子短于 topN 时按实际条数出榜', () => {
    const out = rotateTail(pool(4), 6, opts, memoryPath, now);

    expect(out).toHaveLength(4);
  });

  it('headSlots 超过 topN 时被夹到 topN, 不产生负数尾部配额', () => {
    fs.writeFileSync(memoryPath, JSON.stringify({ 'eco/r0': daysAgoStr(1) }));

    const out = rotateTail(pool(10), 3, { headSlots: 15, retentionDays: 1 }, memoryPath, now);

    expect(out).toHaveLength(3);
    expect(names(out)).toEqual(['eco/r0', 'eco/r1', 'eco/r2']);
  });

  it('recordRotation 写入发布日期并清理过期条目', () => {
    fs.writeFileSync(memoryPath, JSON.stringify({ 'eco/gone': daysAgoStr(9) }));

    recordRotation(['eco/r3', 'eco/r4'], memoryPath, 1, now);

    expect(JSON.parse(fs.readFileSync(memoryPath, 'utf-8'))).toEqual({
      'eco/r3': '2026-10-16',
      'eco/r4': '2026-10-16',
    });
  });

  it('recordRotation 写出的记忆能被下一次 rotateTail 读到', () => {
    recordRotation(['eco/r3'], memoryPath, 1, now);

    const out = rotateTail(pool(10), 6, opts, memoryPath, now);

    expect(names(out)[3]).toBe('eco/r4');
  });

  it('retentionDays <= 0 时 recordRotation 不写文件', () => {
    recordRotation(['eco/r3'], memoryPath, 0, now);

    expect(fs.existsSync(memoryPath)).toBe(false);
  });
});
