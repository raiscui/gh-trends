import { HttpError, TaggedError, logWarn } from '../utils/logging';

export interface GithubReleasePayload {
  tag_name: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
}

// 重试参数。默认值按"GitHub 侧瞬时故障通常几秒内自愈"取值,
// 不足以自愈时宁可当天发布失败, 也不要用陈旧数据发布一份错的 release。
//
// env 可调: RELEASE_CREATE_MAX_ATTEMPTS=1 即关闭重试(回到旧行为);
// RELEASE_CREATE_RETRY_BASE_MS 在测试里置 0 可避免真实等待。
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

// 指数退避的上限。GitHub 500 恢复很快, 退避到 8s 以上收益不大,
// 反而拖慢 daily schedule(错过当天 tag 窗口就要等下一天)。
const MAX_DELAY_MS = 8000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 只对"重试有意义"的失败重试:
//   - HttpError 且 5xx  → GitHub 侧瞬时故障
//   - 非 TaggedError   → fetch 直接 reject, 属网络层异常
// 4xx 与业务性 TaggedError 是请求本身/数据本身有问题, 重试只是浪费配额。
function isRetryable(err: unknown): boolean {
  // HttpError 继承 TaggedError, 必须先判子类
  if (err instanceof HttpError) return err.response.status >= 500;
  return !(err instanceof TaggedError);
}

// 通用重试包装(指数退避)。
async function withRetry<T>(operation: string, run: () => Promise<T>): Promise<T> {
  const maxAttempts = parseInt(
    process.env.RELEASE_CREATE_MAX_ATTEMPTS ?? String(DEFAULT_MAX_ATTEMPTS)
  );
  const baseDelay = parseInt(
    process.env.RELEASE_CREATE_RETRY_BASE_MS ?? String(DEFAULT_BASE_DELAY_MS)
  );

  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;

      const delay = Math.min(baseDelay * 2 ** (attempt - 1), MAX_DELAY_MS);
      logWarn(
        'github',
        `${operation} 失败, ${delay}ms 后重试 (第 ${attempt}/${maxAttempts - 1} 次): ${err}`
      );
      await sleep(delay);
    }
  }
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

  // 创建 release。
  //
  // 加重试的原因(2026-10-07 事故): 当天六个榜单的数据全部选出,
  // 却因 GitHub 返回 500(且响应体为空)导致整份内容直接丢失 —— release 是
  // 唯一承载当天结果的产物, 单次网络抖动不该造成整天空窗。
  async createRelease(repo: string, release: GithubReleasePayload): Promise<{ id: string }> {
    return withRetry(`createRelease(${release.tag_name})`, async () => {
      const response = await fetch(`${GitHubClient.baseUrl}/repos/${repo}/releases`, {
        method: 'POST',
        body: JSON.stringify(release),
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
        },
      });

      // 422 = 该 tag 已存在。重试场景下必须把它当成功处理:
      // 上一次 POST 可能**服务端已创建成功、只是响应在回程丢了**, 重试拿到 422,
      // 若当失败抛出, 就把"已发布"变成"发布失败" —— 比不做重试更糟。
      // 反查 tag 拿到 id 既幂等, 也顺带覆盖了"同日重跑"的竞态。
      if (response.status === 422) {
        const existing = await this.getReleaseByTag(repo, release.tag_name);
        if (existing) {
          logWarn(
            'github',
            `release ${release.tag_name} already exists (id=${existing.id}); treating 422 as success`
          );
          return existing;
        }
        throw new HttpError('github', 'release creation failed (422, tag not found)', response);
      }

      if (!response.ok) {
        throw new HttpError('github', 'release creation failed', response);
      }

      const json = await response.json();
      if (!json.id) {
        throw new TaggedError('github', 'release creation returned no ID', { response: json });
      }

      return { id: json.id.toString() };
    });
  }
}
