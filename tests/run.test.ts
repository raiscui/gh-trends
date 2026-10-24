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
import * as ecosystem from '../src/pipeline/ecosystem';
import { makeRepo } from './helpers';

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

  describe('六榜发布记忆接线', () => {
    let workDir: string;
    let originCwd: string;
    const memoryFile = () => path.join(workDir, 'feed', 'published.json');

    beforeEach(() => {
      originCwd = process.cwd();
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-trends-run-'));
      fs.symlinkSync(path.join(originCwd, 'src'), path.join(workDir, 'src'), 'dir');
      process.chdir(workDir);
      fs.mkdirSync(path.join(workDir, 'feed'), { recursive: true });
      vi.spyOn(GitHubClient.prototype, 'getReleaseByTag').mockResolvedValue(null);
      vi.stubEnv('USE_MOCK_REPOS', 'false');
      vi.stubEnv('RELEASE_TOP_N', '10');
      vi.stubEnv('GITHUB_RELEASES_REPO', 'test/repo');
      vi.stubEnv('GITHUB_TOKEN', 'ghp_test_token_123');
      vi.stubEnv('PUBLISHED_MEMORY_ENABLED', 'true');
      vi.stubEnv('BUTTONDOWN_ENABLED', 'false');
      vi.stubEnv('RESEND_ENABLED', 'false');
      vi.stubEnv('RSS_ENABLED', 'false');
      vi.stubEnv('GITHUB_RELEASES_ENABLED', 'false');
    });

    afterEach(() => {
      process.chdir(originCwd);
      fs.rmSync(workDir, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it.each(['GITHUB_RELEASES_ENABLED', 'RSS_ENABLED'])('%s 发布后记录记忆', async enabled => {
      vi.stubEnv(enabled, 'true');
      await main();
      expect(
        Object.keys(JSON.parse(fs.readFileSync(memoryFile(), 'utf-8'))).length
      ).toBeGreaterThan(0);
    });

    it('六榜完整并集入记忆, 跨榜同名项目只记录一次', async () => {
      vi.stubEnv('GITHUB_RELEASES_ENABLED', 'true');
      vi.spyOn(ecosystem, 'buildEcosystemBoard').mockImplementation(async board => [
        { ...makeRepo({ name: `eco/${board.key}` }), score: 1 },
      ]);
      await main();
      const memory = JSON.parse(fs.readFileSync(memoryFile(), 'utf-8'));
      expect(memory['eco/vercelAiSdk']).toBeDefined();
      expect(memory['eco/aiVideoEditor']).toBeDefined();
      expect(Object.keys(memory)).toEqual(expect.arrayContaining([mockRepos[0]!.nameWithOwner]));
    });

    it('池内四榜候选全被去重时, 生态榜仍能发布且不带昨天项目', async () => {
      vi.stubEnv('GITHUB_RELEASES_ENABLED', 'true');
      const yesterday = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
      fs.writeFileSync(
        memoryFile(),
        JSON.stringify(Object.fromEntries(mockRepos.map(r => [r.nameWithOwner, yesterday])))
      );
      vi.spyOn(ecosystem, 'buildEcosystemBoard').mockImplementation(async board => [
        { ...makeRepo({ name: `eco/${board.key}` }), score: 1 },
      ]);
      const create = vi
        .spyOn(GitHubClient.prototype, 'createRelease')
        .mockResolvedValue({ id: 'new' });
      await main();
      const body = create.mock.calls[0]![1].body;
      expect(body).toContain('eco/vercelAiSdk');
      expect(body).toContain('eco/aiVideoEditor');
      for (const repo of mockRepos) expect(body).not.toContain(repo.url);
    });

    it('已有 release 跳过发布时不记录这次新选出的名单', async () => {
      vi.stubEnv('GITHUB_RELEASES_ENABLED', 'true');
      vi.mocked(GitHubClient.prototype.getReleaseByTag).mockResolvedValue({ id: 'existing' });
      await main();
      expect(fs.existsSync(memoryFile())).toBe(false);
    });

    it('没有发布器启用时不写记忆', async () => {
      await main();
      expect(fs.existsSync(memoryFile())).toBe(false);
    });

    it('发布失败时不写记忆', async () => {
      vi.stubEnv('GITHUB_RELEASES_ENABLED', 'true');
      vi.spyOn(GitHubClient.prototype, 'createRelease').mockRejectedValue(
        new Error('publish failed')
      );
      await expect(main()).rejects.toThrow('publish failed');
      expect(fs.existsSync(memoryFile())).toBe(false);
    });
  });
});
