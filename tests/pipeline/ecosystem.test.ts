import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_VIDEO_EDITOR_BOARD,
  VERCEL_AI_SDK_BOARD,
  buildEcosystemBoard,
  isVercelAiSdkEcosystemMember,
  persistEcosystemRotation,
  type EcosystemBoardConfig,
} from '../../src/pipeline/ecosystem';
import { ScoredRepo } from '../../src/pipeline/select';
import { GitHubTopicClient, TopicCandidate } from '../../src/clients/github.topics';
import { ClickHouseClient, ClickHouseRepo } from '../../src/clients/clickhouse';
import { GitHubGraphQLClient, GithubRepo } from '../../src/clients/github.gql';
import { makeRepo } from '../helpers';

// ADR-0003: 生态榜编排。三个外部 client 全部 spy 掉, 只验证编排逻辑本身:
// 取数 -> 增速 join -> 粗排截断 -> enrich -> 复用 filter + rankAndSlice。
describe('pipeline/ecosystem.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    vi.stubEnv('FILTER_MIN_STARS', '40');
    vi.stubEnv('SELECT_FRESH_HOURS', '0');
    vi.stubEnv('SELECT_ACCEL_WEIGHT', '0');
    vi.stubEnv('ECOSYSTEM_WINDOW_DAYS', '28');
    vi.stubEnv('RELEASE_TOP_N_VERCEL_AI_SDK', '30');
    vi.stubEnv('RELEASE_TOP_N_AI_VIDEO_EDITOR', '30');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  // 构造一条完整的取数链路: topic 候选 -> 增速 -> enrich 回填。
  //
  // 关键: getRepos 必须把传入的 clickhouse 行挂回 repo(生产里就是
  // `clickhouse: batch[i]`), 否则 rankAndSlice 会拿 makeRepo 的默认
  // starsWithin 排序, 测试就变成在验证假数据而非真实增速排序。
  function stubPipeline(
    candidates: TopicCandidate[],
    growth: Partial<ClickHouseRepo>[],
    enriched?: GithubRepo[]
  ) {
    const rows = growth.map(g => ({
      repoName: '',
      starsBefore: '0',
      starsWithin: '0',
      starsRecent: '0',
      starsEarlier: '0',
      firstSeenAt: '2026-09-01 00:00:00',
      ...g,
    })) as ClickHouseRepo[];

    vi.spyOn(GitHubTopicClient.prototype, 'searchByTopics').mockResolvedValue(candidates);
    vi.spyOn(ClickHouseClient.prototype, 'getRepoGrowth').mockResolvedValue(rows);
    vi.spyOn(GitHubGraphQLClient.prototype, 'getRepos').mockImplementation(async chRows => {
      if (enriched) return enriched;
      return chRows.map(row => ({
        ...makeRepo({
          name: row.repoName,
          stargazerCount:
            candidates.find(c => c.nameWithOwner === row.repoName)?.stargazerCount ?? 100,
        }),
        clickhouse: row,
      }));
    });
  }

  // 默认给精确 topic, 让候选能通过 Vercel 榜的成员判定;
  // 判定本身的用例显式传 topics / description 覆盖
  const candidate = (name: string, stars = 500, topics = ['vercel-ai-sdk']): TopicCandidate => ({
    nameWithOwner: name,
    stargazerCount: stars,
    description: `${name} description`,
    topics,
  });

  describe('榜单配置(单一真相源)', () => {
    it('Vercel AI SDK 用作者主动打的生态 topic', () => {
      expect(VERCEL_AI_SDK_BOARD.key).toBe('vercelAiSdk');
      expect(VERCEL_AI_SDK_BOARD.topics).toEqual(['ai-sdk', 'vercel-ai-sdk']);
    });

    it('AI Video Editor 以 ai-video-editor 为主信号, 另两个 topic 补量', () => {
      expect(AI_VIDEO_EDITOR_BOARD.key).toBe('aiVideoEditor');
      expect(AI_VIDEO_EDITOR_BOARD.topics[0]).toBe('ai-video-editor');
      expect(AI_VIDEO_EDITOR_BOARD.topics).toContain('video-editing');
    });

    it('两榜 top-N env 名与 .env.example 一致', () => {
      expect(VERCEL_AI_SDK_BOARD.topNEnv).toBe('RELEASE_TOP_N_VERCEL_AI_SDK');
      expect(AI_VIDEO_EDITOR_BOARD.topNEnv).toBe('RELEASE_TOP_N_AI_VIDEO_EDITOR');
    });

    it('Vercel 榜兜底 top-N 为 20(池内有效增速条目约 14, 30 会填零增长)', () => {
      expect(VERCEL_AI_SDK_BOARD.topNDefault).toBe(20);
    });

    it('视频榜不设成员收窄 —— 三个 topic 都带明确视频语义', () => {
      expect(AI_VIDEO_EDITOR_BOARD.refine).toBeUndefined();
    });
  });

  // 2026-10-04 收紧:`ai-sdk` 语义过宽, 需叠加 vercel 佐证
  describe('Vercel AI SDK 成员判定(分层收紧)', () => {
    const member = (c: TopicCandidate) => isVercelAiSdkEcosystemMember(c);

    it('精确 topic vercel-ai-sdk 直接入榜, 不要求 name/desc 佐证', () => {
      expect(member(candidate('dzhng/jevgrep', 2216, ['vercel-ai-sdk']))).toBe(true);
    });

    it('泛用 topic ai-sdk + name 带 vercel -> 入榜', () => {
      expect(member(candidate('vercel-labs/ai-facts', 500, ['ai-sdk']))).toBe(true);
    });

    it('泛用 topic ai-sdk + description 带 vercel -> 入榜', () => {
      const c = candidate('someone/tool', 500, ['ai-sdk']);
      c.description = 'A provider built for Vercel AI SDK';
      expect(member(c)).toBe(true);
    });

    it('泛用 topic ai-sdk 且无 vercel 佐证 -> 剔除(回归: jevgrep 曾居榜首)', () => {
      expect(member(candidate('dzhng/jevgrep', 2216, ['ai-sdk']))).toBe(false);
      expect(member(candidate('GCWing/OpenBitFun', 2378, ['ai-sdk']))).toBe(false);
    });

    it('佐证匹配大小写不敏感', () => {
      const c = candidate('Someone/VERCEL-Tool', 500, ['ai-sdk']);
      c.description = 'works with Vercel';
      expect(member(c)).toBe(true);
    });

    it('两个 topic 都没有 -> 剔除', () => {
      expect(member(candidate('foo/bar', 500, ['react', 'nextjs']))).toBe(false);
    });

    it('refine 在 ClickHouse 查询之前生效, 噪音候选不进入增速查询', async () => {
      stubPipeline(
        [
          candidate('vercel/ai', 500, ['vercel-ai-sdk']),
          candidate('dzhng/jevgrep', 2216, ['ai-sdk']),
        ],
        [{ repoName: 'vercel/ai', starsWithin: '10', firstSeenAt: '2026-09-30 00:00:00' }]
      );

      await buildEcosystemBoard(VERCEL_AI_SDK_BOARD);

      expect(vi.mocked(ClickHouseClient.prototype.getRepoGrowth).mock.calls[0]![0]).toEqual([
        'vercel/ai',
      ]);
    });

    it('成员判定后无候选时该榜留空', async () => {
      stubPipeline([candidate('dzhng/jevgrep', 2216, ['ai-sdk'])], []);

      expect(await buildEcosystemBoard(VERCEL_AI_SDK_BOARD)).toEqual([]);
    });
  });

  describe('取数编排', () => {
    it('按配置里的 topic 取数, 并把候选名单交给 ClickHouse', async () => {
      stubPipeline([candidate('vercel/ai'), candidate('assistant-ui/assistant-ui')], []);

      await buildEcosystemBoard(VERCEL_AI_SDK_BOARD);

      const searchSpy = vi.mocked(GitHubTopicClient.prototype.searchByTopics);
      expect(searchSpy).toHaveBeenCalledWith(VERCEL_AI_SDK_BOARD.topics);

      const growthSpy = vi.mocked(ClickHouseClient.prototype.getRepoGrowth);
      expect(growthSpy.mock.calls[0]![0]).toEqual(['vercel/ai', 'assistant-ui/assistant-ui']);
    });

    it('增速窗口取 ECOSYSTEM_WINDOW_DAYS(默认 28), 而非主榜的 7 天', async () => {
      stubPipeline([candidate('a/x')], []);

      await buildEcosystemBoard(VERCEL_AI_SDK_BOARD);

      expect(vi.mocked(ClickHouseClient.prototype.getRepoGrowth).mock.calls[0]![1]).toBe(28);
    });

    it('有增速的候选按 starsPerHour 排序后进榜', async () => {
      stubPipeline(
        [candidate('a/slow'), candidate('a/fast')],
        [
          { repoName: 'a/slow', starsWithin: '10', firstSeenAt: '2026-09-30 00:00:00' },
          { repoName: 'a/fast', starsWithin: '500', firstSeenAt: '2026-09-30 00:00:00' },
        ]
      );

      const out = await buildEcosystemBoard(VERCEL_AI_SDK_BOARD);

      expect(out.map(r => r.nameWithOwner)).toEqual(['a/fast', 'a/slow']);
    });

    it('遵守该榜自己的 topN', async () => {
      vi.stubEnv('RELEASE_TOP_N_AI_VIDEO_EDITOR', '2');
      stubPipeline(
        [candidate('a/1'), candidate('a/2'), candidate('a/3')],
        [
          { repoName: 'a/1', starsWithin: '10', firstSeenAt: '2026-09-30 00:00:00' },
          { repoName: 'a/2', starsWithin: '20', firstSeenAt: '2026-09-30 00:00:00' },
          { repoName: 'a/3', starsWithin: '30', firstSeenAt: '2026-09-30 00:00:00' },
        ]
      );

      const out = await buildEcosystemBoard(AI_VIDEO_EDITOR_BOARD);

      expect(out).toHaveLength(2);
    });

    it('粗排保留 3×topN 候选, 把 enrich 的 GraphQL 请求数压在配额内', async () => {
      vi.stubEnv('RELEASE_TOP_N_VERCEL_AI_SDK', '2');
      const many = Array.from({ length: 20 }, (_, i) => candidate(`a/r${i}`));
      stubPipeline(
        many,
        many.map((_, i) => ({
          repoName: `a/r${i}`,
          starsWithin: String(100 - i),
          firstSeenAt: '2026-09-30 00:00:00',
        }))
      );

      await buildEcosystemBoard(VERCEL_AI_SDK_BOARD);

      // topN=2 -> 粗排截断到 6, 即最增速的 6 个才进 enrich
      expect(vi.mocked(GitHubGraphQLClient.prototype.getRepos).mock.calls[0]![0]).toHaveLength(6);
    });

    it('候选池不足 topN 时按实际条数出榜, 不拿零增长项凑数', async () => {
      stubPipeline([candidate('a/only-one')], []);

      const out = await buildEcosystemBoard(VERCEL_AI_SDK_BOARD);

      expect(out).toEqual([]);
    });

    it('仍走主榜的 FILTER_MIN_STARS 质量底线', async () => {
      vi.stubEnv('FILTER_MIN_STARS', '1000');
      stubPipeline(
        [candidate('a/tiny', 5)],
        [{ repoName: 'a/tiny', starsWithin: '50', firstSeenAt: '2026-09-30 00:00:00' }]
      );

      const out = await buildEcosystemBoard(VERCEL_AI_SDK_BOARD);

      expect(out).toEqual([]);
    });
  });

  describe('fail-soft 降级', () => {
    it('topic 搜索无结果 -> 该榜留空', async () => {
      stubPipeline([], []);

      expect(await buildEcosystemBoard(VERCEL_AI_SDK_BOARD)).toEqual([]);
    });

    it('ClickHouse 完全没有增速数据 -> 该榜留空(池内全是未上榜项目)', async () => {
      stubPipeline([candidate('a/x'), candidate('a/y')], []);

      expect(await buildEcosystemBoard(VERCEL_AI_SDK_BOARD)).toEqual([]);
    });

    it('取数抛错时不中断整次发布, 返回空榜', async () => {
      vi.spyOn(GitHubTopicClient.prototype, 'searchByTopics').mockRejectedValue(new Error('boom'));

      await expect(buildEcosystemBoard(VERCEL_AI_SDK_BOARD)).resolves.toEqual([]);
    });
  });

  // 头部稳态 + 尾部轮换(ADR-0003 决策 2 修订)。
  // 实测 10 期里 8 个项目期期满勤, 相邻两期重合 10~13 条 —— 28 天稳态增速
  // 排序下头部位次本就不变, 故只对尾部做短周期轮换。
  describe('尾部轮换', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-trends-eco-'));
      // 覆盖外层 fake time: 轮换保留期按日历天判定, 需要"今天/昨天"语义明确
      vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
      vi.stubEnv('RELEASE_TOP_N_AI_VIDEO_EDITOR', '4');
      vi.stubEnv('ECOSYSTEM_ROTATION_DAYS', '2');
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const memoryPath = () => path.join(dir, 'published_ecosystem.json');

    // 测试专用榜: headSlots 按 topN=4 缩到 2(生产配置 headSlots=15 对应 topN=30,
    // 两者比例一致), 否则 headSlots 会被夹到 topN 而没有尾部可轮换。
    const TEST_BOARD: EcosystemBoardConfig = {
      ...AI_VIDEO_EDITOR_BOARD,
      rotation: {
        headSlots: 2,
        retentionDaysEnv: 'ECOSYSTEM_ROTATION_DAYS',
        retentionDaysDefault: 2,
      },
    };

    // 8 个候选按增速递减排列: fast0 最快 ... fast7 最慢
    function stubDescendingPool() {
      const names = Array.from({ length: 8 }, (_, i) => `eco/fast${i}`);
      stubPipeline(
        names.map(n => candidate(n, 500, ['ai-video-editor'])),
        names.map((n, i) => ({
          repoName: n,
          starsWithin: String(100 - i),
          firstSeenAt: '2026-09-30 00:00:00',
        }))
      );
      return names;
    }

    it('AI Video Editor 榜配置了头部槽位与保留期 env', () => {
      expect(AI_VIDEO_EDITOR_BOARD.rotation).toEqual({
        headSlots: 15,
        retentionDaysEnv: 'ECOSYSTEM_ROTATION_DAYS',
        retentionDaysDefault: 2,
      });
    });

    it('Vercel 榜不轮换 —— 有增速候选仅约 25 个, 池子撑不起轮换', () => {
      expect(VERCEL_AI_SDK_BOARD.rotation).toBeUndefined();
    });

    it('头部原样保留, 尾部换成未上榜的更深候选', async () => {
      const names = stubDescendingPool();
      // 第 3 名 fast2 昨天上过榜
      fs.writeFileSync(memoryPath(), JSON.stringify({ [names[2]!]: '2026-10-15' }));

      const out = await buildEcosystemBoard(TEST_BOARD, memoryPath());

      expect(out.map(r => r.nameWithOwner)).toEqual([
        'eco/fast0',
        'eco/fast1',
        'eco/fast3',
        'eco/fast4',
      ]);
    });

    it('不传记忆路径时按稳态排序出榜(不轮换)', async () => {
      stubDescendingPool();

      const out = await buildEcosystemBoard(TEST_BOARD);

      expect(out.map(r => r.nameWithOwner)).toEqual([
        'eco/fast0',
        'eco/fast1',
        'eco/fast2',
        'eco/fast3',
      ]);
    });

    it('ECOSYSTEM_ROTATION_DAYS=0 关闭轮换', async () => {
      vi.stubEnv('ECOSYSTEM_ROTATION_DAYS', '0');
      const names = stubDescendingPool();
      fs.writeFileSync(memoryPath(), JSON.stringify({ [names[2]!]: '2026-10-15' }));

      const out = await buildEcosystemBoard(TEST_BOARD, memoryPath());

      expect(out.map(r => r.nameWithOwner)).toEqual([
        'eco/fast0',
        'eco/fast1',
        'eco/fast2',
        'eco/fast3',
      ]);
    });

    it('轮换候选耗尽时回退原排序, 条目数不缩水', async () => {
      const names = stubDescendingPool();
      // 尾部 6 个候选全部昨天上过榜
      const tail = Object.fromEntries(names.slice(2).map(n => [n, '2026-10-15']));
      fs.writeFileSync(memoryPath(), JSON.stringify(tail));

      const out = await buildEcosystemBoard(TEST_BOARD, memoryPath());

      expect(out).toHaveLength(4);
      expect(out.map(r => r.nameWithOwner)).toEqual([
        'eco/fast0',
        'eco/fast1',
        'eco/fast2',
        'eco/fast3',
      ]);
    });

    it('persistEcosystemRotation 只回写配置了轮换的榜的尾部', () => {
      const boardRepos = [
        { nameWithOwner: 'eco/a0' },
        { nameWithOwner: 'eco/a1' },
        { nameWithOwner: 'eco/a2' },
      ] as ScoredRepo[];

      persistEcosystemRotation([AI_VIDEO_EDITOR_BOARD], [boardRepos], memoryPath());

      const onDisk = JSON.parse(fs.readFileSync(memoryPath(), 'utf-8'));
      // headSlots=15 > 3 条, 全部落在头部 -> 无尾部可回写
      expect(onDisk).toEqual({});
    });

    it('persistEcosystemRotation 回写尾部名单并带上榜日期', () => {
      const repos = [
        { nameWithOwner: 'eco/h0' },
        { nameWithOwner: 'eco/h1' },
        { nameWithOwner: 'eco/t2' },
      ] as ScoredRepo[];

      persistEcosystemRotation([TEST_BOARD], [repos], memoryPath());

      // headSlots=2: 前两条是头部不回写, 只有第 3 条属尾部
      expect(JSON.parse(fs.readFileSync(memoryPath(), 'utf-8'))).toEqual({
        'eco/t2': '2026-10-16',
      });
    });

    it('persistEcosystemRotation 跳过未配置轮换的榜', () => {
      const repos = [{ nameWithOwner: 'eco/v0' }] as ScoredRepo[];

      persistEcosystemRotation([VERCEL_AI_SDK_BOARD], [repos], memoryPath());

      expect(fs.existsSync(memoryPath())).toBe(false);
    });

    // 端到端: buildEcosystemBoard 读的记忆, 必须正是 persistEcosystemRotation
    // 写出来的那份 —— 两半分开测各自绿, 接不上则轮换静默失效。
    it('连续多天: 出榜 -> 回写 -> 次日出榜轮换, 尾部逐日换人', async () => {
      stubDescendingPool();
      const boards = [TEST_BOARD];

      const day = (d: number) => vi.setSystemTime(new Date(`2026-10-${16 + d}T12:00:00Z`));

      async function runDay(d: number): Promise<string[]> {
        day(d);
        const out = await buildEcosystemBoard(TEST_BOARD, memoryPath());
        persistEcosystemRotation(boards, [out], memoryPath());
        return out.map(r => r.nameWithOwner);
      }

      const day1 = await runDay(0);
      const day2 = await runDay(1);
      const day3 = await runDay(2);
      const day4 = await runDay(3);

      // 头部稳态: 四天都是 fast0 / fast1
      for (const d of [day1, day2, day3, day4]) {
        expect(d.slice(0, 2)).toEqual(['eco/fast0', 'eco/fast1']);
      }
      // 尾部逐日换人, 且相邻两天不重复
      expect(day1.slice(2)).toEqual(['eco/fast2', 'eco/fast3']);
      expect(day2.slice(2)).toEqual(['eco/fast4', 'eco/fast5']);
      expect(day3.slice(2)).toEqual(['eco/fast6', 'eco/fast7']);
      // 第 4 天: day1 的尾部已超出 2 天保留期, 回到 fast2/fast3
      expect(day4.slice(2)).toEqual(['eco/fast2', 'eco/fast3']);
      // 四天累计覆盖 6 个尾部项目(池子 8 - 头部 2)
      const allTails = [day1, day2, day3, day4].map(d => d.slice(2)).flat();
      expect(new Set(allTails)).toHaveLength(6);
    });
  });
});
