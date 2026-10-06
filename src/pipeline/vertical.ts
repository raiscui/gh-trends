import { GithubRepo } from '../clients/github.gql';
import { isAgentRepo } from '../clients/agentKeywords';
import { isDeepSeekHarnessRepo } from '../clients/deepSeekKeywords';
import { ScoredRepo, rankAndSlice } from './select';

// 垂直榜单入口:在主榜 filter 后的 repos 基础上,做 in-memory sub-select,
// 然后复用 rankAndSlice 走 fresh bucket + score 排序逻辑(评分口径跟主榜一致)。
//
// ponytail: 没有引入 VerticalChannelStrategy 接口;直接多个函数 +
// 各自的 top-N env 配置。比"配置驱动的多榜单"少一层抽象。
// 见 docs/adr/0002-vertical-channels-rust-and-agent.md
//
// 范围(2026-10-04 起): 本模块只保留**能在主榜池里命中**的榜 ——
// Rust / Agent / DeepSeek Harness。Vercel AI SDK 已迁到生态榜
// (pipeline/ecosystem.ts, ADR-0003), 因为成熟生态周增速个位数,
// 在主榜池的爆发式增长门槛下结构性命中为 0。

// Rust 榜单:严格按 GitHub 主导语言 = Rust 过滤(D2 = L1)。
export function selectRust(repos: GithubRepo[]): ScoredRepo[] {
  // fallback 30 与 .env.example / D9d 拍板值一致(fallback 仅 env 缺失时兜底)
  const topN = parseInt(process.env.RELEASE_TOP_N_RUST ?? '30');
  const rustRepos = repos.filter(r => r.primaryLanguage?.name === 'Rust');
  return rankAndSlice(rustRepos, topN);
}

// Agent 榜单:在 name + description 中命中 AGENT_KEYWORDS 过滤(D3 = M2)。
export function selectAgent(repos: GithubRepo[]): ScoredRepo[] {
  const topN = parseInt(process.env.RELEASE_TOP_N_AGENT ?? '30');
  const agentRepos = repos.filter(isAgentRepo);
  return rankAndSlice(agentRepos, topN);
}

// DeepSeek Harness 榜单:在 name + description 中命中 DEEPSEEK_HARNESS_KEYWORDS 过滤。
// 用户原话"增加一个 DeepSeek Harness 关键词榜单",采用 ADR-0002 同样的 vertical channel
// 模式,以保证评分口径、fail-closed 默认行为跟 Rust / Agent 榜一致。
export function selectDeepSeekHarness(repos: GithubRepo[]): ScoredRepo[] {
  const topN = parseInt(process.env.RELEASE_TOP_N_DEEPSEEK ?? '30');
  const dsRepos = repos.filter(isDeepSeekHarnessRepo);
  return rankAndSlice(dsRepos, topN);
}
