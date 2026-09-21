# ADR-0002: 为 daily release 增加 Rust 与 Agent 垂直榜单

- 状态: Proposed (2026-08-12, grilling session 后待最终签字)
- 范围: gh-trends pipeline + GitHub Actions
- 替代方案: 见 `## 备选`

## 背景

gh-trends 当前是单一综合榜单 pipeline:
`ClickHouse trending (7d, top 150) → GitHub GraphQL enrich → filter → select top-20 → publish daily release`。

用户希望新增两个垂直榜单:
1. **Rust trends** — 用 Rust 写的热门 repo
2. **Agent trends** — name/description 命中 agent 关键词集合的热门 repo

需求来自 gh-trends 维护者,目的是让用户按兴趣订阅主题榜,而非只看到综合榜。

第二轮证据(2026-08-12):
近一周真实抓数据看,SCAN_LIMIT=150 池子里 Rust/agent 候选只有 2-3 个,top-15 体量太小。
扩到 300 后仍要控制 GraphQL 请求数,所以决定翻转 D1。

## 决定(grilling 7 题汇总)

### D1 = F1 — 共享 SCAN_LIMIT=300 + 内存切三份(in-memory sub-select)

`run.ts` 跑 **1 次** scan + 1 次 enrich,SCAN_LIMIT=300,
然后 in-memory 切三份:
- 主榜:全集走 filter + select → top-20
- Rust 榜:`enrichedRepos.filter(r => r.primaryLanguage?.name === 'Rust')` → 走 selectRust → top-15
- Agent 榜:`enrichedRepos.filter(isAgentRepo)` → 走 selectAgent → top-15

不选择 A2(各自独立 scan/enrich),因为:
- 3 * 300 = 900 GraphQL 节点,secondary rate limit 墙触发概率高
- 30s × 3 + 限流等待会让 Actions run 跑超 5 分钟
- 真实数据显示 150 池子候选太少,扩到 300 仍只需 1 次 enrich

不选择 C(150 + 共享),因为:
- 真实数据显示 150 池子 Rust/agent 候选只有 2-3 个

代价:
- 1 次 GraphQL enrich 跑 300 repo(30 次 batch 请求)
- 已经在历史 run 中验证过(此前 SCAN_LIMIT=150 是稳定的)

### D2 = L1 — Rust 严格按 `primaryLanguage.name === 'Rust'`

不查 description / name,只查 GitHub 主导语言。
不选择 L2(name 加 "rust"),因为会撞 `trust` / `frustrate`。
不选择 L3/L4,因为 Rust 生态 monorepo 主导语言判定准确。

### D3 = M2 — agent 关键词在 name + description 双匹配,12 词集合

canonical 关键词列表 `AGENT_KEYWORDS` 放 `src/clients/agentKeywords.ts`:

```ts
export const AGENT_KEYWORDS = [
  'agent', 'agents', 'agentic', 'mcp', 'claude-code',
  'openai-agents', 'crewai', 'autogen', 'langgraph',
  'swarm', 'copilot', 'devin',
];
```

匹配函数 `isAgentRepo(r)`:`nameWithOwner` + `description` 任一命中关键词(大小写不敏感)。

不选择 M1(只 name),因为 agent 关键词在 description 里也常见,完全 in-name 会漏。
不选择 M3(只 description),因为 description 噪声多("the best agent ever" 这种)。

### D4 = X1 — 接受重叠,各自从 trending pool 抽

Rust repo 可以同时出现在主榜单和 Rust 榜单,无互斥。
理由: 用户订阅主榜/Rust 榜是按 release tag 订阅;看到重复是"该 repo 这周确实在多榜上",不是冗余。
不选择 X2/X3,因为互斥会牺牲榜单体量,违背"周榜是综合榜"的设计。

### D5 = E5 — 一个 GitHub release tag,body 三段 section

tag 沿用 `daily-YYYY-MM-DD`(daily-2026-08-13 这种)。
release body 内三段:

```
## 🔥 GitHub trends       (主榜 top-20)
## 🦀 Rust trends          (Rust 榜 top-15)
## 🤖 Agent trends         (Agent 榜 top-15)
```

RSS feed 单文件 `feed/rss.xml`,所有 release 仍然走这一个 feed(现状不变)。
邮件渠道(Resend / Buttondown)同一封邮件发三段。

