import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_HARNESS_KEYWORDS,
  isDeepSeekHarnessRepo,
} from '../../src/clients/deepSeekKeywords';
import { GithubRepo } from '../../src/clients/github.gql';

// 测试工厂:构造一个最小可用的 GithubRepo(只关心 nameWithOwner / description)。
function mkRepo(name: string, description: string | null = 'placeholder'): GithubRepo {
  return {
    nameWithOwner: name,
    url: `https://github.com/${name}`,
    description,
    createdAt: '2024-01-01T00:00:00Z',
    clickhouse: {
      repoName: name,
      firstSeenAt: '2024-01-01 00:00:00',
      starsWithin: '0',
      starsBefore: '0',
    },
    stargazerCount: 0,
    primaryLanguage: null,
    owner: { __typename: 'User', createdAt: '2024-01-01T00:00:00Z' },
    stargazers: { nodes: [] },
  };
}

describe('deepSeekKeywords.ts', () => {
  describe('DEEPSEEK_HARNESS_KEYWORDS', () => {
    it('should be a non-empty readonly array of strings', () => {
      expect(DEEPSEEK_HARNESS_KEYWORDS.length).toBeGreaterThan(0);
      for (const k of DEEPSEEK_HARNESS_KEYWORDS) {
        expect(typeof k).toBe('string');
        expect(k.length).toBeGreaterThan(0);
      }
    });

    it('should contain the user-specified 3 keywords', () => {
      // 用户指定:cordis / dsh / dsh-plugin
      expect(DEEPSEEK_HARNESS_KEYWORDS).toContain('cordis');
      expect(DEEPSEEK_HARNESS_KEYWORDS).toContain('dsh');
      expect(DEEPSEEK_HARNESS_KEYWORDS).toContain('dsh-plugin');
    });

    it('should not include broader DeepSeek ecosystem keywords', () => {
      // 不应该包含 deepseek-ai / deepseek-v3 等官方模型关键词
      // —— 这是 DeepSeek Harness 榜单,不是 DeepSeek 模型榜单
      expect(DEEPSEEK_HARNESS_KEYWORDS).not.toContain('deepseek');
      expect(DEEPSEEK_HARNESS_KEYWORDS).not.toContain('deepseek-ai');
      expect(DEEPSEEK_HARNESS_KEYWORDS).not.toContain('deepseek-v3');
    });
  });

  describe('isDeepSeekHarnessRepo', () => {
    it('matches when nameWithOwner contains "dsh" (case-insensitive)', () => {
      expect(isDeepSeekHarnessRepo(mkRepo('foo/dsh'))).toBe(true);
      expect(isDeepSeekHarnessRepo(mkRepo('foo/DSH-CLI'))).toBe(true);
      expect(isDeepSeekHarnessRepo(mkRepo('foo/DshTool'))).toBe(true);
    });

    it('matches when nameWithOwner contains "cordis"', () => {
      expect(isDeepSeekHarnessRepo(mkRepo('foo/cordis-memory'))).toBe(true);
      expect(isDeepSeekHarnessRepo(mkRepo('foo/cordis'))).toBe(true);
    });

    it('matches when nameWithOwner contains "dsh-plugin"', () => {
      expect(isDeepSeekHarnessRepo(mkRepo('foo/dsh-plugin-foo'))).toBe(true);
      expect(isDeepSeekHarnessRepo(mkRepo('foo/awesome-dsh-plugin'))).toBe(true);
    });

    it('matches when description contains a keyword', () => {
      expect(isDeepSeekHarnessRepo(mkRepo('foo/silent-name', 'A dsh-based memory layer'))).toBe(
        true
      );
      expect(isDeepSeekHarnessRepo(mkRepo('foo/x', 'Built on top of cordis'))).toBe(true);
      expect(
        isDeepSeekHarnessRepo(mkRepo('foo/y', 'An official dsh-plugin for vector search'))
      ).toBe(true);
    });

    it('does NOT match repos without dsh / cordis / dsh-plugin signals', () => {
      expect(isDeepSeekHarnessRepo(mkRepo('vercel/next.js', 'The React Framework'))).toBe(false);
      expect(isDeepSeekHarnessRepo(mkRepo('rust-lang/rust', 'Empowering everyone'))).toBe(false);
      // deepseek 官方项目不算(我们只覆盖 harness 生态,不覆盖 DeepSeek 官方)
      expect(isDeepSeekHarnessRepo(mkRepo('deepseek-ai/DeepSeek-V3', 'Official model'))).toBe(
        false
      );
    });

    it('handles null description gracefully', () => {
      // name 不含关键词,description 为 null → 不命中
      expect(isDeepSeekHarnessRepo(mkRepo('foo/safe-project', null))).toBe(false);
    });

    it('handles case-insensitive matching', () => {
      expect(isDeepSeekHarnessRepo(mkRepo('foo/CORDIS'))).toBe(true);
      expect(isDeepSeekHarnessRepo(mkRepo('foo/DSH-PLUGIN'))).toBe(true);
    });
  });
});
