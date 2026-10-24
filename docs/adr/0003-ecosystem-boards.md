# ADR-0003: 生态榜独立取数通道

> 2026-10-25 修订: 当前六榜共享 `feed/published.json`, 按 UTC 日历日排除今天和昨天已发布的项目.
> 取代下文历史记录中的 90 天去重, 生态榜豁免及头部常驻/尾部回填规则.
> 预览也执行去重, 候选不足保留短榜或空榜. 不再读取 `published_ecosystem.json`.
> GitHub release 成功后记录六榜并集, 仅邮件/RSS 发布时记录主榜, 跳过发布不记录新候选.
> 已从 daily-2026-10-24 的真实 release 补齐 66 个独立项目到本地记忆, 覆盖首次切换; 原历史记录保留.


- 状态:Accepted
- 日期:2026-10-04
- 取代:ADR-0002 的 D10 段(Vercel AI SDK 作为主榜池 sub-select 的做法)

## 背景

2026-10-04 收到反馈:"Vercel AI SDK 趋势没什么东西",同时要求新增 AI Video Editor 榜。

Vercel AI SDK 榜当时在真实发布中稳定输出 0 条。本 ADR 记录排查证据、
根因判定,以及由此引入的第二条取数通道。

## 排查过程

### 现象

Vercel AI SDK 段在 daily release 中恒为空。

### 假设与验证

初始假设是"关键词规则太窄"——`VERCEL_AI_SDK_KEYWORDS` 只匹配
name + description,而 DeepSeek 榜在 ADR-0002 D11 已证明 topic 更可靠,
`github.gql.ts` 也确实抓了 `repositoryTopics`。**该假设被数据推翻。**

在真实数据(SCAN_LIMIT=300 → ClickHouse 池 317 个 repo)上跑诊断:

| 匹配维度 | 命中数 |
|----------|--------|
| 当前 `isVercelAiSdkRepo`(name + description) | **0** |
| 仅 name | 0 |
| 仅 description | 0 |
| 仅 topic(`ai-sdk` / `vercel-ai-sdk`) | **0** |

topic 维度同样为 0。**池子里连一个带该生态 topic 的 repo 都没有**,
所以问题不在匹配规则,而在池子本身。

### 根因(已验证)

两层约束叠加:

**第一层 —— 主榜池只收爆发式增长项目。** 通道 A 要求
`starsWithin / starsBefore > 0.5`(7 天增速超基线 50%),通道 B 要求
`starsBefore = 0`(从零爆火)。实测 Vercel AI SDK 生态头部项目的窗口增速:

| repo | starsBefore | starsWithin(7d) | 比值 | 通道 A (>0.5) |
|------|------------|-----------------|------|---------------|
| vercel/ai | 75 | 6 | 0.08 | fail |
| assistant-ui/assistant-ui | 25 | 4 | 0.16 | fail |
| mnfst/llm-gateway | 6 | 2 | 0.33 | fail |
| TanStack/ai | 11 | 1 | 0.09 | fail |

Vercel AI SDK 是成熟的基础设施生态,周增速个位数,结构性够不到门槛。

**第二层 —— ClickHouse 对成熟项目采样极稀疏。** `github.events` 是采样表,
实测 60 天事件数与真实 star 的比例:

| repo | 真实 star | 60d 事件数 | 采样率 |
|------|-----------|-----------|--------|
| hypit-ai/hypit(高增长新项目) | 19011 | 1273 | 6.7% |
| vercel/ai | 27101 | 81 | 0.30% |
| assistant-ui/assistant-ui | 12388 | 29 | 0.23% |
| miurla/morphic | 9151 | 9 | 0.10% |
| Zulko/moviepy | 14945 | 12 | 0.08% |

即成熟项目的采样率约 0.1%–0.3%。**即使换成独立 topic 取数,7 天窗口对
慢生态仍是零信号**(实测 191 个候选里 38 个有事件,其中 29 个 7 天增量为 0)。

### 最强备选解释及排除

备选解释:"池子太小,调大 SCAN_LIMIT 就能捞到生态项目"。
排除依据:通道 A/B 的门槛是**比值/绝对值条件**,与池子大小无关;
把 SCAN_LIMIT 调到 3000 只会拉进更多同样高增速的非生态项目,
Vercel 生态的命中数仍为 0。实测 7 天窗口下 topic 命中 0 已直接证伪。

## 决策

引入**生态榜 (ecosystem board)** 第二条取数通道,绕开主榜池。

```
GitHub topic 搜索(top 100/topic, 并集去重)
  → ClickHouse getRepoGrowth(names, 28d)   仅返回有 star 事件的 repo
  → 粗排: 按 starsPerHour 取 top 3×N        控制 enrich 的 GraphQL 请求数
  → github.getRepos() enrich               复用主榜同一客户端
  → filter() + rankAndSlice(repos, N, 28)  复用主榜同一质量门槛与评分
```

