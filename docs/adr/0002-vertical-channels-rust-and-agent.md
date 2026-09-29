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

---

## 扩展 2026-09-29:D10 — 新增 Vercel AI SDK 垂直榜单

### 背景

用户要求"增加一个 关键词 Vercel AI SDK 的 排行"。沿用 D8(DeepSeek Harness)验证过的
vertical channel 路径接入,不引入新抽象。这是第五个榜单(主榜 + Rust + Agent +
DeepSeek Harness + Vercel AI SDK)。

### 决定

**D10 = A3 + 3 个生态信号关键词**:

- 新增 `src/clients/vercelAiSdkKeywords.ts`,
  `VERCEL_AI_SDK_KEYWORDS = ['vercel ai sdk', 'vercel/ai', 'ai-sdk']`
  - `vercel ai sdk` — 品牌完整短语,desc 生态描述主信号("A provider for the Vercel AI SDK")
  - `vercel/ai` — 官方 repo 及衍生(vercel/ai、vercel/ai-chatbot),生态核心本身
  - `ai-sdk` — npm 生态命名约定(@ai-sdk/*、ai-sdk-provider-*、*-ai-sdk)
- 新增 `selectVercelAiSdk()`,复用 `rankAndSlice`,env `RELEASE_TOP_N_VERCEL_AI_SDK`(默认 30,与 D9d 垂直榜口径一致)
- markdown.hbs 加第五段 section: `▲ Vercel AI SDK trends`
- 匹配规则沿用 M2(name + description 双匹配,大小写不敏感)

### 关键词误伤分析(对照 D8 的 dsh/cordis 教训)

- `ai-sdk` 不命中空格形式 "openai sdk",只命中显式连字符命名;连字符 openai-sdk
  类项目极少且本属邻近 AI SDK 生态,噪音由 FILTER_MIN_STARS=40 兜底
- 否决过严方案(只用 `vercel ai sdk` 单短语):官方 repo desc 都不含该短语
  (vercel/ai desc 是 "The AI Toolkit for TypeScript"),榜单将永远为空
- 否决过泛方案(`ai` / `useChat`):灾难性泛匹配
- 特异性显著高于 D8 的 `dsh`(短缩写)/ `cordis`(拉丁词),无需更保守集合

### 顺手修复

`publish.ts` 的 totalRepos/logInfo 漏算 `deepseekHarness` 段(D8 接入遗漏):
main/rust/agent 全空而垂直段有货时会被误判 "no repositories to publish" 跳过发布。
修复后五段全部计入,并补 vertical-only 发布回归测试。

### 验证(2026-09-29)

- vitest 162/162 绿(新增 vercelAiSdkKeywords 10 测 + selectVercelAiSdk 4 测 +
  publish 回归 1 测),typecheck OK,eslint 0 警告
- mock preview:五段 header 全部渲染,空段保护正常
- 带数据冒烟:vercel/ai 注入 vercelAiSdk 段后 Tier 1 渲染正确

---

## 扩展 2026-09-29:D11 — DeepSeek 榜改 topic 匹配 + 移除 CJK 过滤规则

### 背景

线上 `daily-2026-09-28` 实测 DeepSeek Harness 榜 0 条(Rust 2 / Agent 5 / 主榜 20)。
排查(现象 → 假设 → 动态验证)坐实根因:**不是关键词失效,是两层策略冲突**:

- scan 层关键词命中 5-6 个,topic 生态探测(用户指定 github.com/topics/dsh、
  /deepseek-harness、/dsh-plugin)确认生态真实存在且活跃
- filter 层上游 CJK 一刀切规则(desc 含任一汉字即剔除)杀掉其中 4-5 个 ——
  DeepSeek Harness 是中文圈生态,desc 中英混写是正常表达
- 实测 300 个 trending 项目中 48 个 desc 含汉字,23 个被 CJK 规则剔除,
  其中包括 dsh-tauri/deepseek-harness-desktop(2848⭐)、yyh-001/DSH-X(584⭐)等生态核心

用户决策(2026-09-29,原话"直接把这个清掉吧"):
1. **移除 CJK 一刀切规则**(上游 mhadidg 为英文 newsletter 设计的假设,在本项目定位下不成立)
2. **DeepSeek 榜改用 topics 匹配**(用户指定的三个 topic)

### 决定

**D11a — CJK filter 移除**: filter.ts 删除 `/[\p{Script=Han}...]/u` 整段。
防垃圾能力由 FILTER_MIN_STARS=40 与 FILTER_FRESH_OWNER=true 承担(该组合
2026-09-21 起实测有效拦截 KMS-Pico 类钓鱼仓库)。

**D11b — DeepSeek 匹配三层优先级**(deepSeekKeywords.ts 重构):

1. 强信号 topic `dsh` / `deepseek-harness` 任一命中即入榜
   (官方仓库 deepseek-ai/deepseek-harness 同带 dsh + dsh-plugin)
2. 弱信号 topic `dsh-plugin` 需叠加 name/desc 关键词佐证 ——
   实测 star 前 100 里 37 个项目仅挂 dsh-plugin(PicGo / Tencent-WeKnora 等
   通用项目),单独采用会严重污染
3. 关键词兜底 cordis / dsh / dsh-plugin 保留,覆盖未打标签项目

**D11c — GraphQL 补 repositoryTopics(first: 20)**: GithubRepo 类型加
必填 repositoryTopics 字段,所有测试工厂同步。readTopics 兼容缺字段老数据。

**D11d — 关键词匹配改词边界**: 裸 includes 子串的 `dsh` 误伤 Spreadsheets
(烟测实锤 dream-num/univer 进榜);改为"后不接小写字母"边界
(`[dD][sS][hH](?![a-z])`,不能用 'i' 标志否则断言连带大小写不敏感),
Spreadsheets 不再误伤,DshTool 驼峰 / awesome-dsh 结尾 / cordiverse/cordis 正常命中。

### 验证(2026-09-29, 真实数据烟测)

- 漏斗: scan 300 → dedupe 300 → filter 290(CJK 移除后仅 star/fresh-owner 拦截)
- CJK 回归: 含汉字项目 scan 层 48 → filter 后存活 47(仅 1 个因 star 门槛出局)
- **DeepSeek 榜: 0 → 7 个**,含 4 个中文描述生态项目
  (dsh-tauri/deepseek-harness-desktop, yyh-001/DSH-X, Devin-AXIS/jev-dsh-decision,
  ardeyouxipianyi/workbuddy2api-hub),全部带 dsh 系 topic
- 主榜 20 个中 5 个中文描述项目回归
- vitest 174/174 绿(+3 CJK 回归 +词边界正反例),typecheck OK,eslint 0,prettier 对齐

### 对既有决定的更新

- D3/D8(M2 关键词口径)→ D11b 三层优先级;关键词兜底仍兼容老口径语义
- Guardrail(fail-closed 50%)不变;filter 剔除数下降使 guard 分母更安全
- GraphQL 每 repo 响应增大(topics ≤20),300 repo 冒烟无 secondary rate limit 触发
