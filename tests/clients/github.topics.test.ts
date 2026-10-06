import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubTopicClient } from '../../src/clients/github.topics';

// ADR-0003: 生态榜取数源。多 topic 并集 + fail-soft 降级是这里最关键的行为。
// 本文件全部用例都用 vi.spyOn 拦掉 fetch, 不放行真实网络请求。
describe('GitHubTopicClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 按 topic 关键词返回可控结果
  interface SearchReply {
    status?: number;
    items?: unknown[];
  }
  function mockSearch(handler: (topic: string) => SearchReply) {
    vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      // URLSearchParams 会把 ':' 编码成 %3A, 必须走 URL/searchParams 解析,
      // 直接 split 'q=topic:' 会在编码后的 URL 上匹配失败
      const q = new URL(String(input)).searchParams.get('q') ?? '';
      const topic = q.replace(/^topic:/, '');
      const { status = 200, items = [] } = handler(topic);
      return new Response(JSON.stringify({ total_count: items.length, items }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  const item = (full_name: string, topics: string[] = [], stars = 100) => ({
    full_name,
    stargazers_count: stars,
    description: `${full_name} desc`,
    topics,
  });

  it('多 topic 取并集, 同一 repo 命中多个 topic 只保留一条', async () => {
    mockSearch(topic =>
      topic === 'ai-sdk'
        ? { items: [item('a/one'), item('a/shared')] }
        : { items: [item('b/two'), item('a/shared')] }
    );
    const client = new GitHubTopicClient('token');

    const out = await client.searchByTopics(['ai-sdk', 'vercel-ai-sdk']);

    expect(out.map(c => c.nameWithOwner).sort()).toEqual(['a/one', 'a/shared', 'b/two']);
  });

  it('按 star 降序请求单页前 100 条', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await new GitHubTopicClient('token').searchByTopics(['ai-sdk']);

    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain('sort=stars');
    expect(url).toContain('order=desc');
    expect(url).toContain('per_page=100');
  });

  it('topics 归一化为小写', async () => {
    mockSearch(() => ({ items: [item('a/one', ['AI-SDK', 'Vercel-AI-SDK'])] }));
    const client = new GitHubTopicClient('token');

    const [candidate] = await client.searchByTopics(['ai-sdk']);

    expect(candidate!.topics).toEqual(['ai-sdk', 'vercel-ai-sdk']);
  });

  it('description 为 null 时兜底为空串(不产生 null 参与下游匹配)', async () => {
    mockSearch(() => ({
      items: [{ full_name: 'a/bare', stargazers_count: 5, description: null }],
    }));
    const client = new GitHubTopicClient('token');

    const [candidate] = await client.searchByTopics(['ai-sdk']);

    expect(candidate!.description).toBe('');
  });

  it('单个 topic 失败只跳过该标签, 不影响其余 topic', async () => {
    mockSearch(topic => (topic === 'gone' ? { status: 422 } : { items: [item('a/survived')] }));
    const client = new GitHubTopicClient('token');

    const out = await client.searchByTopics(['gone', 'alive']);

    expect(out.map(c => c.nameWithOwner)).toEqual(['a/survived']);
  });

  it('全部 topic 失败才抛错(交由上层降级为空榜)', async () => {
    mockSearch(() => ({ status: 403 }));
    const client = new GitHubTopicClient('token');

    await expect(client.searchByTopics(['x', 'y'])).rejects.toThrow('所有 topic 均搜索失败');
  });

  it('无 token 时构造即失败', () => {
    expect(() => new GitHubTopicClient('')).toThrow('GITHUB_TOKEN required');
  });

  it('请求带认证头', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await new GitHubTopicClient('tok_123').searchByTopics(['ai-sdk']);

    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok_123');
  });
});
