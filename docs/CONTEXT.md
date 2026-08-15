# CONTEXT.md — gh-trends 领域术语

> canonical glossary。任何仓库内的 PRD、设计文档、ADR、代码注释引用本文件里的术语时,
> 必须保持本文件定义为准,不另立同义词。

## 项目角色

- **Trending pool** — 从 ClickHouse `github.events` 取回的 7 天内 star 增长最快的 repo 列表。
  默认排序:`starsWithin DESC`,上限 `SCAN_LIMIT=300`(2026-08-12 由 150 扩到 300,以容纳 Rust/agent 候选)。
  SQL 在 `src/clients/clickhouse.ts::trendingReposQuery()`。

- **Daily release** — 每天一次的发布动作,生成一个 GitHub release tag `daily-YYYY-MM-DD`,
  内含三段 markdown(主榜 + Rust 榜 + Agent 榜)。

- **Vertical channel** — 按主题切分的榜单(Rust / Agent),从同一 trending pool
  in-memory sub-select 抽出 top-N,在同一个 daily release 内以独立 section 形式呈现。
  共享 SCAN_LIMIT=300,只跑 1 次 scan + 1 次 enrich。

## 关键概念

- **Fresh-firstSeen bucket** — `select.ts` 引入的概念:
  `firstSeenAt` 距当前 ≤ `SELECT_FRESH_HOURS`(默认 24h) 的 repo 进入 fresh bucket,
  fresh bucket 永远排在 legacy bucket 之前;
  bucket 内按 `starsPerHour × medianStargazersAge` 排序。
  设计目的:daily release 内容每天不一样,避免每周重复同一批"老牌 trending"。

- **Guardrail (50% filter 阈值)** — `run.ts` 中的 fail-closed 保护:
  如果 filter 把 trending pool 砍掉超过 5 个且剩余 < 50%,主动抛错。
  目的:防止 CJK / fresh-owner / < 100 stars 的低质量 repo 被发布。
  历史:2026-08-07 修复过(zero-baseline SQL)。

- **Single-source-of-truth tag** — `daily-YYYY-MM-DD` 命名规则:
  每天一个 tag,`Publish Github release` workflow 检查 tag 是否已存在,
  存在则 skip(避免 daily schedule 抖动造成重复 release)。
  历史:2026-08-07 由 weekly issue number 切换。

## 关键词集合(agent)

`AGENT_KEYWORDS` 是 canonical list,定义在 `src/clients/agentKeywords.ts`:

| 关键词        | 对应生态                              |
|------------|--------------------------------------|
| agent      | 通用 LLM agent / "agent" 在 name 里的项目 |
| agents     | 同上,复数形式                          |
| agentic    | agentic workflow / agentic AI 概念      |
| mcp        | Model Context Protocol 生态            |
| claude-code| Anthropic Claude Code 生态              |
| openai-agents | OpenAI Agents SDK 生态               |
| crewai     | CrewAI 框架                          |
| autogen    | Microsoft AutoGen 框架                 |
| langgraph  | LangChain LangGraph                   |
| swarm      | OpenAI Swarm / 其他 swarm agent       |
| copilot    | GitHub Copilot 生态                    |
| devin      | Cognition Devin 生态                  |

匹配规则(M2):
- `nameWithOwner` 大小写不敏感命中任一关键词 → 命中
- 或 `description` 大小写不敏感命中任一关键词 → 命中

## 配置(env vars)

| 变量                    | 默认值  | 含义                                          |
|------------------------|--------|----------------------------------------------|
| SCAN_LIMIT             | 300    | trending pool 上限(主榜 + Rust + Agent 共享)     |
| SCAN_WINDOW_DAYS       | 7      | trending 时间窗                                |
| SCAN_MIN_GROWTH_RATE   | 0.5    | trending 增长倍数下限;0.5 是经验值,数据稀疏时降低 |
| FILTER_MIN_STARS       | 200    | repo 总 star 下限;跟 SCAN_MIN_GROWTH_RATE=0.5 配套,保证质量 |
| SELECT_FRESH_HOURS     | 24     | fresh-firstSeen bucket 时长                      |
| RELEASE_TOP_N          | 20     | 主榜 top-N                                    |
| RELEASE_TOP_N_RUST     | 15     | Rust 榜 top-N(待加)                            |
| RELEASE_TOP_N_AGENT    | 15     | Agent 榜 top-N(待加)                            |

(2026-08-12 之前 SCAN_LIMIT=150;Rust/agent 候选只有 2-3 个,扩到 300 后大概率能凑满 15)

## 文件 / 模块边界

| 文件 / 模块                              | 职责                                         |
|----------------------------------------|---------------------------------------------|
| src/clients/clickhouse.ts              | ClickHouse SQL + trendingReposQuery()        |
| src/clients/github.gql.ts              | GitHub GraphQL enrich(stargazers + metadata) |
| src/clients/github.ts                  | REST API(getReleaseByTag / createRelease)    |
| src/clients/agentKeywords.ts           | (待加) AGENT_KEYWORDS + isAgentRepo()        |
| src/pipeline/scan.ts                   | 拉 trending pool + enrich                    |
| src/pipeline/filter.ts                 | fail-closed filter,50% guardrail              |
| src/pipeline/select.ts                 | fresh bucket + score sort                    |
| src/pipeline/vertical.ts               | (待加) Rust / Agent select 包装               |
| src/pipeline/render.ts                 | handlebars 编译 + 注入 sections               |
| src/pipeline/publish.ts                | publisher fan-out                             |
| src/publishers/github.ts               | release tag + body markdown                  |
| src/publishers/rss.ts                  | feed/rss.xml 单一聚合文件                     |
| src/templates/markdown.hbs             | GitHub release body 模板(三段)               |
| docs/adr/0002-vertical-channels-rust-and-agent.md | 本次新增 ADR                             |
