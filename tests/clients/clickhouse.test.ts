import { describe, expect, it } from 'vitest';
import { buildRepoGrowthQuery, buildTrendingReposQuery } from '../../src/clients/clickhouse';

// specs/0001 D1: 双通道 SQL 生成
describe('buildTrendingReposQuery', () => {
  const sql = buildTrendingReposQuery({
    evalDate: new Date('2026-09-12T00:00:00Z'),
    windowDays: 7,
    historyDays: 60,
    limitA: 300,
    growthRate: 0.5,
    channelBMinStars: 40,
    channelBLimit: 100,
  });

  it('通道 A: 保留原有 starsBefore > 0 比值门槛', () => {
    expect(sql).toContain('WHERE starsBefore > 0 AND starsWithin / starsBefore > 0.5');
    expect(sql).toContain('LIMIT 300');
  });

  it('通道 B: 从零爆火走绝对门槛, 独立配额', () => {
    expect(sql).toContain('WHERE starsBefore = 0 AND starsWithin >= 40');
    expect(sql).toContain('LIMIT 100');
  });

  it('两通道 UNION ALL 合并', () => {
    expect(sql).toContain('UNION ALL');
  });

  it('WHERE 时间轴扩展到 SCAN_HISTORY_DAYS', () => {
    expect(sql).toContain('created_at >= END_DATE - INTERVAL 60 DAY');
  });

  it('窗口劈半用小时表达, recent/earlier 对称', () => {
    // 7 天 -> 84 小时劈半, 避免 INTERVAL 天数取整不对称
    expect(sql).toContain('84 AS HALF_WINDOW_HOURS');
    expect(sql).toContain('INTERVAL HALF_WINDOW_HOURS HOUR');
  });

  it('输出 accel 所需的 starsRecent / starsEarlier 列', () => {
    expect(sql).toContain('AS starsRecent');
    expect(sql).toContain('AS starsEarlier');
  });

  it('eval date 转为 ClickHouse 时间格式', () => {
    expect(sql).toContain("'2026-09-12 00:00:00'::timestamp AS END_DATE");
  });
});

// ADR-0003: 生态榜增速 SQL。与主榜的差别是"候选集 + 不设增长门槛"
describe('buildRepoGrowthQuery', () => {
  const sql = buildRepoGrowthQuery({
    repoNames: ['vercel/ai', 'assistant-ui/assistant-ui'],
    evalDate: new Date('2026-10-04T00:00:00Z'),
    windowDays: 28,
    historyDays: 90,
  });

  it('限定在给定的 repo 名单内', () => {
    expect(sql).toContain("repo_name IN ('vercel/ai','assistant-ui/assistant-ui')");
  });

  it('不施加任何增长门槛(生态榜排序权交给上层 rankAndSlice)', () => {
    // 主榜的通道 A/B 门槛若照搬, 慢增长生态会被二次清空 —— 这里刻意不加
    expect(sql).not.toContain('starsWithin / starsBefore');
    expect(sql).not.toContain('LIMIT');
  });

  it('按 ECOSYSTEM_WINDOW_DAYS 铺窗口, 而非主榜的 7 天', () => {
    expect(sql).toContain('END_DATE - INTERVAL 28 DAY AS START_DATE');
  });

  it('窗口劈半用小时表达, 28 天 -> 336h, recent/earlier 对称', () => {
    expect(sql).toContain('336 AS HALF_WINDOW_HOURS');
    expect(sql).toContain('INTERVAL HALF_WINDOW_HOURS HOUR');
  });

  it('时间轴盖住窗口前的 base, 才能算出 starsBefore', () => {
    expect(sql).toContain('created_at >= END_DATE - INTERVAL 90 DAY');
  });

  it('输出 accel 所需的 starsRecent / starsEarlier 与 firstSeenAt', () => {
    expect(sql).toContain('AS starsRecent');
    expect(sql).toContain('AS starsEarlier');
    expect(sql).toContain('AS firstSeenAt');
  });

  it('repo 名做 SQL 字面量转义, 防引号拼出额外字面量', () => {
    const escaped = buildRepoGrowthQuery({
      repoNames: ["ev'il\\repo"],
      evalDate: new Date('2026-10-04T00:00:00Z'),
      windowDays: 28,
      historyDays: 90,
    });
    expect(escaped).toContain("repo_name IN ('ev\\'il\\\\repo')");
  });
});
