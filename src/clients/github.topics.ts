import { HttpError, TaggedError, logInfo, logWarn } from '../utils/logging';

// ============================================================
//  生态榜独立取数源: GitHub topic 搜索
// ------------------------------------------------------------
//  2026-10-04 新增, 见 docs/adr/0003-ecosystem-boards.md。
//
//  为什么需要它: 主榜池(trending pool)只收"爆发式增长"项目
//  (通道 A 要求 7 天增速 > 基线 50%, 通道 B 要求从零爆火)。
//  Vercel AI SDK / AI Video Editor 这类**成熟基础设施生态**的周增速
//  只有个位数, 结构性够不到门槛 —— 实测 317 个 repo 的主榜池里,
//  name / description / topic 三个维度命中数全部为 0。
//
//  所以生态榜不能沿用"主榜池 sub-select", 必须自己从 GitHub 按
//  topic 拉候选池, 再回 ClickHouse 取增速排序(见 pipeline/ecosystem.ts)。
// ============================================================

// topic 搜索返回的候选 repo。刻意只保留"粗排 + 打标"需要的最小字段集:
// stargazers / owner / primaryLanguage 等重字段留给 getRepos() 二次补齐,
// 避免在这里把整池的 GraphQL 配额一次性烧光。
export interface TopicCandidate {
  nameWithOwner: string;
  stargazerCount: number;
  description: string;
  // 作者主动打的 topic 标签(小写)。既是本次的取数依据, 也保留下来
  // 供上层做更细的生态归类。
  topics: string[];
}

// 每个 topic 取多少条。100 = GitHub Search API 单页上限, 也是
// "生态里值得上榜的头部项目"的经验规模: 实测 Vercel AI SDK 两个 topic
// 前 100 条去重后 191 个, 已覆盖该生态所有有分量的项目。
const DEFAULT_PER_TOPIC = 100;

export class GitHubTopicClient {
  static readonly baseUrl = 'https://api.github.com';

  constructor(private readonly token: string) {
    if (!token) throw new TaggedError('config', 'GITHUB_TOKEN required');
  }

  // 多个 topic 取并集: 同一 repo 命中多个 topic 只保留一条。
  //
  // fail-soft: 单个 topic 查不到(404 / 限流 / topic 改名)只 WARN 不抛,
  // 一个标签失效不该让整榜消失。只有**全部** topic 都失败才抛错,
  // 由上层 buildEcosystemBoard 统一降级为空榜。
  async searchByTopics(
    topics: readonly string[],
    perTopic = DEFAULT_PER_TOPIC
  ): Promise<TopicCandidate[]> {
    const merged = new Map<string, TopicCandidate>();
    let okCount = 0;

    for (const topic of topics) {
      try {
        const items = await this.searchTopic(topic, perTopic);
        okCount += 1;
        logInfo('topic', `topic:${topic} -> ${items.length} repos`);
        for (const item of items) {
          // first-wins: 多个 topic 命中同一 repo 时保留先到的那条,
          // 避免后来的结果覆盖掉更完整的 topics 列表
          if (!merged.has(item.nameWithOwner)) merged.set(item.nameWithOwner, item);
        }
      } catch (err) {
        logWarn('topic', `topic:${topic} 搜索失败, 跳过该标签: ${err}`);
      }
    }

    if (okCount === 0) {
      throw new TaggedError('topic', `所有 topic 均搜索失败: ${topics.join(', ')}`);
    }
    return [...merged.values()];
  }

  // 单 topic 搜索, 按 star 降序取前 perPage 条
  private async searchTopic(topic: string, perPage: number): Promise<TopicCandidate[]> {
    const query = new URLSearchParams({
      q: `topic:${topic}`,
      sort: 'stars',
      order: 'desc',
      per_page: String(perPage),
    });
    const url = `${GitHubTopicClient.baseUrl}/search/repositories?${query}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gh-trends',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      throw new HttpError('topic', `searching topic "${topic}" failed`, response);
    }

    const json = (await response.json()) as { items?: RestRepo[] };
    return (json.items ?? []).map(toCandidate);
  }
}

// GitHub Search API 的 item 形状(只取我们用得到的字段)
interface RestRepo {
  full_name: string;
  stargazers_count: number;
  description: string | null;
  topics?: string[];
}

function toCandidate(repo: RestRepo): TopicCandidate {
  return {
    nameWithOwner: repo.full_name,
    stargazerCount: repo.stargazers_count,
    description: repo.description ?? '',
    topics: (repo.topics ?? []).map(t => t.toLowerCase()),
  };
}
