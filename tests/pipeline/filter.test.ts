import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filter } from '../../src/pipeline/filter';
import { makeRepo } from '../helpers';

// specs/0001 D4/D5: FILTER_MIN_STARS=40 边界 + fresh owner 验真
describe('filter', () => {
  afterEach(() => {
    delete process.env.FILTER_MIN_STARS;
    delete process.env.FILTER_FRESH_OWNER;
    delete process.env.FILTER_RENAMED;
    delete process.env.FILTER_EMPTY_DESC;
    delete process.env.SCAN_EVAL_DATE;
  });

  describe('FILTER_MIN_STARS=40 边界', () => {
    it('40 star 放行(含边界), 39 剔除', () => {
      process.env.FILTER_MIN_STARS = '40';
      process.env.FILTER_RENAMED = 'false';
      process.env.FILTER_EMPTY_DESC = 'false';
      process.env.FILTER_FRESH_OWNER = 'false';
      const at = filter([makeRepo({ name: 'a/at', stargazerCount: 40 })]);
      const below = filter([makeRepo({ name: 'a/below', stargazerCount: 39 })]);
      expect(at).toHaveLength(1);
      expect(below).toHaveLength(0);
    });
  });

  describe('FILTER_FRESH_OWNER 验真', () => {
    beforeEach(() => {
      process.env.FILTER_MIN_STARS = '40';
      process.env.FILTER_RENAMED = 'false';
      process.env.FILTER_EMPTY_DESC = 'false';
      process.env.FILTER_FRESH_OWNER = 'true';
    });

    it('owner 账龄 29 天剔除, 31 天放行(门槛 30 天)', () => {
      const fresh = filter([makeRepo({ name: 'a/fresh-owner', ownerCreatedDaysAgo: 29 })]);
      const mature = filter([makeRepo({ name: 'a/mature-owner', ownerCreatedDaysAgo: 31 })]);
      expect(fresh).toHaveLength(0);
      expect(mature).toHaveLength(1);
    });

    it('Organization owner 不受账龄限制', () => {
      const org = filter([
        makeRepo({ name: 'a/new-org', ownerType: 'Organization', ownerCreatedDaysAgo: 3 }),
      ]);
      expect(org).toHaveLength(1);
    });
  });

  describe('CJK 描述放行(2026-09-29 移除 CJK 一刀切规则)', () => {
    beforeEach(() => {
      process.env.FILTER_MIN_STARS = '40';
      process.env.FILTER_RENAMED = 'false';
      process.env.FILTER_EMPTY_DESC = 'false';
      process.env.FILTER_FRESH_OWNER = 'false';
    });

    it('描述含汉字的生态项目不再被剔除', () => {
      // 回归: 上游 CJK 一刀切规则把中文生态项目全砍掉, 导致 DeepSeek 榜结构性空榜
      // (线上 daily-2026-09-28 实测 0 条; 移除前 300 池中被剔 23 个)。
      const out = filter([
        makeRepo({
          name: 'dsh-tauri/deepseek-harness-desktop',
          stargazerCount: 2848,
          description: 'DeepSeek Harness Tauri 桌面版 | Only 5mb installer',
        }),
      ]);
      expect(out).toHaveLength(1);
    });

    it('纯中文 / 日文假名 / 韩文描述均放行', () => {
      const out = filter([
        makeRepo({ name: 'a/pure-cn', description: '本地优先的 AI 工作台' }),
        makeRepo({ name: 'a/jp', description: 'エージェント開発ツール' }),
        makeRepo({ name: 'a/kr', description: '에이전트 개발 도구' }),
      ]);
      expect(out).toHaveLength(3);
    });

    it('CJK 放行不影响其他规则(低 star 仍剔除)', () => {
      const out = filter([
        makeRepo({ name: 'a/low-star-cn', stargazerCount: 10, description: '中文描述' }),
      ]);
      expect(out).toHaveLength(0);
    });
  });
});
