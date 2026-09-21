import { describe, expect, it } from 'vitest';
import { buildTrendingReposQuery } from '../../src/clients/clickhouse';

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