### 关键选择

1. **成员判定用 topic,不用关键词。** topic 是作者显式声明的生态归属,
   比 name/description 的文本匹配可靠(ADR-0002 D11 已在 DeepSeek 榜验证过
   同一结论)。因此 `vercelAiSdkKeywords.ts` 及其测试被删除,不保留兼容层。

2. **窗口放宽到 28 天**(`ECOSYSTEM_WINDOW_DAYS`)。受第二层采样约束,
   7 天对慢生态无信号。实测 28 天下 Vercel 榜零增长项从 29 降到 8。

3. **`rankAndSlice` 增加可选第三参 `windowDays`**,使 `maxHours` 与
   `starsWithin` 的时间跨度同源。若两者不同源,会拿 28 天的 star 数除以
   90 天的账龄,增速被静默低估 4 倍。现有四个池内榜调用方零改动。

4. **两阶段 enrich(粗排取 3×N)。** 全池 enrich 需 48 次 GraphQL,
   叠加主榜 32 次逼近 GitHub 5000 points/hr 上限,CI 有 rate limit 风险。
   粗排后只需 18 次。

5. **不套用 90 天发布去重,生态榜条目不写入 `feed/published.json`。**
   Vercel 池有增速的仅约 38 个;若写入记忆,会被主榜池的 `dedupe` 挡在门外,
   导致该段长期空榜。`recordPublished` 并集相应收敛为池内四榜。

6. **不参与 50% filter guardrail,但仍走 `filter()`。** 小池方差大不适合
   fail-closed 阈值;质量底线(FILTER_MIN_STARS 等)保持一致。

7. **fail-soft。** 取数失败只留空并 WARN,不中断整次发布。
8. **Vercel 榜加成员收窄(`refine` 谓词),top-N 收到 20。**
   `ai-sdk` 是泛用标签,同时覆盖"生态核心库"与"基于该 SDK 构建的任何应用",
   纯 topic 判据下 `dzhng/jevgrep`(JS 搜索工具)会居首。分层规则:

   | 层 | 条件 | 结果 |
   |----|------|------|
   | 1 | 精确 topic `vercel-ai-sdk` | 直接入榜 |
   | 2 | 仅泛用 topic `ai-sdk` | 需 name/description 含 `vercel` 佐证 |

   实测候选 191 → 127,噪音项目全部消失,榜首变为 `assistant-ui/assistant-ui`。
   代价是 `mnfst/llm-gateway` / `TanStack/ai` / `microsoft/foundry-local`
   等有分量但不含 vercel 字样的项目被排除 —— 这是"生态归属需有品牌证据"
   的既定取舍(用户 2026-10-04 拍板)。

   top-N 从 30 收到 20:收窄后有增速数据的仅 21 个,其中约 7 个 28 天零增长,
   给 30 会让榜单尾部长期由零增长条目填充。

   `refine` 插在 topic 搜索之后、ClickHouse 增速查询之前 —— 噪音候选连
   增速查询都省掉。视频榜不设 `refine`(三个 topic 语义都明确)。

## 影响

- `src/clients/github.topics.ts`(新)、`src/pipeline/ecosystem.ts`(新)
- `src/clients/clickhouse.ts` 新增 `getRepoGrowth` / `buildRepoGrowthQuery`
- `src/pipeline/select.ts` `rankAndSlice` 增加 `windowDays` 参数
- `src/pipeline/vertical.ts` 移除 `selectVercelAiSdk`(不再是池内榜)
- `src/clients/vercelAiSdkKeywords.ts` 删除
- `ReleaseSections` 增至六段;`markdown.hbs` 增第 6 段
- `.env.example` 新增 `ECOSYSTEM_WINDOW_DAYS` / `RELEASE_TOP_N_AI_VIDEO_EDITOR`

## 验证结果(2026-10-04 真实数据)

```
[INFO] ecosystem: Vercel AI SDK: 191 候选 -> 38 有增速 -> 粗排保留 38
[INFO] ecosystem: Vercel AI SDK: 30 selected (window 28d)
[INFO] ecosystem: AI Video Editor: 288 候选 -> 168 有增速 -> 粗排保留 90
[INFO] ecosystem: AI Video Editor: 30 selected (window 28d)
```

Vercel AI SDK 榜由 **0 条变为 30 条**(此前结构性空榜)。
AI Video Editor 榜头部:`hypit-ai/hypit`、`edenfunf/reelmimic`、
`zhouxiaoka/autoclip`、`0xsline/OpenChatCut` 等真实在动的 AI 视频编辑项目。

## 遗留

- 视频榜的 `video-editing` / `ai-video` 话题偏宽,榜内混有少量 awesome-list
  与 prompt 库。因其属该生态的周边资产, 暂不收紧。
