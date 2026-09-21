import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rankAndSlice, select } from '../../src/pipeline/select';
import { GithubRepo } from '../../src/clients/github.gql';

// 测试工厂: 构造一个 repo with可控 firstSeenAt + starsWithin
function mkRepo(opts: {
  name: string;
  hoursAgo: number; // firstSeenAt 距 fake now 多少小时
  starsWithin: number;
  starsBefore?: number;
  starsRecent?: number; // 窗口后半段 star 数(accel 分子); 默认 0 与分母相抵 => accel=1 中性
  starsEarlier?: number; // 窗口前半段 star 数(accel 分母); 默认 0 => (0+1)/(0+1)=1
  stargazerAgeDays?: number; // stargazers[0].createdAt 距 fake now 多少天
}): GithubRepo {
  const nowMs = new Date().getTime();
  // hoursSince() 用 new Date('YYYY-MM-DD HH:MM:SS') 按本地时区解析;
  // 工厂若给 UTC 字符串, 解析回的时间会带时区偏移, 绝对值断言会偏。
  // 这里用本地时间格式化, 让 hoursAgo 参数被精确还原。
  const firstSeenDate = new Date(nowMs - opts.hoursAgo * 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const firstSeen =
    `${firstSeenDate.getFullYear()}-${pad(firstSeenDate.getMonth() + 1)}-${pad(firstSeenDate.getDate())}` +
    ` ${pad(firstSeenDate.getHours())}:${pad(firstSeenDate.getMinutes())}:${pad(firstSeenDate.getSeconds())}`;
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
      firstSeenAt: firstSeen,
      starsWithin: String(opts.starsWithin),
      starsBefore: String(opts.starsBefore ?? 0),
      starsRecent: String(opts.starsRecent ?? 0),
      starsEarlier: String(opts.starsEarlier ?? 0),
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
      // a-f 的 starsPerHour 恰好全为 100; g 给出真实的最高速度(≈114.3)
      mkRepo({ name: 'g', hoursAgo: 7, starsWithin: 800 }),
    ];

    const out = select(repos);

    expect(out).toHaveLength(3);
    // starsPerHour 高的 (>starsWithin/age)排前
    expect(out[0]!.nameWithOwner).toBe('g');
  });
});

