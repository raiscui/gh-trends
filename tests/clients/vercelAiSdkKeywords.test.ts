import { describe, expect, it } from 'vitest';
import { VERCEL_AI_SDK_KEYWORDS, isVercelAiSdkRepo } from '../../src/clients/vercelAiSdkKeywords';
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
      starsRecent: '0',
      starsEarlier: '0',
    },
    stargazerCount: 0,
    primaryLanguage: null,
    repositoryTopics: { nodes: [] },
    owner: { __typename: 'User', createdAt: '2024-01-01T00:00:00Z' },
    stargazers: { nodes: [] },
  };
}

describe('vercelAiSdkKeywords.ts', () => {
  describe('VERCEL_AI_SDK_KEYWORDS', () => {
    it('should be a non-empty readonly array of strings', () => {
      expect(VERCEL_AI_SDK_KEYWORDS.length).toBeGreaterThan(0);
      for (const k of VERCEL_AI_SDK_KEYWORDS) {
        expect(typeof k).toBe('string');
        expect(k.length).toBeGreaterThan(0);
      }
    });

    it('should contain the 3 designed signals', () => {
      // 设计的 3 个生态信号:品牌完整短语 / 官方 repo 前缀 / npm 命名约定
      expect(VERCEL_AI_SDK_KEYWORDS).toContain('vercel ai sdk');
      expect(VERCEL_AI_SDK_KEYWORDS).toContain('vercel/ai');
      expect(VERCEL_AI_SDK_KEYWORDS).toContain('ai-sdk');
    });

    it('should NOT include overly generic keywords', () => {
      // `ai` 是灾难性泛匹配,`openai` 是别的生态;绝不能进集合
      expect(VERCEL_AI_SDK_KEYWORDS).not.toContain('ai');
      expect(VERCEL_AI_SDK_KEYWORDS).not.toContain('openai');
      expect(VERCEL_AI_SDK_KEYWORDS).not.toContain('vercel');
    });
  });

  describe('isVercelAiSdkRepo', () => {
    it('matches the official vercel/ai repo and its derivatives', () => {
      // 官方本体 + vercel org 下 AI 衍生项目(vercel/ai-chatbot 基于 AI SDK)
      expect(isVercelAiSdkRepo(mkRepo('vercel/ai'))).toBe(true);
      expect(isVercelAiSdkRepo(mkRepo('vercel/ai-chatbot'))).toBe(true);
    });

    it('matches npm ecosystem naming (ai-sdk in name, case-insensitive)', () => {
      // npm 生态命名约定:@ai-sdk/* → 名字里含 ai-sdk 连字符
      expect(isVercelAiSdkRepo(mkRepo('foo/ollama-ai-sdk-provider'))).toBe(true);
      expect(isVercelAiSdkRepo(mkRepo('foo/AI-SDK-Playground'))).toBe(true);
    });

    it('matches the brand phrase in description', () => {
      expect(isVercelAiSdkRepo(mkRepo('foo/silent-name', 'A provider for the Vercel AI SDK'))).toBe(
        true
      );
      expect(isVercelAiSdkRepo(mkRepo('foo/x', 'Built on top of vercel ai sdk'))).toBe(true);
    });

    it('matches ecosystem naming in description (ai-sdk / vercel/ai references)', () => {
      expect(isVercelAiSdkRepo(mkRepo('foo/x', 'An @ai-sdk/openai compatible provider'))).toBe(
        true
      );
      expect(isVercelAiSdkRepo(mkRepo('foo/y', 'Inspired by vercel/ai-chatbot'))).toBe(true);
    });

    it('does NOT match repos without Vercel AI SDK signals', () => {
      // 普通 AI 项目 / 其他 SDK 生态不应命中
      expect(isVercelAiSdkRepo(mkRepo('foo/langchain', 'LLM app framework'))).toBe(false);
      expect(isVercelAiSdkRepo(mkRepo('rust-lang/rust', 'Empowering everyone'))).toBe(false);
    });

    it('does NOT match the space form "openai sdk" via the ai-sdk keyword', () => {
      // 连字符 `ai-sdk` 不会命中空格形式的 "openai sdk"(设计上的误伤防线)
      expect(isVercelAiSdkRepo(mkRepo('foo/client', 'Wrapper for the OpenAI SDK'))).toBe(false);
    });

    it('handles null description gracefully', () => {
      // name 不含关键词,description 为 null → 不命中
      expect(isVercelAiSdkRepo(mkRepo('foo/safe-project', null))).toBe(false);
    });

    it('matches case-insensitively on name', () => {
      expect(isVercelAiSdkRepo(mkRepo('Vercel/AI-Chatbot'))).toBe(true);
    });
  });
});
