import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, run } from '../src/run';
import { HttpError, TaggedError } from '../src/utils/logging';
import { ClickHouseClient, ClickHouseResponse } from '../src/clients/clickhouse';
import { mockRepos } from '../src/mocks/repos';
import { GitHubGraphQLClient } from '../src/clients/github.gql';
import { GitHubTopicClient } from '../src/clients/github.topics';
import { GitHubClient } from '../src/clients/github';
import { ButtondownClient } from '../src/clients/buttondown';

describe('run.ts', () => {
  let realFetch: typeof fetch;

  beforeEach(async () => {
    vi.clearAllMocks();

    realFetch = global.fetch;

    vi.spyOn(global, 'fetch').mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const body = typeof init?.body === 'string' ? init.body : '';

        // Scan: querying ClickHouse
        if (url.includes(ClickHouseClient.baseUrl)) {
          // 生态榜增速查询(ADR-0003)与主榜趋势查询共用同一个端点, 靠
          // `repo_name IN (...)` 这个谓词区分; 主榜那条分支保持原样返回
          // (只有 repoName 字段), 不让生态榜的改动扰动既有断言。
          if (body.includes('repo_name IN')) {
            const growth = {
              statistics: { rows_read: 2 },
              data: mockRepos.slice(0, 2).map(repo => ({
                repoName: repo.nameWithOwner,
                starsBefore: '10',
                starsWithin: '30',
                starsRecent: '20',
                starsEarlier: '10',
                firstSeenAt: '2026-10-01 00:00:00',
              })),
            } as ClickHouseResponse;

            return new Response(JSON.stringify(growth), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const response = {
            statistics: { rows_read: 2 },
            data: [
              { repoName: mockRepos[0]!.nameWithOwner },
              { repoName: mockRepos[1]!.nameWithOwner },
              { repoName: mockRepos[2]!.nameWithOwner },
            ],
          } as ClickHouseResponse;

          return new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // 生态榜取数: GitHub topic 搜索(ADR-0003)。
        // 必须显式 mock, 否则会 fallthrough 到 realFetch 打出真实网络请求。
        if (url.includes(GitHubTopicClient.baseUrl) && url.includes('/search/repositories')) {
          const search = {
            total_count: mockRepos.length,
            items: mockRepos.slice(0, 2).map(repo => ({
              full_name: repo.nameWithOwner,
              stargazers_count: repo.stargazerCount,
              description: repo.description,
              topics: repo.repositoryTopics.nodes.map(n => n.topic.name),
            })),
          };

          return new Response(JSON.stringify(search), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Scan: fetching repos details
        if (url.includes(GitHubGraphQLClient.endpoint)) {
          const response = {
            data: {
              r0: mockRepos[0],
              r1: mockRepos[1],
              r2: mockRepos[2],
            },
          };

          return new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Publish: GitHub release
        if (url.includes(GitHubClient.baseUrl) && url.includes('/releases')) {
          return new Response(JSON.stringify({ id: 'test-gh-id' }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Publish: sending email via Buttondown
        if (url.includes(ButtondownClient.baseUrl)) {
          return new Response(JSON.stringify({ id: 'test-buttondown-id', status: 'scheduled' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Delegate to the real fetch for everything else
        return realFetch(input, init);
      }
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  describe('Pipeline execution', () => {
    beforeEach(async () => {
      vi.stubEnv('USE_MOCK_REPOS', 'false');
      vi.stubEnv('RELEASE_TOP_N', '10');
      vi.stubEnv('BUTTONDOWN_ENABLED', 'true');
      vi.stubEnv('BUTTONDOWN_API_KEY', 'bd_live_key_123');
      vi.stubEnv('GITHUB_RELEASES_ENABLED', 'true');
      vi.stubEnv('GITHUB_RELEASES_REPO', 'test/repo');
      vi.stubEnv('GITHUB_TOKEN', 'ghp_test_token_123');
    });

    it('should run successfully', async () => {
      await expect(main()).resolves.not.toThrow();
    });

    it('should logs HTTP errors', async () => {
      const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.spyOn(global, 'fetch').mockRejectedValue(
        new HttpError('tag', 'message', new Response(null, { status: 500 }))
      );

      await expect(run()).resolves.not.toThrow();

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('message'));
    });

    it('should logs tagged errors', async () => {
      const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.spyOn(global, 'fetch').mockRejectedValue(new TaggedError('tag', 'message'));

      await expect(run()).resolves.not.toThrow();

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('message'));
    });

    it('should throw unhandled errors', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('message'));

      await expect(run()).rejects.toThrow('message');
    });
  });

  // 生态榜轮换记忆的接线(ADR-0003 决策 2 修订):
  // 只有 release 路径该轮换并回写; RSS 那次运行不能消耗轮转额度, 否则
  // 每天两次运行会让用户看到的 release 拿到"第二轮"结果。
  //
  // 用 chdir 到临时目录 + 断言记忆文件是否落地来验证, 而不是 mock ecosystem
  // 模块: 记忆路径是相对路径(feed/published_ecosystem.json), 落到哪里由 cwd
  // 决定, 这样既验证了真实写盘行为, 又不会污染工作区的 feed/。
  describe('生态榜轮换接线', () => {
    let workDir: string;
    let originCwd: string;
    const memoryFile = () => path.join(workDir, 'feed', 'published_ecosystem.json');

    beforeEach(() => {
      originCwd = process.cwd();
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-trends-run-'));
      // RSS 发布器要写 feed/rss.xml, 记忆文件同样落在 feed/ 下
      fs.mkdirSync(path.join(workDir, 'feed'), { recursive: true });
      process.chdir(workDir);

      vi.stubEnv('USE_MOCK_REPOS', 'false');
      vi.stubEnv('RELEASE_TOP_N', '10');
      vi.stubEnv('GITHUB_RELEASES_REPO', 'test/repo');
      vi.stubEnv('GITHUB_TOKEN', 'ghp_test_token_123');
    });

    afterEach(() => {
      process.chdir(originCwd);
      fs.rmSync(workDir, { recursive: true, force: true });
    });

    it('release 路径写出生态榜轮换记忆', async () => {
      vi.stubEnv('GITHUB_RELEASES_ENABLED', 'true');

      await main();

      expect(fs.existsSync(memoryFile())).toBe(true);
    });

    it('RSS 路径不写轮换记忆(不消耗轮转额度)', async () => {
      vi.stubEnv('GITHUB_RELEASES_ENABLED', 'false');
      vi.stubEnv('RSS_ENABLED', 'true');

      await main();

      expect(fs.existsSync(memoryFile())).toBe(false);
    });

    it('ECOSYSTEM_ROTATION_DAYS=0 时即使走 release 路径也不产生记忆文件', async () => {
      vi.stubEnv('GITHUB_RELEASES_ENABLED', 'true');
      vi.stubEnv('ECOSYSTEM_ROTATION_DAYS', '0');

      await main();

      expect(fs.existsSync(memoryFile())).toBe(false);
    });
  });
});
