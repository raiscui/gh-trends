#!/usr/bin/env node

import 'dotenv-flow/config';
import { scan } from './pipeline/scan';
import { select } from './pipeline/select';
import { selectRust, selectAgent, selectDeepSeekHarness } from './pipeline/vertical';
import {
  buildEcosystemBoard,
  VERCEL_AI_SDK_BOARD,
  AI_VIDEO_EDITOR_BOARD,
} from './pipeline/ecosystem';
import { publishAll } from './pipeline/publish';
import { logInfo, TaggedError } from './utils/logging';
import { handleProcessError } from './utils/common';
import { filter } from './pipeline/filter';
import { dedupe, recordPublished, PUBLISHED_MEMORY_PATH } from './pipeline/dedupe';

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

  // 发布去重(specs/0001 D3): 剔除 UTC 今天及昨天已发布的项目, 须在 filter 之前
  // —— 被剔除项目不进 guard 分母, fail-closed 只会更安全
  const freshRepos = dedupe(trendingRepos, PUBLISHED_MEMORY_PATH);

  console.log('\n', `🧐 Inspecting to filter out bad stuff`);
  const filteredRepos = filter(freshRepos);
  logInfo(`filter`, `${filteredRepos.length} repos remain after filtering`);

  const remainingPercent =
    freshRepos.length === 0 ? 0 : (filteredRepos.length / freshRepos.length) * 100;
  const filteredCount = freshRepos.length - filteredRepos.length;
  if (filteredCount > 5 && remainingPercent < 50) {
    throw new TaggedError(`filter`, 'too many repos filtered out; aborting');
  }

  console.log('\n', '🏆 Ranking to select the best');
  // 池内四榜(共享 filter 后的 repo pool,做 sub-select):
  //   - 主榜: rankAndSlice(filtered, RELEASE_TOP_N=20)
  //   - Rust 榜: filter(primaryLanguage=Rust) → rankAndSlice(RELEASE_TOP_N_RUST=30)
  //   - Agent 榜: filter(isAgentRepo) → rankAndSlice(RELEASE_TOP_N_AGENT=30)
  //   - DeepSeek Harness 榜: filter(isDeepSeekHarnessRepo) → rankAndSlice(RELEASE_TOP_N_DEEPSEEK=30)
  // 各榜单评分口径一致(fresh bucket + starsPerHour × medianAge),D4 = X1 允许重叠。
  const mainRepos = select(filteredRepos);
  const rustRepos = selectRust(filteredRepos);
  const agentRepos = selectAgent(filteredRepos);
  const deepseekHarnessRepos = selectDeepSeekHarness(filteredRepos);

  // 生态榜两段(Vercel AI SDK / AI Video Editor)走独立取数通道,见 ADR-0003:
  // 候选池来自 GitHub topic 搜索而非主榜池, 排序窗口 ECOSYSTEM_WINDOW_DAYS。
  // 两者均 fail-soft, 失败只留空不影响其余段落发布。
  //
  const vercelAiSdkRepos = await buildEcosystemBoard(VERCEL_AI_SDK_BOARD);
  const aiVideoEditorRepos = await buildEcosystemBoard(AI_VIDEO_EDITOR_BOARD);
  logInfo(
    'score',
    `selected: main=${mainRepos.length}, rust=${rustRepos.length}, agent=${agentRepos.length}, deepseekHarness=${deepseekHarnessRepos.length}, vercelAiSdk=${vercelAiSdkRepos.length}, aiVideoEditor=${aiVideoEditorRepos.length}`
  );

  console.log('\n', '📮 Publishing to all enabled channels');
  const messageIds = await publishAll({
    main: mainRepos,
    rust: rustRepos,
    agent: agentRepos,
    deepseekHarness: deepseekHarnessRepos,
    vercelAiSdk: vercelAiSdkRepos,
    aiVideoEditor: aiVideoEditorRepos,
  });
  logInfo('publish', `published release (IDs: ${messageIds.join(', ')})`);

  // 已存在的 release 和无更新的 RSS 都没有发布本次候选, 不应消耗它们.
  const didPublish = messageIds.some(
    id => !id.startsWith('release-already-exists-') && id !== 'rss-no-update'
  );
  if (didPublish) {
    // 六榜只有 GitHub release 全部呈现; 邮件和 RSS 只发布主榜.
    const publishedBoards =
      process.env.GITHUB_RELEASES_ENABLED === 'true' &&
      !messageIds.some(id => id.startsWith('release-already-exists-'))
        ? [
            mainRepos,
            rustRepos,
            agentRepos,
            deepseekHarnessRepos,
            vercelAiSdkRepos,
            aiVideoEditorRepos,
          ]
        : [mainRepos];
    const publishedNames = [...new Set(publishedBoards.flat().map(r => r.nameWithOwner))];
    recordPublished(publishedNames, PUBLISHED_MEMORY_PATH);
  }
}

// Run if this is the main module
if (require.main === module) {
  void run();
}
