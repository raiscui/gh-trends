import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, TaggedError } from '../../src/utils/logging';
import { GitHubPublisher } from '../../src/publishers/github';
import { mockRepos } from '../../src/mocks/repos';
import { ReleaseSections } from '../../src/pipeline/render';
import { GitHubClient } from '../../src/clients/github';

describe('gh-release.ts', () => {
  const mockFetch = vi.fn();
  let instance: GitHubPublisher;

  const content = 'Hello world';
  const sections: ReleaseSections = {
    main: mockRepos.map(repo => ({ ...repo, score: 0 })),
    rust: [],
    agent: [],
    deepseekHarness: [],
    vercelAiSdk: [],
    aiVideoEditor: [],
  };

  beforeEach(() => {
    instance = new GitHubPublisher();
    vi.spyOn(instance, 'render').mockReturnValue(content);
    global.fetch = mockFetch as typeof fetch;
    vi.clearAllMocks(); // reset mocks
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  describe('enabled', () => {
    it('should return false when GITHUB_RELEASES_ENABLED is false', async () => {
      vi.stubEnv('GITHUB_RELEASES_ENABLED', 'false');

      expect(instance.enabled()).toBe(false);
    });

    it('should return false when GITHUB_RELEASES_ENABLED is undefined', async () => {
      vi.stubEnv('GITHUB_RELEASES_ENABLED', undefined);

      expect(instance.enabled()).toBe(false);
    });

    it('should return true when GITHUB_RELEASES_ENABLED is true', async () => {
      vi.stubEnv('GITHUB_RELEASES_ENABLED', 'true');

      expect(instance.enabled()).toBe(true);
    });
  });

  describe('config', () => {
    it('should throw when GITHUB_TOKEN is missing', async () => {
      vi.stubEnv('GITHUB_RELEASES_REPO', 'example/repo');
      vi.stubEnv('GITHUB_TOKEN', undefined);

      await expect(instance.publish(sections)).rejects.toThrow('GITHUB_TOKEN');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw when GITHUB_TOKEN is empty', async () => {
      vi.stubEnv('GITHUB_RELEASES_REPO', 'example/repo');
      vi.stubEnv('GITHUB_TOKEN', '');

      await expect(instance.publish(sections)).rejects.toThrow('GITHUB_TOKEN');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw when GITHUB_RELEASES_REPO is missing', async () => {
      vi.stubEnv('GITHUB_RELEASES_REPO', undefined);

      await expect(instance.publish(sections)).rejects.toThrow('GITHUB_RELEASES_REPO');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw when GITHUB_RELEASES_REPO is missing', async () => {
      vi.stubEnv('GITHUB_RELEASES_REPO', '');

      await expect(instance.publish(sections)).rejects.toThrow('GITHUB_RELEASES_REPO');

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('publish', () => {
    const repo = 'example/repo';
    const token = 'ghp_valid_token_123';

    beforeEach(() => {
      vi.stubEnv('GITHUB_TOKEN', token);
      vi.stubEnv('GITHUB_RELEASES_REPO', repo);
    });

    it('should make well-formed request', async () => {
      const id = 99;

      // Publish() first calls GET (tag lookup -> 404 in this test),

      // then POST create -> 200 with id.

      let n = 0;

      mockFetch.mockImplementation(async () => {
        n++;

        if (n === 1) return { ok: false, status: 404, json: vi.fn().mockResolvedValue({}) };

        return { ok: true, json: vi.fn().mockResolvedValue({ id }) };
      });

      await expect(instance.publish(sections)).resolves.toBe(id.toString());

      expect(mockFetch).toHaveBeenCalledWith(
        `${GitHubClient.baseUrl}/repos/${repo}/releases`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
          }),
        })
      );

      const [, options] = mockFetch.mock.calls[1]!;
      const parsedBody = JSON.parse(options.body as string);
      expect(parsedBody).toEqual({
        tag_name: expect.stringMatching(/^daily-\d{4}-\d{2}-\d{2}$/), // e.g. daily-2026-08-07
        name: instance.subject(),
        body: content,
        draft: false,
        prerelease: false,
      });
    });

    it('should throw on missing ID', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({}), // no id
      });

      await expect(instance.publish(sections)).rejects.toThrowError(TaggedError);
    });

    it('should throw on JSON parsing errors', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockRejectedValue(new Error('invalid JSON')),
      });

      await expect(instance.publish(sections)).rejects.toThrow('invalid JSON');
    });

    it('should throw on 5xx HTTP error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue('internal server error'),
      });

      await expect(instance.publish(sections)).rejects.toThrowError(HttpError);
    });

    it('should throw on network errors', async () => {
      mockFetch.mockRejectedValue(new Error('network down'));

      await expect(instance.publish(sections)).rejects.toThrow('network down');
    });

    it('skips publishing when release tag already exists', async () => {
      const existingId = '7777';

      // getReleaseByTag -> 200 with id; createRelease is NOT called
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: existingId }),
      });

      await expect(instance.publish(sections)).resolves.toBe(
        `release-already-exists-${existingId}`
      );

      // 只调一次 fetch,必须命中 GET release-by-tag,不能再去 POST create
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/releases/tags/daily-'),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('treats 404 on tag lookup as "allow publish"', async () => {
      // getReleaseByTag -> 404 (not found) -> then createRelease -> 200 with id
      let n = 0;
      mockFetch.mockImplementation(async () => {
        n++;
        if (n === 1) return { ok: false, status: 404, json: vi.fn().mockResolvedValue({}) };
        return { ok: true, json: vi.fn().mockResolvedValue({ id: 88 }) };
      });

      await expect(instance.publish(sections)).resolves.toBe('88');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    describe('dayTag', () => {
      let instance: GitHubPublisher;

      beforeEach(() => {
        instance = new GitHubPublisher();
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('emits the epoch day on release day 0', () => {
        vi.setSystemTime(new Date('2025-07-21T00:00:00Z'));

        expect(instance.subject()).toBe('GitHub trends — 2025-07-21');
      });

      it('rolls over the date after crossing midnight UTC', () => {
        vi.setSystemTime(new Date('2025-07-21T23:59:59Z'));

        const beforeMidnight = instance.subject();
        vi.setSystemTime(new Date('2025-07-22T00:00:01Z'));

        const afterMidnight = instance.subject();

        expect(beforeMidnight).toBe('GitHub trends — 2025-07-21');
        expect(afterMidnight).toBe('GitHub trends — 2025-07-22');
      });
    });
  });
});
