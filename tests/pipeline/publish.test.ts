import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publishAll } from '../../src/pipeline/publish';
import { mockRepos } from '../../src/mocks/repos';
import { ScoredRepo } from '../../src/pipeline/select';
import { ReleaseSections } from '../../src/pipeline/render';

const publisher01 = {
  name: 'publisher-01',
  enabled: vi.fn().mockReturnValue(false),
  subject: vi.fn().mockReturnValue('subject'),
  render: vi.fn().mockReturnValue('content'),
  publish: vi.fn(),
};

const publisher02 = {
  name: 'publisher-02',
  enabled: vi.fn().mockReturnValue(false),
  subject: vi.fn().mockReturnValue('subject'),
  render: vi.fn().mockReturnValue('content'),
  publish: vi.fn(),
};

const pubs = [publisher01, publisher02];

describe('publish.ts', () => {
  // 共享 mock sections:主榜是 mock repos,Rust / Agent 故意空,用来验证 publishAll
  // 在 section 完全为空时仍能正常触发各 publisher。
  const sections: ReleaseSections = {
    main: mockRepos.map(repo => ({ ...repo, score: 0 }) as ScoredRepo),
    rust: [],
    agent: [],
    deepseekHarness: [],
    vercelAiSdk: [],
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('should handle zero publisher enabled', async () => {
    const result = await publishAll(sections, pubs);

    expect(result).toEqual([]);
    expect(publisher01.publish).not.toHaveBeenCalled();
    expect(publisher02.publish).not.toHaveBeenCalled();
  });

  it('should call only the enabled publishers', async () => {
    publisher01.enabled.mockReturnValue(true);
    publisher01.publish.mockResolvedValueOnce('bd_123');

    const result = await publishAll(sections, pubs);

    expect(result).toEqual(['bd_123']);
    expect(publisher01.publish).toHaveBeenCalledWith(sections);
    expect(publisher02.publish).not.toHaveBeenCalled();
  });

  it('should call multiple publishers when enabled', async () => {
    publisher01.enabled.mockReturnValue(true);
    publisher02.enabled.mockReturnValue(true);
    publisher01.publish.mockResolvedValueOnce('bd_123');
    publisher02.publish.mockResolvedValueOnce('gh_456');

    const result = await publishAll(sections, pubs);

    expect(result).toEqual(['bd_123', 'gh_456']);
  });

  it('should throw when one of the publisher fails', async () => {
    publisher01.enabled.mockReturnValue(true);
    publisher02.enabled.mockReturnValue(true);

    publisher01.publish.mockRejectedValueOnce(new Error('publisher-01'));
    publisher02.publish.mockResolvedValueOnce('gh_456');

    await expect(publishAll(sections, pubs)).rejects.toThrow('publisher-01');
  });

  it('should throw when multiple publishers fail (first error wins)', async () => {
    publisher01.enabled.mockReturnValue(true);
    publisher02.enabled.mockReturnValue(true);

    publisher01.publish.mockRejectedValueOnce(new Error('publisher-01'));
    publisher02.publish.mockRejectedValueOnce(new Error('publisher-02'));

    await expect(publishAll(sections, pubs)).rejects.toThrow('publisher-01');
  });

  it('should skip publication when all sections are empty', async () => {
    publisher01.enabled.mockReturnValue(true);

    const emptySections: ReleaseSections = {
      main: [],
      rust: [],
      agent: [],
      deepseekHarness: [],
      vercelAiSdk: [],
    };
    const result = await publishAll(emptySections, pubs);

    expect(result).toEqual([]);
    expect(publisher01.publish).not.toHaveBeenCalled();
  });

  it('should publish when only a vertical section has content (regression)', async () => {
    // 回归:publishAll 曾漏算 deepseekHarness / vercelAiSdk 段,
    // 主榜+Rust+Agent 全空而垂直段有货时会被误判 "no repositories to publish" 跳过。
    // 注意:前面用例已把 publisher02.enabled 永久 mock 成 true,这里要显式关掉
    publisher02.enabled.mockReturnValue(false);
    publisher01.enabled.mockReturnValue(true);
    publisher01.publish.mockResolvedValueOnce('bd_789');

    const verticalOnly: ReleaseSections = {
      main: [],
      rust: [],
      agent: [],
      deepseekHarness: [],
      vercelAiSdk: mockRepos.slice(0, 1).map(repo => ({ ...repo, score: 0 }) as ScoredRepo),
    };

    const result = await publishAll(verticalOnly, pubs);

    expect(result).toEqual(['bd_789']);
    expect(publisher01.publish).toHaveBeenCalledTimes(1);
  });
});
