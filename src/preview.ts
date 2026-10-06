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
import { render } from './pipeline/render';
import { logInfo } from './utils/logging';
import { handleProcessError } from './utils/common';
import { filter } from './pipeline/filter';
import { dedupe, PUBLISHED_MEMORY_PATH } from './pipeline/dedupe';

async function preview() {
  const window = parseInt(process.env.SCAN_WINDOW_DAYS!);
  const limit = parseInt(process.env.SCAN_LIMIT!);

  console.log(`📡 Scanning the GitHub universe (window: ${window}, limit: ${limit})`);
  const repos = await scan();
  logInfo('scan', `${repos.length} trending repos discovered`);

  // 只读套用发布去重, 与 run 口径一致; preview 不写记忆文件
  const freshRepos = dedupe(repos, PUBLISHED_MEMORY_PATH);

  console.log('\n', `🧐 Inspecting to filter out bad stuff`);
  const filteredRepos = filter(freshRepos);
  logInfo(`filter`, `${filteredRepos.length} repos remain after filtering`);

  console.log('\n', '🏆 Ranking to select the best');
  // 跟 run.ts 保持一致:池内四榜 sub-select + 生态榜两段独立通道 → 六段 sections。
  const mainRepos = select(filteredRepos);
  const rustRepos = selectRust(filteredRepos);
  const agentRepos = selectAgent(filteredRepos);
  const deepseekHarnessRepos = selectDeepSeekHarness(filteredRepos);
  // 生态榜独立取数(ADR-0003);默认模板 text.hbs 只渲染主榜,
  // 想看生态榜段落请设 TEMPLATE_NAME=markdown.hbs
  const vercelAiSdkRepos = await buildEcosystemBoard(VERCEL_AI_SDK_BOARD);
  const aiVideoEditorRepos = await buildEcosystemBoard(AI_VIDEO_EDITOR_BOARD);
  logInfo(
    'select',
    `selected: main=${mainRepos.length}, rust=${rustRepos.length}, agent=${agentRepos.length}, deepseekHarness=${deepseekHarnessRepos.length}, vercelAiSdk=${vercelAiSdkRepos.length}, aiVideoEditor=${aiVideoEditorRepos.length}`
  );

  console.log('\n', '✍️ Crafting release content');
  const templateName = process.env.TEMPLATE_NAME || 'text.hbs';
  const content = render(templateName, {
    main: mainRepos,
    rust: rustRepos,
    agent: agentRepos,
    deepseekHarness: deepseekHarnessRepos,
    vercelAiSdk: vercelAiSdkRepos,
    aiVideoEditor: aiVideoEditorRepos,
  });
  logInfo('render', `rendered release`);

  console.log('\n', '─'.repeat(50));
  console.log(content);
}

// Run if this is the main module
if (require.main === module) {
  preview().catch(handleProcessError);
}
