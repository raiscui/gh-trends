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
  内含五段 markdown(主榜 + Rust 榜 + Agent 榜 + DeepSeek Harness 榜 + Vercel AI SDK 榜)。

- **Vertical channel** — 按主题切分的榜单(Rust / Agent / DeepSeek Harness / Vercel AI SDK),
  从同一 trending pool in-memory sub-select 抽出 top-N,在同一个 daily release 内以
  独立 section 形式呈现。共享 SCAN_LIMIT=300,只跑 1 次 scan + 1 次 enrich。

## 关键概念

- **Fresh-firstSeen bucket** — `select.ts` 引入的概念:
  `firstSeenAt` 距当前 ≤ `SELECT_FRESH_HOURS`(默认 24h) 的 repo 进入 fresh bucket,
  fresh bucket 永远排在 legacy bucket 之前;
  bucket 内按 `starsPerHour × medianStargazersAge × accel 乘数` 排序
  (accel = 窗口劈半 recent/earlier 平滑比值,权重 `SELECT_ACCEL_WEIGHT`,2026-09-21 加入)。
  设计目的:daily release 内容每天不一样,避免每周重复同一批"老牌 trending"。

- **Guardrail (50% filter 阈值)** — `run.ts` 中的 fail-closed 保护:
  如果 filter 把 trending pool 砍掉超过 5 个且剩余 < 50%,主动抛错。
  目的:防止 fresh-owner / 低于 star 门槛的低质量 repo 被发布(门槛见配置表 FILTER_MIN_STARS)。
  历史:2026-08-07 修复过(zero-baseline SQL);2026-09-29 移除上游 CJK 描述规则
  (它把"desc 含汉字"等同于低质量,但本项目关注的 AI 生态主力在中文圈,
  实测剔除 23/300 个 trending 项目并导致 DeepSeek 榜结构性空榜,经用户拍板删除)。

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
| src/clients/github.gql.ts              | GitHub GraphQL enrich(stargazers + metadata + topics) |
| src/clients/github.ts                  | REST API(getReleaseByTag / createRelease)    |
| src/clients/agentKeywords.ts           | AGENT_KEYWORDS + isAgentRepo()               |
| src/clients/deepSeekKeywords.ts        | DeepSeek Harness topic+关键词匹配(三层优先级) |
| src/clients/vercelAiSdkKeywords.ts     | VERCEL_AI_SDK_KEYWORDS + isVercelAiSdkRepo() |
| src/pipeline/scan.ts                   | 拉 trending pool + enrich                    |
| src/pipeline/filter.ts                 | fail-closed filter,50% guardrail              |
| src/pipeline/select.ts                 | fresh bucket + accel 乘数 + score sort        |
| src/pipeline/dedupe.ts                 | 发布去重记忆(feed/published.json, 90 天)      |
| src/pipeline/vertical.ts               | Rust / Agent / DeepSeek / Vercel select 包装  |
| src/pipeline/render.ts                 | handlebars 编译 + 注入 sections               |
| src/pipeline/publish.ts                | publisher fan-out                             |
| src/publishers/github.ts               | release tag + body markdown                  |
| src/publishers/rss.ts                  | feed/rss.xml 单一聚合文件                     |
| src/templates/markdown.hbs             | GitHub release body 模板(五段)               |
| docs/adr/0002-vertical-channels-rust-and-agent.md | 本次新增 ADR                             |

## 匹配机制(DeepSeek Harness, 2026-09-29 重构)

单一真相源在 `src/clients/deepSeekKeywords.ts`(ADR-0002 D11)。三层优先级:

1. **强信号 topic**(`DEEPSEEK_HARNESS_TOPICS`): `dsh` / `deepseek-harness`,
   命中任一即入榜 —— 官方仓库 deepseek-ai/deepseek-harness 同带这两个标签
2. **弱信号 topic**(`DEEPSEEK_HARNESS_SUPPORT_TOPICS`): `dsh-plugin`,
   单独出现不入榜(实测 PicGo / Tencent-WeKnora 等通用项目蹭挂此标签),
   需叠加 name/desc 关键词佐证
3. **关键词兜底**(`DEEPSEEK_HARNESS_KEYWORDS`): `cordis` / `dsh` / `dsh-plugin`,
   覆盖未打 topic 的项目。匹配带"后不接小写字母"边界 —— 裸子串会误伤
   Spreadsheets(2026-09-29 实锤), 边界下 DshTool 驼峰 / awesome-dsh 结尾均正常命中

历史:2026-08-17~2026-09-28 为纯关键词口径;2026-09-29 起改 topic 优先,
原因:纯关键词在中文圈生态下与 CJK filter 冲突导致结构性空榜
(daily-2026-09-28 实测 DeepSeek 榜 0 条)。同日 CJK filter 规则整体移除(用户拍板)。

## 关键词集合(Vercel AI SDK)

`VERCEL_AI_SDK_KEYWORDS` 是 canonical list,定义在 `src/clients/vercelAiSdkKeywords.ts`(ADR-0002 D10):

| 关键词        | 对应生态信号                                       |
|---------------|---------------------------------------------------|
| vercel ai sdk | 品牌完整短语,desc 生态描述主信号                     |
| vercel/ai     | 官方 repo 及衍生(vercel/ai、vercel/ai-chatbot)     |
| ai-sdk        | npm 生态命名约定(@ai-sdk/*、ai-sdk-provider-*)     |

匹配规则(同 M2):
- `nameWithOwner` 大小写不敏感命中任一关键词 → 命中
- 或 `description` 大小写不敏感命中任一关键词 → 命中

注意:`ai-sdk` 不命中空格形式 "openai sdk"(连字符 vs 空格是天然误伤防线);
特异性高于 DeepSeek 榜的 `dsh`/`cordis`,暂无需收紧预案。

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
| RELEASE_TOP_N_VERCEL_AI_SDK  | 30     | Vercel AI SDK 榜 top-N(2026-09-29 新增, D10)  |
