import { daysSince } from '../utils/common';
import { GithubRepo } from '../clients/github.gql';
import { logInfo, logWarn } from '../utils/logging';

export interface ScoredRepo extends GithubRepo {
  score: number;
}

export function filter(repos: GithubRepo[]): GithubRepo[] {
  const minStars = parseInt(process.env.FILTER_MIN_STARS!);

  // Sometimes renamed filter catches non-renamed repos due to aggressive
  // sampling from Clickhouse - or Github?; During those periods, we allow
  // renamed repos. Ideally, this should always be enabled
  const filterRenamed = process.env.FILTER_RENAMED === 'true';

  return repos.filter(repo => {
    const repoName = repo.nameWithOwner;

    // Apply minimum stars filter
    if (repo.stargazerCount < minStars) {
      logInfo('filter', `too few stars, skipping: ${repoName}`);
      return false;
    }

    // Catch renamed repos based on star gap between Clickhouse and Github
    // Only applicable when eval date is unset/today
    const evalDate = process.env.SCAN_EVAL_DATE;
    if (!evalDate && filterRenamed) {
      const clickhouseTotalStars =
        parseInt(repo.clickhouse.starsBefore) + parseInt(repo.clickhouse.starsWithin);

      // NOTE: Clickhouse samples events, so the actual star count (as per
      // Github) is likely 2x the reported from Clickhouse. However, if the
      // ratio is >5x, it's almost certainly a renamed repo.
      const starGapFactor = Math.round(repo.stargazerCount / clickhouseTotalStars);
      if (starGapFactor > 5) {
        logWarn('filter', `renamed old repo (x${starGapFactor} gap), skipping: ${repoName}`);
        return false;
      }
    }

    if (process.env.FILTER_EMPTY_DESC === 'true') {
      if (repo.description === null || repo.description.trim() === '') {
        logWarn('filter', `empty description, skipping: ${repoName}`);
        return false;
      }
    }

    // CJK 描述过滤已于 2026-09-29 移除(上游 mhadidg 为英文 newsletter 设计的启发式)。
    // 移除原因: 它把"描述含汉字"等同于低质量,但本 pipeline 关注的 AI 开源生态
    // (DeepSeek Harness / Vercel AI SDK 等)主力开发者就是中文圈,描述用中文是正常表达。
    // 实测 300 个 trending 项目中被该规则剔除 23 个,含 dshtauri/deepseek-harness-desktop
    // (2848 ⭐)等生态核心项目,导致 DeepSeek 榜结构性空榜。
    // 防垃圾能力由 FILTER_MIN_STARS 与 FILTER_FRESH_OWNER(fresh owner 钓鱼仓库)承担。

    // Catch malware repos (mostly crypto wallet drainers)
    // Adjust for eval date if set (historical scans)
    const filterFreshOwner = process.env.FILTER_FRESH_OWNER === 'true';
    const daysSinceEval = evalDate ? daysSince(evalDate) : 0;
    if (
      filterFreshOwner &&
      repo.owner.__typename === 'User' &&
      daysSince(repo.owner.createdAt) - daysSinceEval < 30
    ) {
      logWarn('filter', `malware repo (fresh owner), skipping: ${repoName}`);
      return false;
    }

    return true;
  });
}
