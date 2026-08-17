import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../src/pipeline/render';
import { mockRepos } from '../../src/mocks/repos';
import { ScoredRepo } from '../../src/pipeline/select';

// 测试 helper:把所有 mock repos 装进 sections.main,空 rust / agent 让 markdown.hbs
// 里那两个 section 渲染空 tier 表格(模板自带空保护,不会报错)。
function toSections(repos: ScoredRepo[]) {
  return { main: repos, rust: [], agent: [], deepseekHarness: [] };
}

describe('render.ts', () => {
  const template = 'markdown.hbs';
  const mockDate = new Date('2025-08-15T10:00:00.000Z'); // friday, Week 33

  const mockScoredRepos: ScoredRepo[] = mockRepos.map((repo, index) => ({
    ...repo,
    score: 0.9 - index * 0.1,
  }));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(mockDate);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('markdown', () => {
    beforeEach(() => {
      vi.stubEnv('RELEASE_TRUNCATE_DESC', '0');
    });

    it('should render release with single repo', () => {
      const content = render(template, toSections([mockScoredRepos[0]!]));

      expect(content).toContain(mockScoredRepos[0]!.nameWithOwner);
    });

    it('should render release with multiple repos', () => {
      const content = render(template, toSections([mockScoredRepos[0]!, mockScoredRepos[1]!]));

      expect(content).toContain(mockScoredRepos[0]!.nameWithOwner);
      expect(content).toContain(mockScoredRepos[1]!.nameWithOwner);
    });

    it('should include key information', () => {
      const content = render(template, toSections([mockScoredRepos[0]!]));

      expect(content).toContain(mockScoredRepos[0]!.nameWithOwner);
      expect(content).toContain(mockScoredRepos[0]!.description);
      expect(content).toContain(mockScoredRepos[0]!.url);
      expect(content).toContain(mockScoredRepos[0]!.stargazerCount.toLocaleString());
    });

    it('should handle repos with null optionals', () => {
      const content = render(
        template,
        [
          {
            ...mockScoredRepos[0]!,
            description: null,
            primaryLanguage: null,
          },
        ].map(r => ({ main: [r], rust: [], agent: [], deepseekHarness: [] }))[0]!
      );

      expect(content).toContain('(no description)');
    });

    it('should handle special chars in descriptions', () => {
      const specialCharRepo: ScoredRepo = {
        ...mockScoredRepos[0]!,
        description: 'Tool with "quotes" and <tags> & special chars',
      };

      const content = render(template, toSections([specialCharRepo]));

      expect(content).toBeTruthy();
    });

    it('should handle unicode chars in descriptions', () => {
      const unicodeRepo: ScoredRepo = {
        ...mockScoredRepos[0]!,
        description: 'A project with emojis 🚀 and unicode chars 你好',
      };

      const content = render(template, toSections([unicodeRepo]));

      expect(content).toContain('🚀');
      expect(content).toContain('你好');
    });

    it('should render all three section headers (main / rust / agent)', () => {
      const content = render(template, toSections(mockScoredRepos));

      expect(content).toContain('🔥 GitHub trends');
      expect(content).toContain('🦀 Rust trends');
      expect(content).toContain('🤖 Agent trends');
      expect(content).toContain('🧠 DeepSeek Harness trends');
    });
  });
});
