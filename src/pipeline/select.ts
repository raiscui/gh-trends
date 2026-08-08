import { clamp, daysSince, hoursSince, median } from '../utils/common';
import { GithubRepo } from '../clients/github.gql';
import { logInfo } from '../utils/logging';

export interface ScoredRepo extends GithubRepo {
  score: number;
}

export function select(repos: GithubRepo[]): ScoredRepo[] {
  const topN = parseInt(process.env.RELEASE_TOP_N!);

  // ponytail: 7d trending 全集,select 阶段把"过去 24h 内才首次出现"的 repo
  // 排在同 score 的老 repo 前,这样 daily release 的 top-20 每天都会刷新一遍。
  // SCAN_WINDOW_DAYS=7 留原作者 SQL 不动;SELECT_FRESH_HOURS 让新鲜度可调。
  const freshHours = parseInt(process.env.SELECT_FRESH_HOURS ?? '24');

  const maxHours = parseInt(process.env.SCAN_WINDOW_DAYS!) * 24;
  const evalDate = process.env.SCAN_EVAL_DATE;
  const daysSinceEval = evalDate ? daysSince(evalDate) : 0;

  const ranked = repos
    .map(repo => {
      const hoursSinceFirstSeen = clamp(hoursSince(repo.clickhouse.firstSeenAt), 1, maxHours);
      const starsPerHour = parseInt(repo.clickhouse.starsWithin) / hoursSinceFirstSeen;

      // Reward repos with senior stargazers
      // Also, penalize repos with fake stars (fresh users)
      const stargazersAge = repo.stargazers.nodes.map(u => Math.round(daysSince(u.createdAt)));
      const medianStargazersAge = median(stargazersAge)!;

      const score = starsPerHour * ((medianStargazersAge - daysSinceEval) / 365);
      // SELECT_FRESH_HOURS=0 时等同原行为;默认 24 表示"昨天才火"的优先。
      const isFresh = hoursSinceFirstSeen <= freshHours;
      return { repo, score, hoursSinceFirstSeen, isFresh };
    })
    .sort((a, b) => {
      // Fresh bucket always beats legacy bucket at equal score.
      // Inside each bucket, fall back to original score desc.
      if (a.isFresh !== b.isFresh) {
        return a.isFresh ? -1 : 1;
      }
      return b.score - a.score;
    });

  const top5Missed = ranked.slice(topN, topN + 5).map(s => s.repo.nameWithOwner);
  if (top5Missed.length > 0) {
    logInfo('score', `missed the cut: ${top5Missed.join(', ')}`);
  }

  const selected = ranked.slice(0, topN);
  const freshInTop = selected.filter(s => s.isFresh).length;
  logInfo('score', `${selected.length} selected, ${freshInTop} within last ${freshHours}h`);

  return selected.map(s => ({ ...s.repo, score: s.score }));
}
