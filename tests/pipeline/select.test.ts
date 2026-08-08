import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { select } from '../../src/pipeline/select';
import { GithubRepo } from '../../src/clients/github.gql';

// 测试工厂: 构造一个 repo with可控 firstSeenAt + starsWithin
function mkRepo(opts: {
  name: string;
  hoursAgo: number; // firstSeenAt 距 fake now 多少小时
  starsWithin: number;
  starsBefore?: number;
  stargazerAgeDays?: number; // stargazers[0].createdAt 距 fake now 多少天
}): GithubRepo {
  const nowMs = new Date().getTime();
  const firstSeen = new Date(nowMs - opts.hoursAgo * 3600_000).toISOString();
  const stargazerCreated = new Date(
    nowMs - (opts.stargazerAgeDays ?? 1000) * 86400_000
  ).toISOString();
  return {
    nameWithOwner: opts.name,
    url: `https://github.com/${opts.name}`,
    description: '[description]',
    primaryLanguage: { name: 'TypeScript' },
    createdAt: new Date(nowMs - 86400_000).toISOString(),
    stargazerCount: opts.starsWithin,
    owner: { __typename: 'Organization', createdAt: '2020-01-01T00:00:00Z' },
    clickhouse: {
      repoName: opts.name,
      firstSeenAt: firstSeen.slice(0, 19).replace('T', ' '),
      starsWithin: String(opts.starsWithin),
      starsBefore: String(opts.starsBefore ?? 0),
    },
    stargazers: { nodes: [{ createdAt: stargazerCreated }] },
  };
}

describe('select.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T12:00:00Z'));
    vi.stubEnv('RELEASE_TOP_N', '5');
    vi.stubEnv('SCAN_WINDOW_DAYS', '7');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('fresh repo with lower score beats older repo at higher score (default SELECT_FRESH_HOURS=24)', () => {
    vi.stubEnv('SELECT_FRESH_HOURS', '24');

    const hotButOld = mkRepo({
      name: 'hot-but-old',
      hoursAgo: 96, // 4 days old -> legacy bucket
      starsWithin: 4000,
      starsBefore: 100,
    });
    const warmButFresh = mkRepo({
      name: 'warm-but-fresh',
      hoursAgo: 6, // 6h old -> fresh bucket
      starsWithin: 200,
      starsBefore: 0,
    });

    const out = select([hotButOld, warmButFresh]);

    // 即使 hot-but-old score 高(heavily trending 4 天),
    // fresh bucket 仍优先于 legacy bucket。
    expect(out.map(r => r.nameWithOwner)).toEqual(['warm-but-fresh', 'hot-but-old']);
  });

  it('inside the same bucket, sort by score desc', () => {
    vi.stubEnv('SELECT_FRESH_HOURS', '24');

    const freshA = mkRepo({
      name: 'fresh-a',
      hoursAgo: 1,
      starsWithin: 100, // starsPerHour ≈ 100
    });
    const freshB = mkRepo({
      name: 'fresh-b',
      hoursAgo: 12,
      starsWithin: 2400, // starsPerHour ≈ 200
    });
    const freshC = mkRepo({
      name: 'fresh-c',
      hoursAgo: 23,
      starsWithin: 1100,
    });

    const out = select([freshA, freshB, freshC]);

    // 都在 fresh bucket,按 starsPerHour(=score 主导因子)降序。
    expect(out.map(r => r.nameWithOwner)).toEqual(['fresh-b', 'fresh-a', 'fresh-c']);
  });

  it('SELECT_FRESH_HOURS=0 disables the fresh bucket (legacy behaviour)', () => {
    vi.stubEnv('SELECT_FRESH_HOURS', '0');

    const hotButOld = mkRepo({
      name: 'hot-but-old',
      hoursAgo: 96,
      starsWithin: 4000,
      starsBefore: 100,
    });
    const warmButFresh = mkRepo({
      name: 'warm-but-fresh',
      hoursAgo: 6,
      starsWithin: 200,
      starsBefore: 0,
    });

    const out = select([hotButOld, warmButFresh]);

    // fresh bucket 关闭,纯按 score 排序。hot-but-old 排前。
    expect(out.map(r => r.nameWithOwner)).toEqual(['hot-but-old', 'warm-but-fresh']);
  });

  it('returns at most RELEASE_TOP_N repos', () => {
    vi.stubEnv('SELECT_FRESH_HOURS', '24');
    vi.stubEnv('RELEASE_TOP_N', '3');

    const repos = [
      mkRepo({ name: 'a', hoursAgo: 1, starsWithin: 100 }),
      mkRepo({ name: 'b', hoursAgo: 2, starsWithin: 200 }),
      mkRepo({ name: 'c', hoursAgo: 3, starsWithin: 300 }),
      mkRepo({ name: 'd', hoursAgo: 4, starsWithin: 400 }),
      mkRepo({ name: 'e', hoursAgo: 5, starsWithin: 500 }),
      mkRepo({ name: 'f', hoursAgo: 6, starsWithin: 600 }),
      mkRepo({ name: 'g', hoursAgo: 7, starsWithin: 700 }),
    ];

    const out = select(repos);

    expect(out).toHaveLength(3);
    // starsPerHour 高的 (>starsWithin/age)排前
    expect(out[0]!.nameWithOwner).toBe('g');
  });
});