- ~~记忆里遗留的"markdown.hbs 模板硬编码 15 vs env top-N"未决项, 本次未动。~~
  已于 2026-10-17 修订关闭(见下节修订 1)。

## 修订:视频榜尾部轮换(2026-10-17)

### 现象

生态榜上线后连续 10 期(10-06 ~ 10-16)内容高度雷同:`hypit-ai/hypit`、
`edenfunf/reelmimic`、`storytold/filmcraft`、`zhouxiaoka/autoclip`、
`Vincentwei1021/video-shotcraft`、`LearnPrompt/awesome-seedance`、
`lemomo-ai/lemo-opuscar`、`yihui-dev/awesome-opus5-5-videos` 这 8 个项目**期期满勤**,
10 期合计只出现 26 个独立项目,相邻两期重合 10~13 条。

### 根因

28 天窗口 + 稳态增速排序下,成熟生态头部项目的位次本来就不会天天变 —— 这是排序
口径的必然结果,不是数据错误。原决策 2 为保护小池子而让生态榜完全不去重,代价就是
该段永远不变。

### 修订决策

1. **模板渲染边界 15 → 30**,与 `RELEASE_TOP_N_AI_VIDEO_EDITOR=30` 对齐。此前
   pipeline 每期算出 30 条但只渲染 15 条,一半结果被丢弃(遗留项 2 就此关闭)。
2. **头部稳态 + 尾部轮换**:前 15 条(对应 Tier 1)不轮换,后 15 条按独立记忆轮换。
   成熟生态的头部项目常驻本来就是榜单价值所在,不该为了"看起来不一样"而牺牲。
3. **记忆文件独立**:`feed/published_ecosystem.json`,不进 `feed/published.json`。
   原决策 2 的核心结论(生态榜进主记忆会被 `dedupe` 挡成永久空榜)依然成立,本次
   只是给它加了一条**自己的**短周期记忆。
4. **保留期 2 天**,而非主榜的 90 天。实测(2026-10-16 CI 日志)池子规模:粗排保留
   90 → 过 `filter` 剔 5 个低星 → **85 个**。按尾部 15 条/天测算:

   | retentionDays | 7 天独立项目 | 尾部日均重合 | 回退次数 |
   |---|---|---|---|
   | 1 | 45 | 15/15(退化成两天一循环) | 0 |
   | **2** | **60** | **0/15** | **0** |
   | 3 | 75 | 0/15 | 0(但余量仅 1.5 倍) |

   `retentionDays=1` 反而更差 —— 池子够大时它会锁死在两组之间来回跳。故取 2。
5. **只在 release 路径轮换**。每天两次运行(RSS 00:27 / release 09:33)都会跑完整
   pipeline,若两次都轮换则额度被消耗两遍,且用户看的 release 拿到的是当天"第二轮"
   结果。故以 `GITHUB_RELEASES_ENABLED` 为门控,RSS 路径稳态排序、不回写。
6. **排序深度与出榜条数分离**:`rankAndSlice` 改为先排完整个粗排池(深度 ≤ 120,不
   增加 API 请求),再由 `rotateTail` 截到 top-N。若沿用"排完即截 topN",轮换将无
   替补可用,剔掉几条只能回退原排序,轮换静默失效。
7. **轮换记忆随仓库持久化**:`publish-gh-release.yml` 的 `git add` 需包含该文件,
   否则 CI 每次全新 checkout,记忆丢失 → 轮换静默失效。
8. **保留期按日历天判定**,而非 `dedupe.ts` 的精确时间差:记忆存的是 `YYYY-MM-DD`,
   用时间差时"昨天 00:00 到 今天 09:33"= 1.4 天,`retentionDays=1` 会误判为已过期,
   保留期语义随运行时刻漂移。

### 影响

- 新增 `src/pipeline/rotation.ts`(`rotateTail` / `recordRotation`)
- `EcosystemBoardConfig` 增可选 `rotation`;`buildEcosystemBoard` 增可选第二参
  `rotationMemoryPath`(省略 = 稳态排序,preview 走这条路)
- 新增 `persistEcosystemRotation`(发布成功后回写尾部),`run.ts` 接线
- `markdown.hbs` 视频榜 Tier 边界 8/15 → 15/30
- `.env.example` 新增 `ECOSYSTEM_ROTATION_DAYS`;新增 `feed/published_ecosystem.json`
- Vercel 榜**不配置** rotation:有增速候选仅约 25 个,池子撑不起 15 条尾部轮换

### 验证结果

- vitest 235/235 绿,`tsc --noEmit` OK,prettier 全量合规
- 变异验证:移除 `persistEcosystemRotation` 调用后接线测试如期变红(证明测试有效,
  非假绿)
- 多天模拟(85 池子 × 6 天,真实 `rotateTail` 实现):尾部日均重合 0/15,回退 0 次
