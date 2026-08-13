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

    const emptySections: ReleaseSections = { main: [], rust: [], agent: [] };
    const result = await publishAll(emptySections, pubs);

    expect(result).toEqual([]);
    expect(publisher01.publish).not.toHaveBeenCalled();
  });
});
