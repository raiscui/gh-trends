import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../src/pipeline/render';
import { mockRepos } from '../../src/mocks/repos';
import { ScoredRepo } from '../../src/pipeline/select';

// 测试 helper:把所有 mock repos 装进 sections.main,空垂直段让 markdown.hbs
// 里那几个 section 渲染空 tier 表格(模板自带空保护,不会报错)。
function toSections(repos: ScoredRepo[]) {
  return {
    main: repos,
    rust: [],
    agent: [],
    deepseekHarness: [],
    vercelAiSdk: [],
    aiVideoEditor: [],
  };
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

  it.each(['markdown.hbs', 'html.hbs', 'text.hbs'])('%s 的往期内容指向当前仓库', templateName => {
    const content = render(templateName, toSections([]));
    expect(content).toContain('https://github.com/raiscui/gh-trends/releases');
    expect(content).not.toContain('https://github.com/mhadidg/gh-trends/releases');
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
        ].map(r => ({
          main: [r],
          rust: [],
          agent: [],
          deepseekHarness: [],
          vercelAiSdk: [],
          aiVideoEditor: [],
        }))[0]!
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

    it('should render all five section headers (main / rust / agent / deepseek / vercel)', () => {
      const content = render(template, toSections(mockScoredRepos));

      expect(content).toContain('🔥 GitHub trends');
      expect(content).toContain('🦀 Rust trends');
      expect(content).toContain('🤖 Agent trends');
      expect(content).toContain('🧠 DeepSeek Harness trends');
      expect(content).toContain('▲ Vercel AI SDK trends');
    });
  });

  // AI Video Editor 段的渲染边界。pipeline 每期已算出 30 条(RELEASE_TOP_N_AI_VIDEO_EDITOR=30),
  // 但模板此前只渲染前 15 条 —— 每天有一半结果被丢弃。头部稳态 + 尾部轮换后,
  // Tier 2 是轮换发生的区域, 必须渲染到第 30 条才有效果。
  describe('markdown AI Video Editor 段渲染边界', () => {
    beforeEach(() => {
      vi.stubEnv('RELEASE_TRUNCATE_DESC', '0');
    });

    // 造 n 条按名次排列的视频榜条目
    function videoRepos(n: number): ScoredRepo[] {
      return Array.from({ length: n }, (_, i) => ({
        ...mockScoredRepos[i % mockScoredRepos.length]!,
        nameWithOwner: `video/r${i}`,
        url: `https://github.com/video/r${i}`,
        description: `video repo ${i}`,
        score: 100 - i,
      }));
    }

    function videoSections(repos: ScoredRepo[]) {
      return { ...toSections([]), aiVideoEditor: repos };
    }

    const segmentOf = (content: string) =>
      content.slice(content.indexOf('🎬 AI Video Editor trends'));

    it('渲染到第 30 条(而非只渲染 15 条)', () => {
      const content = render(template, videoSections(videoRepos(31)));
      const segment = segmentOf(content);

      expect(segment).toContain('video/r29');
      // 第 31 条超出 topN, 不该渲染
      expect(segment).not.toContain('video/r30');
    });

    it('Tier 1 承载前 15 条, Tier 2 承载第 16~30 条', () => {
      const content = render(template, videoSections(videoRepos(30)));
      const segment = segmentOf(content);
      const tier2 = segment.slice(segment.indexOf('Tier 2'));

      expect(segment.slice(0, segment.indexOf('Tier 2'))).toContain('video/r14');
      expect(tier2).not.toContain('video/r14');
      expect(tier2).toContain('video/r15');
      expect(tier2).toContain('video/r29');
    });

    it('段内共渲染 30 条', () => {
      const content = render(template, videoSections(videoRepos(30)));
      const matches = segmentOf(content).match(/video\/r\d+/g) ?? [];

      expect(new Set(matches).size).toBe(30);
    });

    it('池子不足 30 条时按实际条数渲染, 不报错', () => {
      const content = render(template, videoSections(videoRepos(6)));
      const segment = segmentOf(content);

      expect(segment).toContain('video/r5');
      expect(segment).not.toContain('video/r6');
    });
  });
});
