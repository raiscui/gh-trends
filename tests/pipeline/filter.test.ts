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
});