// specs/0001 D2: 加速度乘数
describe('rankAndSlice 加速度', () => {
  // 夹具必须挂在 beforeEach 里构造: 模块加载发生在 fake timers 之前,
  // 若在模块级用 new Date() 生成 firstSeen, 会与测试体内的 fake now 差出真实时差,
  // 绝对值断言全部失真。
  let highAccel: GithubRepo;
  let lowAccel: GithubRepo;

  beforeEach(() => {
    // 锁死时间: mkRepo 与 rankAndSlice 都用 new Date(), 冻结后 hoursSince 无毫秒漂移,
    // 绝对值断言(toBeCloseTo 4 位)才稳定
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));

    // 两 repo 速度/账龄一致, 仅 accel 分布不同:
    //   high-accel: recent=600 earlier=200 (加速中)
    //   low-accel:  recent=200 earlier=600 (减速中)
    highAccel = mkRepo({
      name: 'a/high-accel',
      hoursAgo: 96,
      starsWithin: 800,
      starsRecent: 600,
      starsEarlier: 200,
      stargazerAgeDays: 730,
    });
    lowAccel = mkRepo({
      name: 'b/low-accel',
      hoursAgo: 96,
      starsWithin: 800,
      starsRecent: 200,
      starsEarlier: 600,
      stargazerAgeDays: 730,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.SELECT_ACCEL_WEIGHT;
    delete process.env.SELECT_FRESH_HOURS;
    delete process.env.SCAN_WINDOW_DAYS;
  });

  it('W=0.5 时 accel 高者胜出', () => {
    process.env.SCAN_WINDOW_DAYS = '7';
    process.env.SELECT_ACCEL_WEIGHT = '0.5';
    const ranked = rankAndSlice([lowAccel, highAccel], 2);
    expect(ranked[0]!.nameWithOwner).toBe('a/high-accel');
    expect(ranked[1]!.nameWithOwner).toBe('b/low-accel');
  });

  it('W=0 完全等价旧版纯 starsPerHour 口径(accel 不影响排序)', () => {
    process.env.SCAN_WINDOW_DAYS = '7';
    process.env.SELECT_ACCEL_WEIGHT = '0';
    const ranked = rankAndSlice([lowAccel, highAccel], 2);
    // 速度账龄一致 => 分数一致, accel 关闭时不应有偏好
    expect(ranked[0]!.score).toBeCloseTo(ranked[1]!.score, 6);
  });

  it('score 符合 starsPerHour × 账龄 × accel乘数 公式', () => {
    process.env.SCAN_WINDOW_DAYS = '7';
    process.env.SELECT_ACCEL_WEIGHT = '0.5';
    const [repo] = rankAndSlice([highAccel], 1);
    // starsPerHour = 800/96, 账龄因子 = 730/365,
    // accel = 601/201 ≈ 2.9900 (未触顶), 乘数 = 1 + 0.5*(2.9900-1)
    const expected = (800 / 96) * (730 / 365) * (1 + 0.5 * (601 / 201 - 1));
    expect(repo!.score).toBeCloseTo(expected, 4);
  });

  it('accel 上限 clamp 到 3: earlier=0 时乘数封顶 2.0(W=0.5)', () => {
    process.env.SCAN_WINDOW_DAYS = '7';
    process.env.SELECT_ACCEL_WEIGHT = '0.5';
    // 通道 B 形态: earlier=0, recent 巨大 -> 原始 accel 巨大但应被 clamp
    const zeroBase = mkRepo({
      name: 'a/zero-base',
      hoursAgo: 96,
      starsWithin: 300,
      starsRecent: 300,
      starsEarlier: 0,
      stargazerAgeDays: 730,
    });
    const [repo] = rankAndSlice([zeroBase], 1);
    const expected = (300 / 96) * (730 / 365) * 2.0; // 乘数封顶
    expect(repo!.score).toBeCloseTo(expected, 4);
  });

  it('accel 下限 clamp 到 0.5: recent=0 时乘数 0.75(W=0.5)', () => {
    process.env.SCAN_WINDOW_DAYS = '7';
    process.env.SELECT_ACCEL_WEIGHT = '0.5';
    const fading = mkRepo({
      name: 'a/fading',
      hoursAgo: 96,
      starsWithin: 300,
      starsRecent: 0,
      starsEarlier: 300,
      stargazerAgeDays: 730,
    });
    const [repo] = rankAndSlice([fading], 1);
    const expected = (300 / 96) * (730 / 365) * 0.75;
    expect(repo!.score).toBeCloseTo(expected, 4);
  });

  it('eval 回溯模式下 fresh bucket 扣除 eval 偏移(相对 eval date 判新)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));
    try {
      process.env.SCAN_WINDOW_DAYS = '7';
      process.env.SELECT_FRESH_HOURS = '24';
      // eval date 设在 24h 前; 该 repo 相对 eval date 只出现了 6h(30-24), 应属 fresh
      process.env.SCAN_EVAL_DATE = '2026-09-18T12:00:00Z';
      const freshInEval = mkRepo({ name: 'a/fresh-in-eval', hoursAgo: 30, starsWithin: 60 });
      // 高分但相对 eval 已 72h, 属 legacy bucket
      const legacyInEval = mkRepo({
        name: 'a/legacy-in-eval',
        hoursAgo: 96,
        starsWithin: 4000,
        starsBefore: 100,
      });

      const ranked = rankAndSlice([legacyInEval, freshInEval], 2);
      // fresh bucket 永远排在 legacy 前, 即使分数更低
      expect(ranked[0]!.nameWithOwner).toBe('a/fresh-in-eval');
    } finally {
      vi.useRealTimers();
      delete process.env.SCAN_EVAL_DATE;
    }
  });
});
