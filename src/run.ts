#!/usr/bin/env node

import 'dotenv-flow/config';
import { scan } from './pipeline/scan';
import { select } from './pipeline/select';
import { selectRust, selectAgent, selectDeepSeekHarness } from './pipeline/vertical';
import { publishAll } from './pipeline/publish';
import { logInfo, TaggedError } from './utils/logging';
import { handleProcessError } from './utils/common';
import { filter } from './pipeline/filter';

export async function run(): Promise<void> {
  await main().catch(handleProcessError);
}

export async function main(): Promise<void> {
  const window = parseInt(process.env.SCAN_WINDOW_DAYS!);
  const limit = parseInt(process.env.SCAN_LIMIT!);

  console.log(`📡 Scanning the GitHub universe (window: ${window}, limit: ${limit})`);
  const trendingRepos = await scan();
  logInfo('scan', `${trendingRepos.length} trending repos discovered`);

  if (trendingRepos.length === 0) {
    throw new TaggedError(`scan`, 'no repos found; aborting');
  }

  console.log('\n', `🧐 Inspecting to filter out bad stuff`);
  const filteredRepos = filter(trendingRepos);
  logInfo(`filter`, `${filteredRepos.length} repos remain after filtering`);

  const remainingPercent = (filteredRepos.length / trendingRepos.length) * 100;
  const filteredCount = trendingRepos.length - filteredRepos.length;
  if (filteredCount > 5 && remainingPercent < 50) {
    throw new TaggedError(`filter`, 'too many repos filtered out; aborting');
  }

  console.log('\n', '🏆 Ranking to select the best');
  // 共享 filter 后的 repo pool,做四道 sub-select:
  //   - 主榜: rankAndSlice(filtered, RELEASE_TOP_N=20)
  //   - Rust 榜: filter(primaryLanguage=Rust) → rankAndSlice(RELEASE_TOP_N_RUST=15)
  //   - Agent 榜: filter(isAgentRepo) → rankAndSlice(RELEASE_TOP_N_AGENT=15)
  //   - DeepSeek Harness 榜: filter(isDeepSeekHarnessRepo) → rankAndSlice(RELEASE_TOP_N_DEEPSEEK=15)
  // 四榜单评分口径一致(fresh bucket + starsPerHour × medianAge),D4 = X1 允许重叠。
  const mainRepos = select(filteredRepos);
  const rustRepos = selectRust(filteredRepos);
  const agentRepos = selectAgent(filteredRepos);
  const deepseekHarnessRepos = selectDeepSeekHarness(filteredRepos);
  logInfo(
    'score',
    `selected: main=${mainRepos.length}, rust=${rustRepos.length}, agent=${agentRepos.length}, deepseekHarness=${deepseekHarnessRepos.length}`
  );

  console.log('\n', '📮 Publishing to all enabled channels');
  const messageIds = await publishAll({
    main: mainRepos,
    rust: rustRepos,
    agent: agentRepos,
    deepseekHarness: deepseekHarnessRepos,
  });
  logInfo('publish', `published release (IDs: ${messageIds.join(', ')})`);
}

// Run if this is the main module
if (require.main === module) {
  void run();
}
