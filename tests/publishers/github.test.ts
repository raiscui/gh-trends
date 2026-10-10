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
    // 重试用指数退避, 测试里把基准延迟置 0, 避免真实等待
    vi.stubEnv('RELEASE_CREATE_RETRY_BASE_MS', '0');
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

    // 2026-10-07 事故: 六榜数据全选出, 却因 GitHub 单次 500 导致整天空窗。
    describe('release 创建重试(2026-10-07 事故)', () => {
      it('5xx 后重试并成功', async () => {
        // 第 1 次 GET-by-tag -> 404(可发布); 第 2 次 POST -> 500;
        // 第 3 次 POST -> 200 成功
        mockFetch
          .mockResolvedValueOnce({ ok: false, status: 404, json: vi.fn().mockResolvedValue({}) })
          .mockResolvedValueOnce({
            ok: false,
            status: 500,
            text: vi.fn().mockResolvedValue(''),
          })
          .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({ id: 555 }) });

        await expect(instance.publish(sections)).resolves.toBe('555');
        expect(mockFetch).toHaveBeenCalledTimes(3);
      });

      it('5xx 持续失败时, 重试到上限才抛错', async () => {
        vi.stubEnv('RELEASE_CREATE_MAX_ATTEMPTS', '3');
        mockFetch
          .mockResolvedValueOnce({ ok: false, status: 404, json: vi.fn().mockResolvedValue({}) })
          .mockResolvedValue({ ok: false, status: 503, text: vi.fn().mockResolvedValue('') });

        await expect(instance.publish(sections)).rejects.toThrowError(HttpError);
        // 1 次 GET + 3 次 POST(上限内)
        expect(mockFetch).toHaveBeenCalledTimes(4);
      });

      it('网络异常也重试', async () => {
        mockFetch
          .mockResolvedValueOnce({ ok: false, status: 404, json: vi.fn().mockResolvedValue({}) })
          .mockRejectedValueOnce(new Error('socket hang up'))
          .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({ id: 556 }) });

        await expect(instance.publish(sections)).resolves.toBe('556');
      });

      it('4xx 不重试 —— 请求本身有问题, 重试只会浪费配额', async () => {
        vi.stubEnv('RELEASE_CREATE_MAX_ATTEMPTS', '3');
        mockFetch
          .mockResolvedValueOnce({ ok: false, status: 404, json: vi.fn().mockResolvedValue({}) })
          .mockResolvedValue({
            ok: false,
            status: 401,
            text: vi.fn().mockResolvedValue('bad creds'),
          });

        await expect(instance.publish(sections)).rejects.toThrowError(HttpError);
        expect(mockFetch).toHaveBeenCalledTimes(2); // 1 次 GET + 1 次 POST, 不重试
      });

      it('422 当成功处理: 反查 tag 拿 id(上次 POST 成功但响应丢失的场景)', async () => {
        // 第 1 次 GET-by-tag -> 404; 第 2 次 POST -> 422;
        // 第 3 次 GET-by-tag -> 200 拿到已存在的 release id
        mockFetch
          .mockResolvedValueOnce({ ok: false, status: 404, json: vi.fn().mockResolvedValue({}) })
          .mockResolvedValueOnce({
            ok: false,
            status: 422,
            text: vi.fn().mockResolvedValue('already_exists'),
          })
          .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({ id: 777 }) });

        await expect(instance.publish(sections)).resolves.toBe('777');
      });

      it('MAX_ATTEMPTS=1 时退回旧行为(不重试)', async () => {
        vi.stubEnv('RELEASE_CREATE_MAX_ATTEMPTS', '1');
        mockFetch
          .mockResolvedValueOnce({ ok: false, status: 404, json: vi.fn().mockResolvedValue({}) })
          .mockResolvedValueOnce({ ok: false, status: 500, text: vi.fn().mockResolvedValue('') });

        await expect(instance.publish(sections)).rejects.toThrowError(HttpError);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });
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
