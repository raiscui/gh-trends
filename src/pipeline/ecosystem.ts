import { ClickHouseClient, ClickHouseRepo } from '../clients/clickhouse';
import { GitHubGraphQLClient } from '../clients/github.gql';
import { GitHubTopicClient, TopicCandidate } from '../clients/github.topics';
import { clamp, hoursSince } from '../utils/common';
import { logInfo, logWarn } from '../utils/logging';
import { filter } from './filter';
import { dedupe, PUBLISHED_MEMORY_PATH } from './dedupe';
import { ScoredRepo, rankAndSlice } from './select';

// ============================================================
//  生态榜(ecosystem board) —— 独立于主榜池的第二条取数通道
// ------------------------------------------------------------
//  背景与证据见 docs/adr/0003-ecosystem-boards.md。要点复述:
//
//  垂直榜(main/rust/agent/deepseek)都是主榜池的 in-memory sub-select,
//  而主榜池只收**爆发式增长**项目(通道 A 要求 7 天增速 > 基线 50%)。
//  Vercel AI SDK / AI Video Editor 是成熟生态, 周增速个位数 ——
//  实测 317 个 repo 的主榜池里, name / desc / topic 三个维度命中数全为 0。
//
//  生态榜因此绕开主榜池: 候选池来自 GitHub topic 搜索(作者主动打标,
//  是"属于该生态"最可靠的判据), 增速回 ClickHouse 取, 窗口按 ECOSYSTEM_WINDOW_DAYS。
//
//  为什么不另立一套评分: enrich 之后直接复用 filter() + rankAndSlice(),
//  与主榜同一把尺子, 避免两套排序口径漂移。
// ============================================================

// 榜单配置。topics 是该生态的 canonical 标签集合, 改词表只改这一处。
export interface EcosystemBoardConfig {
  // 对应 ReleaseSections 的字段名
  key: string;
  // 日志与文档里的可读名
  title: string;
  // GitHub topic 取数依据(单一真相源)
  topics: readonly string[];
  // top-N 的 env 名(与 .env.example 保持一致)
  topNEnv: string;
  // env 缺失时的兜底值。跟 .env.example 保持一致 —— env 是真相源,
  // 这里的数字只是防止 CI 忘配时炸掉。
  topNDefault: number;
  // 候选池收窄规则(可选)。在 topic 搜索之后、ClickHouse 增速查询之前应用。
  // 用于处理"泛用 topic 语义过宽"的生态 —— 少一个佐证维度, 候选更宽。
  refine?: (candidate: TopicCandidate) => boolean;
}

// Vercel AI SDK 生态的成员判定(2026-10-04 收紧)。
//
// 背景: `ai-sdk` 是**泛用**标签, 同时覆盖"生态核心库"与"基于该 SDK 构建的
// 任何应用"。纯 topic 判据下, JS 搜索工具 `dzhng/jevgrep`、agent 运行时
// `GCWing/OpenBitFun` 这类与 SDK 生态无实质关系的项目会混进榜, 甚至居首。
//
// 分层收紧(与 DeepSeek 榜的三层优先级同一思路):
//   1. 命中精确 topic `vercel-ai-sdk`        → 直接入榜(作者显式声明)
//   2. 仅命中泛用 topic `ai-sdk`             → 需 name/description 带 vercel 佐证
//
// 实测(2026-10-04): 候选 191 → 127, 噪音项目全部消失, 榜首变为
// assistant-ui / morphic / OpenRouterTeam/ai-sdk-provider 等真正的生态项目。
const VERCEL_AI_SDK_PRECISE_TOPICS: readonly string[] = ['vercel-ai-sdk'];
const VERCEL_AI_SDK_GENERIC_TOPICS: readonly string[] = ['ai-sdk'];
// 佐证关键词: 生态归属的品牌词, 与 name/description 做大小写不敏感匹配
const VERCEL_AI_SDK_CORROBORATION = 'vercel';

export function isVercelAiSdkEcosystemMember(candidate: TopicCandidate): boolean {
  if (candidate.topics.some(t => VERCEL_AI_SDK_PRECISE_TOPICS.includes(t))) return true;

  const isGeneric = candidate.topics.some(t => VERCEL_AI_SDK_GENERIC_TOPICS.includes(t));
  if (!isGeneric) return false;

  // 泛用 topic 需叠加品牌佐证, 才认定属于 Vercel AI SDK 生态
  const haystack = `${candidate.nameWithOwner} ${candidate.description}`.toLowerCase();
  return haystack.includes(VERCEL_AI_SDK_CORROBORATION);
}

// Vercel AI SDK 生态。两个 topic 前 100 去重后 191 个候选,
// 经 isVercelAiSdkEcosystemMember 收窄到 127 个。
export const VERCEL_AI_SDK_BOARD: EcosystemBoardConfig = {
  key: 'vercelAiSdk',
  title: 'Vercel AI SDK',
  topics: ['ai-sdk', 'vercel-ai-sdk'],
  topNEnv: 'RELEASE_TOP_N_VERCEL_AI_SDK',
  // 收紧后池内 127 个候选, 有增速数据的仅约 21(其中 7 个 28 天零增长),
  // 故取 20 而非 30 —— 30 会让榜单尾部长期由零增长条目填充。
  topNDefault: 20,
  refine: isVercelAiSdkEcosystemMember,
};

