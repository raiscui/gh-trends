import { GithubRepo } from '../clients/github.gql';
import { isAgentRepo } from '../clients/agentKeywords';
import { ScoredRepo, rankAndSlice } from './select';

// 垂直榜单入口:在主榜 filter 后的 repos 基础上,做 in-memory sub-select,
// 然后复用 rankAndSlice 走 fresh bucket + score 排序逻辑(评分口径跟主榜一致)。
//
// ponytail: 没有引入 VerticalChannelStrategy 接口;直接两个函数 +
// 各自的 top-N env 配置。比"配置驱动的多榜单"少一层抽象。
// 见 docs/adr/0002-vertical-channels-rust-and-agent.md

// Rust 榜单:严格按 GitHub 主导语言 = Rust 过滤(D2 = L1)。
export function selectRust(repos: GithubRepo[]): ScoredRepo[] {
  const topN = parseInt(process.env.RELEASE_TOP_N_RUST ?? '15');
  const rustRepos = repos.filter(r => r.primaryLanguage?.name === 'Rust');
  return rankAndSlice(rustRepos, topN);
}

// Agent 榜单:在 name + description 中命中 AGENT_KEYWORDS 过滤(D3 = M2)。
export function selectAgent(repos: GithubRepo[]): ScoredRepo[] {
  const topN = parseInt(process.env.RELEASE_TOP_N_AGENT ?? '15');
  const agentRepos = repos.filter(isAgentRepo);
  return rankAndSlice(agentRepos, topN);
}
