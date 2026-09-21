import { GithubRepo } from './github.gql';

// canonical DeepSeek Harness 关键词集合(详见 docs/adr/0002-vertical-channels-rust-and-agent.md
// + 后续扩展记录)。
// 单一真相源:任何地方要列出 DeepSeek Harness 关键词,必须从这里 import,不允许复制粘贴。
//
// ponytail: 用户指定的 3 个关键词 —— `cordis` / `dsh` / `dsh-plugin`,
// 这是 DeepSeek Harness 生态内部的项目命名约定(cordis 是数据/记忆层,
// dsh 是 CLI / daemon 缩写,dsh-plugin 是插件)。不扩到 DeepSeek 模型 / DeepSeek OCR
// 等官方 deepseek-ai 仓库 —— DeepSeek Harness 是第三方项目/工具,跟 DeepSeek 官方生态
// 语义不同,扩展会带来 noise。
export const DEEPSEEK_HARNESS_KEYWORDS: readonly string[] = ['cordis', 'dsh', 'dsh-plugin'];

// 匹配规则跟 agentKeywords 一致 (M2):repo 名字(nameWithOwner) 或 description
// 任一命中关键词即视为 DeepSeek Harness 相关项目。大小写不敏感。
//
// 注意:`dsh` 是短缩写,容易撞其他项目;`cordis` 也是拉丁语 + 欧盟 CORDIS 项目库。
// 当前 fail-closed 默认下,误伤风险被 filter(MIN_STARS=40)兜底(2026-09-21 由 200 下调,兜底变薄)。
export function isDeepSeekHarnessRepo(repo: GithubRepo): boolean {
  const name = repo.nameWithOwner.toLowerCase();
  if (matchesKeyword(name)) return true;

  const desc = repo.description;
  if (desc && matchesKeyword(desc.toLowerCase())) return true;

  return false;
}

// 内部 helper:对单个文本字符串,大小写不敏感地检查是否包含任一关键词。
function matchesKeyword(text: string): boolean {
  for (const keyword of DEEPSEEK_HARNESS_KEYWORDS) {
    if (text.includes(keyword)) return true;
  }
  return false;
}