// AI 视频编辑生态。`ai-video-editor` 是最精确的主信号(115 个项目, 全是
// 对话式/自动化剪辑工具), `video-editing`(2803) 与 `ai-video`(1952) 补量。
//
// 这里不设 refine: 三个 topic 都带明确的视频语义, 泛化程度远低于
// Vercel 榜的 `ai-sdk`, 实测头部(autoclip / OpenChatCut / LocalMiniDrama)
// 无一噪音, 额外佐证只会白白削掉候选池。
export const AI_VIDEO_EDITOR_BOARD: EcosystemBoardConfig = {
  key: 'aiVideoEditor',
  title: 'AI Video Editor',
  topics: ['ai-video-editor', 'video-editing', 'ai-video'],
  topNEnv: 'RELEASE_TOP_N_AI_VIDEO_EDITOR',
  topNDefault: 30,
};

// 粗排保留的候选倍数。完整评分需要 stargazers 账龄(只有 enrich 后才有),
// 而 enrich 要为每个候选打一次 GraphQL; 先按增速粗排再截断, 把请求数
// 从"全池"压到 3×N, 余量足以兜住粗排忽略账龄因子带来的排序偏差。
const CANDIDATE_MULTIPLIER = 3;

// 候选硬上限。即使把 RELEASE_TOP_N_* 调到很大, enrich 请求数也不会失控。
const MAX_CANDIDATES = 120;

// 两个生态榜与池内四榜共用发布记忆, 在截断候选之前排除已发布项目.
// 取数失败仍只留空本段, 候选不足时不补回昨天的项目.
export async function buildEcosystemBoard(
  config: EcosystemBoardConfig,
  memoryPath: string = PUBLISHED_MEMORY_PATH
): Promise<ScoredRepo[]> {
  const topN = parseInt(process.env[config.topNEnv] ?? String(config.topNDefault));
  const windowDays = parseInt(process.env.ECOSYSTEM_WINDOW_DAYS ?? '28');
  const token = process.env.GITHUB_TOKEN ?? '';

  try {
    // ① 生态候选池: GitHub topic 搜索(作者主动打标, 比 name/description 关键词可靠)
    const searched = await new GitHubTopicClient(token).searchByTopics(config.topics);
    if (searched.length === 0) {
      logWarn('ecosystem', `${config.title}: topic 搜索无结果, 该榜留空`);
      return [];
    }

    // ①b 成员收窄(可选)。放在这一步而不是 enrich 之后, 是为了让泛用 topic
    //     带来的噪音候选连 ClickHouse 增速查询都省掉。
    const members = config.refine ? searched.filter(config.refine) : searched;
    const candidates = dedupe(members, memoryPath);
    logInfo(
      'ecosystem',
      `${config.title}: topic 搜索 ${searched.length} -> 成员判定保留 ${candidates.length}`
    );
    if (candidates.length === 0) {
      logWarn('ecosystem', `${config.title}: 成员判定后无候选, 该榜留空`);
      return [];
    }

    // ② 回 ClickHouse 取窗口内增速。只返回确实有 star 事件的 repo ——
    //    零事件 repo 排不进榜, 提前剔除以省下后面的 enrich 配额。
    const growth = await new ClickHouseClient().getRepoGrowth(
      candidates.map(c => c.nameWithOwner),
      windowDays
    );
    if (growth.length === 0) {
      logWarn(
        'ecosystem',
        `${config.title}: ${candidates.length} 个候选在 ClickHouse 均无 star 事件, 该榜留空`
      );
      return [];
    }

    // ③ 粗排截断: 按 starsPerHour 降序取 3×N 候选
    const candidateCap = Math.min(topN * CANDIDATE_MULTIPLIER, MAX_CANDIDATES);
    const coarse = [...growth]
      .sort((a, b) => starsPerHour(b, windowDays) - starsPerHour(a, windowDays))
      .slice(0, candidateCap);
    logInfo(
      'ecosystem',
      `${config.title}: ${candidates.length} 候选 -> ${growth.length} 有增速 -> 粗排保留 ${coarse.length}`
    );

    // ④ enrich: 复用主榜同一个 GraphQL 客户端, 补 stargazers(供账龄因子)等字段
    const enriched = await new GitHubGraphQLClient(token).getRepos(coarse);

    // ⑤ 复用主榜的质量门槛与排序, 不为生态榜另立一套
    const filtered = filter(enriched);

    const selected = rankAndSlice(filtered, topN, windowDays);
    logInfo('ecosystem', `${config.title}: ${selected.length} selected (window ${windowDays}d)`);
    return selected;
  } catch (err) {
    logWarn('ecosystem', `${config.title} 生态榜构建失败, 本段留空: ${err}`);
    return [];
  }
}

// 粗排用的增速估计: 窗口内 star 事件数 / 该 repo 在采样表里的账龄。
//
// 与 rankAndSlice 内部同口径(同一个 clamp 上限), 差别只在于少了
// stargazers 账龄因子 —— 那份数据要 enrich 之后才有, 而粗排的职责
// 只是把明显不可能进榜的尾部截掉, 不需要排序完全一致。
function starsPerHour(growth: ClickHouseRepo, windowDays: number): number {
  const maxHours = windowDays * 24;
  const hours = clamp(hoursSince(growth.firstSeenAt), 1, maxHours);
  return parseInt(growth.starsWithin) / hours;
}
