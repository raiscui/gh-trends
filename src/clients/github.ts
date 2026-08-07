import { HttpError, TaggedError } from '../utils/logging';

export interface GithubReleasePayload {
  tag_name: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
}

export class GitHubClient {
  public static readonly baseUrl = 'https://api.github.com';
  private readonly token: string;

  constructor(token?: string) {
    if (!token) throw new TaggedError('config', 'GITHUB_TOKEN required');
    this.token = token;
  }

  // ponytail: GET-by-tag is 1 round-trip; cheap enough for daily schedule.
  // 用法：当 schedule 同周内多次 daily 跑,epoch-week 编号会重复,
  // 跳过已有 release 而非让 422 让 run 失败。
  async getReleaseByTag(repo: string, tag: string): Promise<{ id: string } | null> {
    const response = await fetch(
      `${GitHubClient.baseUrl}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
        },
      }
    );

    // 404 = 该 tag 没发布过,正是我们要的结果(允许发布新 release)。
    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new HttpError('github', 'release lookup failed', response);
    }

    const json = (await response.json()) as { id?: number | string };
    if (!json.id) {
      throw new TaggedError('github', 'release lookup returned no ID', { tag });
    }

    return { id: json.id.toString() };
  }

  async createRelease(repo: string, release: GithubReleasePayload): Promise<{ id: string }> {
    const response = await fetch(`${GitHubClient.baseUrl}/repos/${repo}/releases`, {
      method: 'POST',
      body: JSON.stringify(release),
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!response.ok) {
      throw new HttpError('github', 'release creation failed', response);
    }

    const json = await response.json();
    if (!json.id) {
      throw new TaggedError('github', 'release creation returned no ID', { response: json });
    }

    return { id: json.id.toString() };
  }
}
