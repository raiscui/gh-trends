import { GithubRepo } from './github.gql';

// canonical agent 关键词集合(详见 docs/adr/0002-vertical-channels-rust-and-agent.md)。
// 单一真相源:任何地方要列出 agent 关键词,必须从这里 import,不允许复制粘贴。
// ponytail: 12 个关键词是当前 LLM agent 生态的最小覆盖;新 agent 生态出现时扩充即可,
// 不需要重构匹配规则。
export const AGENT_KEYWORDS: readonly string[] = [
  'agent',
  'agents',
  'agentic',
  'mcp',
  'claude-code',
  'openai-agents',
  'crewai',
  'autogen',
  'langgraph',
  'swarm',
  'copilot',
  'devin',
];

// M2 匹配规则:repo 名字(nameWithOwner) 或 description 任一命中关键词即视为 agent 项目。
// 大小写不敏感,因为 GitHub repo 命名约定是 kebab-case,但 `CrewAI` / `MCP` / `LangGraph` 等
// 实际生态命名前后不一致。
export function isAgentRepo(repo: GithubRepo): boolean {
  const name = repo.nameWithOwner.toLowerCase();
  if (matchesKeyword(name)) return true;

  const desc = repo.description;
  if (desc && matchesKeyword(desc.toLowerCase())) return true;

  return false;
}

// 内部 helper:对单个文本字符串,大小写不敏感地检查是否包含任一关键词。
function matchesKeyword(text: string): boolean {
  for (const keyword of AGENT_KEYWORDS) {
    if (text.includes(keyword)) return true;
  }
  return false;
}
