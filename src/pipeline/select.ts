import { clamp, daysSince, hoursSince, median } from '../utils/common';
import { GithubRepo } from '../clients/github.gql';
import { logInfo } from '../utils/logging';

export interface ScoredRepo extends GithubRepo {
  score: number;
}

// 内部 helper:对已 filter 过的 repo 做 fresh bucket + score 排序,取 top-N。
// 被 select() 和 vertical.ts(selectRust / selectAgent)共用,以保证三榜单评分口径一致。
//
// ponytail: 把"打分 + fresh bucket + sort + slice"作为单一可复用单元;
// 比起把 sort 逻辑暴露成 Sort 工厂 / Strategy 接口,这种 rankAndSlice(repos, topN)
// 是更小、更直接的多态方式。如果未来评分公式变了,改这一处即可。
export function rankAndSlice(repos: GithubRepo[], topN: number): ScoredRepo[] {
  const freshHours = parseInt(process.env.SELECT_FRESH_HOURS ?? '24');

  // 加速度权重(specs/0001 D2): 0 = 完全关闭, 排序等价旧版纯 starsPerHour 口径
  const accelWeight = parseFloat(process.env.SELECT_ACCEL_WEIGHT ?? '0.5');

  const maxHours = parseInt(process.env.SCAN_WINDOW_DAYS!) * 24;
  const evalDate = process.env.SCAN_EVAL_DATE;
  const daysSinceEval = evalDate ? daysSince(evalDate) : 0;

  const ranked = repos
    .map(repo => {
      // eval 回溯模式下扣除 eval 偏移, 还原"相对 eval date 的真实间隔";
      // 否则历史窗口里 fresh bucket 判定永远为 false(与账龄的 eval 补偿对齐)
      const hoursSinceFirstSeen = clamp(
        hoursSince(repo.clickhouse.firstSeenAt) - daysSinceEval * 24,
        1,
        maxHours
      );
      const starsPerHour = parseInt(repo.clickhouse.starsWithin) / hoursSinceFirstSeen;

      // Reward repos with senior stargazers
      // Also, penalize repos with fake stars (fresh users)
      const stargazersAge = repo.stargazers.nodes.map(u => Math.round(daysSince(u.createdAt)));
      const medianStargazersAge = median(stargazersAge)!;

      // 加速度乘数: 窗口劈半的 recent/earlier 比值(二阶导近似)。
      // +1 平滑防除零, 同时让通道 B(earlier=0)得到有限高值而非无穷;
      // clamp [0.5, 3] 防止单一 accel 维度支配排序, W=0.5 时乘数范围 [0.75, 2.0]。
      const recent = parseInt(repo.clickhouse.starsRecent);
      const earlier = parseInt(repo.clickhouse.starsEarlier);
      const accel = clamp((recent + 1) / (earlier + 1), 0.5, 3);
      const accelMultiplier = 1 + accelWeight * (accel - 1);

      const score = starsPerHour * ((medianStargazersAge - daysSinceEval) / 365) * accelMultiplier;
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

// 主榜单入口:从 RELEASE_TOP_N 取 top-N。
export function select(repos: GithubRepo[]): ScoredRepo[] {
  const topN = parseInt(process.env.RELEASE_TOP_N!);
  return rankAndSlice(repos, topN);
}
