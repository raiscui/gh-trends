# CONTEXT.md — gh-trends 领域术语

> canonical glossary。任何仓库内的 PRD、设计文档、ADR、代码注释引用本文件里的术语时,
> 必须保持本文件定义为准,不另立同义词。

## 项目角色

- **Trending pool** — 从 ClickHouse `github.events` 取回的 7 天内 star 增长最快的 repo 列表。
  默认排序:`starsWithin DESC`,上限 `SCAN_LIMIT=300`(2026-08-12 由 150 扩到 300,以容纳 Rust/agent 候选)。
  SQL 在 `src/clients/clickhouse.ts::buildTrendingReposQuery()`。
  2026-09-21 起为双通道(specs/0001 D1):通道 A = 有 base 的加速
  (`starsWithin/starsBefore > SCAN_MIN_GROWTH_RATE`);通道 B = 从零爆火
  (`starsBefore = 0` 且 `starsWithin >= SCAN_CHANNEL_B_MIN_STARS`,上限
  `SCAN_CHANNEL_B_LIMIT`);`SCAN_HISTORY_DAYS` 为 starsBefore 判定时间轴。

- **Daily release** — 每天一次的发布动作,生成一个 GitHub release tag `daily-YYYY-MM-DD`,
  内含三段 markdown(主榜 + Rust 榜 + Agent 榜)。

- **Vertical channel** — 按主题切分的榜单(Rust / Agent),从同一 trending pool
  in-memory sub-select 抽出 top-N,在同一个 daily release 内以独立 section 形式呈现。
  共享 SCAN_LIMIT=300,只跑 1 次 scan + 1 次 enrich。

## 关键概念

- **Fresh-firstSeen bucket** — `select.ts` 引入的概念:
  `firstSeenAt` 距当前 ≤ `SELECT_FRESH_HOURS`(默认 24h) 的 repo 进入 fresh bucket,
  fresh bucket 永远排在 legacy bucket 之前;
  bucket 内按 `starsPerHour × medianStargazersAge × accel 乘数` 排序
  (accel = 窗口劈半 recent/earlier 平滑比值,权重 `SELECT_ACCEL_WEIGHT`,2026-09-21 加入)。
  设计目的:daily release 内容每天不一样,避免每周重复同一批"老牌 trending"。

- **Guardrail (50% filter 阈值)** — `run.ts` 中的 fail-closed 保护:
  如果 filter 把 trending pool 砍掉超过 5 个且剩余 < 50%,主动抛错。
  目的:防止 CJK / fresh-owner / 低于 star 门槛的低质量 repo 被发布(门槛见配置表 FILTER_MIN_STARS)。
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

唯一配置清单见下方「配置文件清单」(2026-09-21 版)。
历史:2026-08-12 之前 SCAN_LIMIT=150、FILTER_MIN_STARS=200、垂直榜各 15;
2026-09-21 起 FILTER_MIN_STARS=40(小众垂直低 star 项目也保留)、垂直榜各 30。

## 文件 / 模块边界

| 文件 / 模块                              | 职责                                         |
|----------------------------------------|---------------------------------------------|
| src/clients/clickhouse.ts              | ClickHouse 双通道 SQL + buildTrendingReposQuery() |
| src/clients/github.gql.ts              | GitHub GraphQL enrich(stargazers + metadata) |
| src/clients/github.ts                  | REST API(getReleaseByTag / createRelease)    |
| src/clients/agentKeywords.ts           | (待加) AGENT_KEYWORDS + isAgentRepo()        |
| src/pipeline/scan.ts                   | 拉 trending pool + enrich                    |
| src/pipeline/filter.ts                 | fail-closed filter,50% guardrail              |
| src/pipeline/select.ts                 | fresh bucket + accel 乘数 + score sort        |
| src/pipeline/dedupe.ts                 | 发布去重记忆(feed/published.json, 90 天)      |
| src/pipeline/vertical.ts               | (待加) Rust / Agent select 包装               |
| src/pipeline/render.ts                 | handlebars 编译 + 注入 sections               |
| src/pipeline/publish.ts                | publisher fan-out                             |
| src/publishers/github.ts               | release tag + body markdown                  |
| src/publishers/rss.ts                  | feed/rss.xml 单一聚合文件                     |
| src/templates/markdown.hbs             | GitHub release body 模板(三段)               |
| docs/adr/0002-vertical-channels-rust-and-agent.md | 本次新增 ADR                             |

## 关键词集合(DeepSeek Harness)

`DEEPSEEK_HARNESS_KEYWORDS` 是 canonical list,定义在 `src/clients/deepSeekKeywords.ts`:

| 关键词      | 对应项目 / 用途                  |
|----------|----------------------------------|
| cordis   | 数据 / 记忆层                       |
| dsh      | CLI / daemon 缩写                 |
| dsh-plugin | 插件                              |

匹配规则(同 M2):
- `nameWithOwner` 大小写不敏感命中任一关键词 → 命中
- 或 `description` 大小写不敏感命中任一关键词 → 命中

注意:`dsh` 是短缩写(可能误伤),`cordis` 是拉丁语 + 欧盟 CORDIS 项目库。
当前 fail-closed 默认下,误伤被 `FILTER_MIN_STARS=40` 兜底(2026-09-21 由 200 下调,兜底变薄,若误伤多可收紧关键词只保留 `dsh-plugin`)。
后续如果误伤多,可收紧关键词(只保留 `dsh-plugin`)。

## 配置文件清单(env vars, 2026-09-21, 唯一真相源)

| 变量                          | 默认值 | 含义                                          |
|------------------------------|--------|----------------------------------------------|
| SCAN_LIMIT                   | 300    | 通道 A 配额(有 base 加速)                     |
| SCAN_WINDOW_DAYS             | 7      | trending 时间窗                                |
| SCAN_MIN_GROWTH_RATE         | 0.5    | 通道 A 相对增速下限(数据稀疏期降到 0.5)          |
| SCAN_HISTORY_DAYS            | 60     | starsBefore 判定时间轴(specs/0001 D1)          |
| SCAN_CHANNEL_B_MIN_STARS     | 40     | 通道 B 从零爆火绝对门槛                        |
| SCAN_CHANNEL_B_LIMIT         | 100    | 通道 B 配额                                   |
| FILTER_MIN_STARS             | 40     | repo 总 star 下限(2026-09-21 由 200 下调)       |
| SELECT_FRESH_HOURS           | 24     | fresh-firstSeen bucket 时长                    |
| SELECT_ACCEL_WEIGHT          | 0.5    | 加速度乘数权重, 0 = 关闭                       |
| PUBLISHED_MEMORY_ENABLED     | true   | 发布去重记忆(feed/published.json, 90 天)       |
| RELEASE_TOP_N                | 20     | 主榜 top-N                                    |
| RELEASE_TOP_N_RUST           | 30     | Rust 榜 top-N(2026-09-21 由 15 扩)             |
| RELEASE_TOP_N_AGENT          | 30     | Agent 榜 top-N(2026-09-21 由 15 扩)            |
| RELEASE_TOP_N_DEEPSEEK       | 30     | DeepSeek Harness 榜 top-N(2026-09-21 由 15 扩) |
