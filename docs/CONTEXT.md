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
  内含六段 markdown(主榜 + Rust 榜 + Agent 榜 + DeepSeek Harness 榜 + Vercel AI SDK 榜 + AI Video Editor 榜)。

- **Vertical channel** — 按主题切分的榜单(Rust / Agent / DeepSeek Harness),
  从同一 trending pool in-memory sub-select 抽出 top-N,在同一个 daily release 内以
  独立 section 形式呈现。共享 SCAN_LIMIT=300,只跑 1 次 scan + 1 次 enrich。
  前置条件:该主题的项目必须能在主榜池里命中,否则该榜结构性为空(见「生态榜」)。

- **生态榜 (ecosystem board)** — 2026-10-04 起(Vercel AI SDK / AI Video Editor,ADR-0003)。
  **不走主榜池**,候选池来自 GitHub topic 搜索,增速回 ClickHouse 取,排序窗口
  `ECOSYSTEM_WINDOW_DAYS=28`。适用于"成熟生态"——这类项目周增速个位数,
  在主榜池的爆发式增长门槛(7 天涨 50%+)下命中恒为 0。详见下方专节。

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
| src/clients/clickhouse.ts              | ClickHouse 双通道 SQL + buildTrendingReposQuery() + buildRepoGrowthQuery() |
| src/clients/github.gql.ts              | GitHub GraphQL enrich(stargazers + metadata + topics) |
| src/clients/github.topics.ts           | GitHub topic 搜索(生态榜候选池, ADR-0003)    |
| src/clients/github.ts                  | REST API(getReleaseByTag / createRelease)    |
| src/clients/agentKeywords.ts           | AGENT_KEYWORDS + isAgentRepo()               |
| src/clients/deepSeekKeywords.ts        | DeepSeek Harness topic+关键词匹配(三层优先级) |
| src/pipeline/scan.ts                   | 拉 trending pool + enrich                    |
| src/pipeline/filter.ts                 | fail-closed filter,50% guardrail              |
| src/pipeline/select.ts                 | fresh bucket + accel 乘数 + score sort(可传自定义窗口) |
| src/pipeline/dedupe.ts                 | 发布去重记忆(feed/published.json, 90 天)      |
| src/pipeline/rotation.ts               | 生态榜尾部轮换记忆(feed/published_ecosystem.json, 日历天) |
| src/pipeline/vertical.ts               | Rust / Agent / DeepSeek select 包装(仅池内榜) |
| src/pipeline/ecosystem.ts              | 生态榜取数编排 + 两榜配置(ADR-0003)           |
| src/pipeline/render.ts                 | handlebars 编译 + 注入 sections               |
| src/pipeline/publish.ts                | publisher fan-out                             |
| src/publishers/github.ts               | release tag + body markdown                  |
| src/publishers/rss.ts                  | feed/rss.xml 单一聚合文件                     |
| src/templates/markdown.hbs             | GitHub release body 模板(六段)               |
| docs/adr/0002-vertical-channels-rust-and-agent.md | 垂直榜 ADR(D10 Vercel 段已被 0003 取代) |
| docs/adr/0003-ecosystem-boards.md      | 生态榜 ADR(独立取数通道 + 采样率约束)         |

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

## 生态榜(Vercel AI SDK / AI Video Editor,2026-10-04,ADR-0003)

单一真相源 `src/pipeline/ecosystem.ts`(两个 `EcosystemBoardConfig`)。

### 为什么必须独立取数

主榜池只收**爆发式增长**项目(通道 A 要求 7 天增速 > 基线 50%),而成熟
基础设施生态的周增速是个位数。2026-10-04 实测(SCAN_LIMIT=300 → 池 317 个 repo):

| 匹配维度 | Vercel AI SDK 命中数 |
|----------|---------------------|
| name + description(旧关键词口径) | **0** |
| 仅 name | 0 |
| 仅 description | 0 |
| 仅 topic(`ai-sdk` / `vercel-ai-sdk`) | **0** |

topic 维度同样为 0 —— 说明不是"规则太窄",而是**池子里根本没有该生态的项目**。
换任何关键词都修不好,只能换取数通道。

叠加第二层约束:ClickHouse `github.events` 对成熟项目只有 **0.1%–0.3%** 采样
(实测 `vercel/ai` 27101 星 / 60 天仅 81 个事件;`assistant-ui` 12388 星 / 29 个)。
所以 7 天窗口对慢生态是零信号,必须放宽到 28 天。