不选择 E1(三个独立 release tag),因为 release 列表会被垂直榜污染,失去 daily release 的简洁感。
不选择 E2(只 RSS 不 release),因为 GitHub release 是核心发布渠道。

### D6 = N3 — 主榜 top-20,Rust / agent 各 top-15

主榜 20 个保持现状(用户已确认)。
垂直榜 15 个(用户从推荐的 N1=10 反向推到 N3=15)。

## 实施要点(待开发签字后执行)

1. **新增 `src/clients/agentKeywords.ts`** — 关键词常量 + `isAgentRepo()` 工具
2. **新增 `src/pipeline/vertical.ts`** — `selectRust(repos)`, `selectAgent(repos)` 两个函数
3. **改造 `src/run.ts`** — 1 次 scan + 1 次 filter(共享)+ 3 道 select(主/Rust/Agent)+ render 三段
4. **改造 `src/preview.ts`** — 同步
5. **改造 `src/pipeline/render.ts`** — 接受 `{ main, rust, agent }` 三组 sections
6. **改造 `src/templates/markdown.hbs`** — 三段 section 模板
7. **改 `.env.example`** — `SCAN_LIMIT=150` → `SCAN_LIMIT=300`
8. **新增 tests** — `tests/pipeline/vertical.test.ts` + `tests/clients/agentKeywords.test.ts`
9. **不改 RSS publisher** — 同一 feed 接受多 sections 不需要 schema 变化
10. **不改 GitHub publisher** — 单一 release tag,body 模板内三段
11. **不改 select.ts** — `selectRust / selectAgent` 复用 `select.ts` 的 fresh bucket 排序逻辑

## 备选(被否决)

| 决定 | 被否决方案       | 否决理由                                       |
|-----|----------------|---------------------------------------------|
| D1  | A1 SQL 端过滤  | events 表无 language 列,代价过大                |
| D1  | A2 各自独立 scan | 900 GraphQL 节点,secondary rate limit 墙触发     |
| D1  | C 150 + 共享   | 真实数据显示 Rust/agent 候选只有 2-3 个            |
| D2  | L2 关键词宽松  | 撞 `trust` / `frustrate` 噪声多                  |
| D3  | M1 仅 name    | 漏 description 命中 agent 的项目                 |
| D3  | M3 仅 desc    | 噪声多(个人宣传)                                 |
| D4  | X2/X3 互斥    | 牺牲体量,违背综合榜设计                          |
| D5  | E1 多 release | 污染 release 列表                                |
| D5  | E2 仅 RSS     | 错过 GitHub release 主渠道                       |
| D6  | N1=10         | 用户偏好 15                                      |

## 后果

正面:
- 用户可按兴趣订阅主榜/Rust 榜/Agent 榜(虽然都在同一 release,但 section 清晰)
- release body 信息密度高,每天内容变化更大
- 1 次 GraphQL enrich,跟现状一样稳(只是池子从 150 → 300)
- SCAN_LIMIT=300 后 Rust/agent 候选大概率能凑满 15

负面 / 风险:
- 池子扩大,filter 阶段 CJK / fresh-owner 命中数可能略增,但 50% guardrail 兜底
- 关键词集合需要后续维护(新 agent 生态出现时要扩充),改动 1 个文件
- 短期内 Rust/agent 榜仍可能因池子空而 fail-closed(发短榜),真实信号

## 验证

实施后:
1. `npm test` 全绿,vertical test 覆盖 L1 严格匹配 + M2 关键词命中 + 边界用例(空 pool / 短 description / null language)
2. `npm run typecheck` 无错
3. `npm run lint` 无 warning
4. `npm run preview:live` 本地 dry-run,验证三段都渲染
5. `workflow_dispatch` 触发 `Publish Github release`,确认 body 三段都出现
6. RSS feed 文件无 schema 错误

## 后续可优化(LATER_PLANS)

- 关键词集合版本化 + `keywords.version` 字段在 release body 头标注
- Rust 榜可考虑 `topics` GraphQL 查询(topics 里有 `rust` 的也算),但需要改 GraphQL query 模板
- Agent 榜可考虑 OpenAI / Anthropic 官方 SDK 列表加白名单,过滤掉蹭热度的项目

---

## 扩展 2026-08-17:D8 — 新增 DeepSeek Harness 垂直榜单

### 背景

