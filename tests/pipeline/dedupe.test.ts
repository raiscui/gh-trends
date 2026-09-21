import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dedupe, recordPublished } from '../../src/pipeline/dedupe';
import { makeRepo } from '../helpers';

// specs/0001 D3: 发布去重记忆
describe('dedupe / recordPublished', () => {
  let dir: string;
  let memoryPath: string;
  const now = new Date('2026-09-19T12:00:00Z');

  // 90 天内/外的发布日期锚点
  const daysAgoStr = (days: number) =>
    new Date(now.getTime() - days * 86400e3).toISOString().slice(0, 10);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-trends-dedupe-'));
    memoryPath = path.join(dir, 'published.json');
    process.env.PUBLISHED_MEMORY_ENABLED = 'true';
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.PUBLISHED_MEMORY_ENABLED;
  });

  it('剔除 90 天内已发布的项目, 保留期外的放行', () => {
    fs.writeFileSync(
      memoryPath,
      JSON.stringify({
        'recent/rep': daysAgoStr(10), // 10 天前发布 -> 应剔除
        'stale/rep': daysAgoStr(100), // 100 天前发布 -> 已出保留期, 放行
      })
    );
    const repos = [
      makeRepo({ name: 'recent/rep' }),
      makeRepo({ name: 'stale/rep' }),
      makeRepo({ name: 'brand/new' }),
    ];
    const kept = dedupe(repos, memoryPath, now);
    expect(kept.map(r => r.nameWithOwner)).toEqual(['stale/rep', 'brand/new']);
  });

  it('记录文件缺失时降级为全通过', () => {
    const repos = [makeRepo({ name: 'a/b' })];
    expect(dedupe(repos, memoryPath, now)).toHaveLength(1);
  });

  it('记录文件损坏(JSON 非法)时降级为全通过, 不抛异常', () => {
    fs.writeFileSync(memoryPath, '{not valid json');
    const repos = [makeRepo({ name: 'a/b' })];
    expect(dedupe(repos, memoryPath, now)).toHaveLength(1);
  });

  it('PUBLISHED_MEMORY_ENABLED 关闭时原样返回且不写文件', () => {
    process.env.PUBLISHED_MEMORY_ENABLED = 'false';
    const repos = [makeRepo({ name: 'a/b' })];
    expect(dedupe(repos, memoryPath, now)).toHaveLength(1);
    recordPublished(['a/b'], memoryPath, now);
    expect(fs.existsSync(memoryPath)).toBe(false);
  });

  it('recordPublished 合并写入并清理过期条目, 随后 dedupe 生效', () => {
    fs.writeFileSync(memoryPath, JSON.stringify({ 'old/gone': daysAgoStr(100) }));
    recordPublished(['x/one', 'x/two'], memoryPath, now);

    const onDisk = JSON.parse(fs.readFileSync(memoryPath, 'utf-8'));
    // 过期条目被清理, 新条目带上发布日期
    expect(onDisk).toEqual({ 'x/one': '2026-09-19', 'x/two': '2026-09-19' });

    // 刚记录的项目在下一次 dedupe 中被剔除
    const kept = dedupe([makeRepo({ name: 'x/one' }), makeRepo({ name: 'y/ok' })], memoryPath, now);
    expect(kept.map(r => r.nameWithOwner)).toEqual(['y/ok']);
  });
});
