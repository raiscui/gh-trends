import { GithubRepo } from './github.gql';

// ============================================================
//  DeepSeek Harness 垂直榜单匹配(单一真相源)
// ------------------------------------------------------------
//  2026-09-29 重构:从"纯关键词 substring"改为"topic 优先 + 关键词兜底"。
//  背景见 docs/adr/0002 的 D11 段。
// ============================================================

// 强信号 topic: GitHub 生态里 DeepSeek Harness 项目的标准标签,
//  官方仓库 deepseek-ai/deepseek-harness 同时带 dsh + dsh-plugin。
// 命中任一即可认定属于该生态。
export const DEEPSEEK_HARNESS_TOPICS: readonly string[] = ['dsh', 'deepseek-harness'];

// 弱信号 topic: `dsh-plugin` 被大量通用项目当作"我支持 agent 插件"的泛标签
// (实测 star 前 100 里有 PicGo / Tencent-WeKnora / OpenBitFun 等无关项目),
// 单独使用会严重污染榜单, 因此只在**同时**命中 repo 名或描述时才算数。
export const DEEPSEEK_HARNESS_SUPPORT_TOPICS: readonly string[] = ['dsh-plugin'];

// 关键词兜底(2026-08-17 起沿用): topic 之外的补充信号, 用于抓那些没打标签的项目。
// 注意 `dsh` 是 3 字母 substring, 会误伤(dream-num/univer "Office Harness for AI
// Agents" 就因此误命中), 所以关键词只作补充, topic 才是主判据。
export const DEEPSEEK_HARNESS_KEYWORDS: readonly string[] = ['cordis', 'dsh', 'dsh-plugin'];

// 匹配优先级(2026-09-29 实测校准):
//   1. 命中强信号 topic(dsh / deepseek-harness)              → 命中
//   2. 命中 dsh-plugin topic,且 name 或 desc 同时有生态关键词 → 命中
//   3. name 或 desc 命中关键词(老口径, 保留兜底)              → 命中
export function isDeepSeekHarnessRepo(repo: GithubRepo): boolean {
  const topics = readTopics(repo);
  const name = repo.nameWithOwner;
  const desc = repo.description ?? undefined;

  // 1. 强信号 topic: 作者主动打的生态标签, 可信度最高
  if (hasAnyTopic(topics, DEEPSEEK_HARNESS_TOPICS)) return true;

  // 2. 弱信号 topic 需叠加关键词佐证, 避免泛标签污染
  if (
    hasAnyTopic(topics, DEEPSEEK_HARNESS_SUPPORT_TOPICS) &&
    (matchesKeyword(name) || (desc !== undefined && matchesKeyword(desc)))
  ) {
    return true;
  }

  // 3. 关键词兜底(大小写与驼峰边界由 matchesKeyword 内部处理)
  if (matchesKeyword(name)) return true;
  if (desc !== undefined && matchesKeyword(desc)) return true;

  return false;
}

// 读 repo 的 topic 列表(兼容 GraphQL 未返回 / 老 mock 数据缺字段的情况)。
function readTopics(repo: GithubRepo): string[] {
  return (repo.repositoryTopics?.nodes ?? []).map(n => n.topic.name.toLowerCase());
}

function hasAnyTopic(topics: string[], candidates: readonly string[]): boolean {
  return candidates.some(c => topics.includes(c));
}

// 内部 helper:大小写不敏感地检查文本是否包含任一关键词。
//
// 用"后不接小写字母"边界而不是裸 includes 子串: 短缩写 `dsh` 裸子串会误伤
// Spreadsheets(2026-09-29 烟测实锤, dream-num/univer 因此进榜)。
// 该边界下 DshTool(驼峰, dsh 后跟大写 T) / awesome-dsh(结尾) / dsh-plugin 均命中。
//
// 实现注意: 不能用 'i' 标志 —— 'i' 会把 (?![a-z]) 连带变成 (?![a-zA-Z]),
// 驼峰边界判定随之失效; 所以把关键词展开成 [dD][sS][hH] 字符类, 断言保持小写敏感。
const KEYWORD_PATTERNS: readonly RegExp[] = DEEPSEEK_HARNESS_KEYWORDS.map(keyword => {
  const pattern = keyword
    .split('')
    .map(c => (/[a-z]/i.test(c) ? `[${c}${c.toUpperCase()}]` : c))
    .join('');
  return new RegExp(`${pattern}(?![a-z])`);
});

function matchesKeyword(text: string): boolean {
  return KEYWORD_PATTERNS.some(p => p.test(text));
}