用户要求"增加一个 DeepSeek Harness 关键词榜单",并指定 3 个关键词:
`cordis` / `dsh` / `dsh-plugin`(这是 DeepSeek Harness 生态内部的项目命名约定:
cordis 是数据/记忆层,dsh 是 CLI / daemon 缩写,dsh-plugin 是插件)。

### 决定

**D8 = A3 + 用户指定 3 关键词**:

- 新增 `src/clients/deepSeekKeywords.ts`,`DEEPSEEK_HARNESS_KEYWORDS = ['cordis', 'dsh', 'dsh-plugin']`
- 新增 `selectDeepSeekHarness()`,复用 `rankAndSlice`
- markdown.hbs 加第四段 section: `🧠 DeepSeek Harness trends`
- `.env.example` 加 `RELEASE_TOP_N_DEEPSEEK=15`
- 跟 Rust / Agent 一致接口,4 段 section 一起渲染

### 验证(2026-08-17 dry-run,真实数据)

| 段 | 命中数 |
|----|-------|
| 🔥 主榜 | 20 |
| 🦀 Rust | 6 |
| 🤖 Agent | 15 |
| 🧠 DeepSeek Harness | **2** |

命中 repo:
- cordiverse/cordis (5,017 ⭐, TypeScript)
- Devin-AXIS/iPolloWork (4,062 ⭐, HTML)

Devin-AXIS 同时进 Agent 榜和 DeepSeek Harness 榜,印证 D4 = X1 重叠默认。

### 关键词风险与缓解

`dsh` 是短缩写,可能误伤其他项目;`cordis` 是拉丁语 + 欧盟 CORDIS 项目库。
当前 fail-closed 默认下,误伤风险被 FILTER_MIN_STARS=200 兜底(只过滤高质量 repo)。
后续如果误伤多,可收紧关键词(只保留 `dsh-plugin`)。

---

## 扩展 2026-09-21:D9 — P0 三项改造与配额调整(specs/0001)

### 背景

用户诉求"在项目进 top N 之前发现它"。动态验证确认原 SQL `HAVING starsBefore > 0`
使从零爆火项目结构性不可见(7 天窗口实测 116 个 / 10949 star 零可见度);
daily 频率下无发布记忆导致爆火项目连续霸榜;打分缺加速度二阶导。
详见 specs/0001-channel-b-accel-dedupe.md(实现已全落地,146 测试绿)。

### 决定

- **D9a 双通道 SQL**:通道 A 原比值逻辑不动;通道 B `starsBefore = 0 且
  starsWithin >= SCAN_CHANNEL_B_MIN_STARS(40)`,配额 `SCAN_CHANNEL_B_LIMIT=100`
  (用户拍板);WHERE 加 60 天下界(`SCAN_HISTORY_DAYS`)算真实历史 starsBefore
- **D9b 加速度乘数**:`accel = clamp((recent+1)/(earlier+1), 0.5, 3)`,
  权重 `SELECT_ACCEL_WEIGHT=0.5`,0 时完全等价旧行为
- **D9c 发布去重**:`feed/published.json` 90 天记忆,dedupe 在 filter 之前
  (不进 guard 分母),记录写回在全部渠道发布成功之后;文件缺失/损坏 fail-open
- **D9d 配额调整(用户拍板)**:`FILTER_MIN_STARS` 200→40(小众垂直低 star 保留),
  垂直榜 `RELEASE_TOP_N_RUST/AGENT/DEEPSEEK` 15→30
- **D9e FILTER_FRESH_OWNER=true**:通道 B 实测约一半为盗版钓鱼仓库,
  fresh owner 检测(ADR 沿用 fail-closed 哲学)是其信噪比硬依赖

### 对既有决定的更新

- D6(垂直榜 top-N=15)→ 30;`.env.example` 注释与 CONTEXT.md 配置清单已同步
- 与 D8 的关系:DeepSeek Harness 榜评分口径不变,仍复用 rankAndSlice

### 验证(2026-09-21 回溯冒烟,SCAN_EVAL_DATE=2026-09-19T12:00:00Z)

- scan 205(通道 A 150 + 通道 B ~55);hypit-ai/hypit(starsBefore=0)入主榜第 2 名,
  通道 B 生效直接证据;fresh owner 拦掉 Microsoft-Activation-Script 等钓鱼仓库
- ClickHouse 全量参数实测:360 行 = A300 + B60,扫描 10 亿行约 1.6s