### 数据流

```
GitHub topic 搜索(top 100/topic, 并集去重)
  → ClickHouse getRepoGrowth(names, 28d)   仅返回有 star 事件的 repo
  → 粗排: 按 starsPerHour 取 top 3×N        控制 enrich 的 GraphQL 请求数
  → github.getRepos() enrich               复用主榜同一客户端
  → filter() + rankAndSlice(repos, N, 28)  复用主榜同一质量门槛与评分
```

### 词表与成员判定

| 榜单 | topic 集合 | 收窄 | 实测 |
|------|-----------|------|------|
| Vercel AI SDK | `ai-sdk` / `vercel-ai-sdk` | `isVercelAiSdkEcosystemMember` | 搜索 191 → 判定后 127 |
| AI Video Editor | `ai-video-editor` / `video-editing` / `ai-video` | 不收窄 | 搜索 289 → 全部保留 |

**Vercel 榜分层收紧**(2026-10-04,用户拍板):`ai-sdk` 是泛用标签, 同时覆盖
"生态核心库"与"基于该 SDK 构建的任何应用"。纯 topic 判据下, JS 搜索工具
`dzhng/jevgrep`、agent 运行时 `GCWing/OpenBitFun` 会混进榜甚至居首。故:

1. 命中精确 topic `vercel-ai-sdk` → 直接入榜(作者显式声明)
2. 仅命中泛用 topic `ai-sdk` → 需 `nameWithOwner` / `description` 含 `vercel` 佐证

收窄后噪音全部消失,榜首变为 `assistant-ui/assistant-ui`(12405⭐),
`vercel-labs/*` 官方项目入列。代价是 `mnfst/llm-gateway`、`TanStack/ai`、
`microsoft/foundry-local` 等有分量但 name/desc 不含 vercel 的项目被排除 ——
这是"生态归属必须有品牌证据"的既定取舍。

视频榜不设收窄:三个 topic 都带明确视频语义, 泛化程度远低于 `ai-sdk`,
实测头部(autoclip / OpenChatCut / palmier-pro / LocalMiniDrama)无一噪音。

### 设计约束

1. **不套用 90 天发布去重,也不写入 `feed/published.json`**。Vercel 收窄后有
   增速的仅约 21 个,若写入记忆会被主榜池的 `dedupe` 挡在门外,该段将长期空榜。
   - 2026-10-17 修订:视频榜头部仍稳态常驻、不进主记忆,但**尾部 15 条**改用
     独立的短周期轮换记忆 `feed/published_ecosystem.json`(保留期
     `ECOSYSTEM_ROTATION_DAYS=2` 天)。原约束"不进主记忆"依然成立,只是给它加了
     一条自己的记忆。见 ADR-0003 修订节;Vercel 榜池子太小(约 25 个)不轮换。
2. **不参与 `run.ts` 的 50% filter guardrail**(小池方差大),但仍走 `filter()`
   保留 `FILTER_MIN_STARS` 等质量底线。
3. **fail-soft**:取数失败只留空并 WARN,不中断整次发布。
4. **条数允许自然浮动**:池中不足 top-N 时按实际条数出榜,不拿零增长项凑数。
5. **Vercel 榜 top-N 取 20 而非 30**:收窄后有增速的 21 个里约 7 个 28 天零增长,
   给 30 会让榜单尾部长期由零增长条目填充。

### 已知折衷

视频榜的 `video-editing` / `ai-video` 话题较宽,榜内会混入少量
awesome-list 与 prompt 库(如 `awesome-seedance`、`awesome-ai-motion`)。
因其本身是 AI 视频生态的周边资产, 与"工具"同属该生态关注范围, 暂不收紧。

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
| RELEASE_TOP_N_VERCEL_AI_SDK  | 20     | Vercel AI SDK 生态榜 top-N(2026-10-04 迁生态榜并收紧) |
| RELEASE_TOP_N_AI_VIDEO_EDITOR | 30    | AI Video Editor 生态榜 top-N(2026-10-04 新增)   |
| ECOSYSTEM_WINDOW_DAYS        | 28     | 生态榜增速窗口(2026-10-04, ADR-0003)          |
| ECOSYSTEM_ROTATION_DAYS      | 2      | 生态榜尾部轮换保留期(日历天,2026-10-17;0=关闭) |
