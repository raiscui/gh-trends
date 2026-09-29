import { GithubRepo } from './github.gql';

// ============================================================
//  Vercel AI SDK 垂直榜单关键词(单一真相源)
// ------------------------------------------------------------
//  任何地方要列出 Vercel AI SDK 关键词,必须从这里 import,
//  不允许复制粘贴。扩展记录见 docs/adr/0002 的 D10 段。
// ============================================================

// canonical Vercel AI SDK 关键词集合(ADR-0002 D8 同款垂直频道模式)。
//
// ponytail: 3 个关键词覆盖 Vercel AI SDK 生态的三类信号:
//   - `vercel ai sdk`  品牌完整短语,desc 生态描述的主信号
//     (如 "Vercel AI SDK provider for Ollama")
//   - `vercel/ai`      官方 repo 及其衍生(vercel/ai、vercel/ai-chatbot),
//     这些是生态核心项目本身
//   - `ai-sdk`         npm 生态命名约定(@ai-sdk/*、ai-sdk-provider-*、*-ai-sdk)
//
// 误伤权衡:`ai-sdk` 不命中空格形式 "openai sdk",只命中显式连字符命名;
// 连字符 openai-sdk 类项目极少且本属邻近 AI SDK 生态,噪音由 FILTER_MIN_STARS=40 兜底。
// 特异性显著高于 DeepSeek 榜的 dsh/cordis(短缩写 + 拉丁词),无需更保守的集合。
export const VERCEL_AI_SDK_KEYWORDS: readonly string[] = ['vercel ai sdk', 'vercel/ai', 'ai-sdk'];

// 匹配规则跟 agentKeywords / deepSeekKeywords 一致 (M2):
// repo 名字(nameWithOwner) 或 description 任一命中关键词即视为
// Vercel AI SDK 相关项目。大小写不敏感。
export function isVercelAiSdkRepo(repo: GithubRepo): boolean {
  const name = repo.nameWithOwner.toLowerCase();
  if (matchesKeyword(name)) return true;

  const desc = repo.description;
  if (desc && matchesKeyword(desc.toLowerCase())) return true;

  return false;
}

// 内部 helper:对单个文本字符串,大小写不敏感地检查是否包含任一关键词。
function matchesKeyword(text: string): boolean {
  for (const keyword of VERCEL_AI_SDK_KEYWORDS) {
    if (text.includes(keyword)) return true;
  }
  return false;
}
