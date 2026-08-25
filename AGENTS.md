# AGENTS.md

## 项目概述

Cocoon 是一个使用 TypeScript、Vite 和 Chrome Manifest V3 开发的浏览器扩展。

当前功能：

- Action Badge 统计当前标签页本次页面生命周期内被隐藏的卡片与评论数量；Popup 显示页面状态、准确拦截数、本地作者/标签摘要、搜索、单个解除、8 秒撤销和管理页入口。
- 进入知乎首页 `https://www.zhihu.com/` 后，为内容信息流卡片添加极简 `×`，并在受支持的知乎作者悬浮窗口中添加屏蔽入口。
- 点击入口只打开本地标签抽屉；选择或创建标签后，才通过 background 将 schema v5 作者记录写入扩展自有 IndexedDB，并隐藏当前及后续出现的同作者卡片、评论和回复；不采集或保存卡片图像。
- 标签抽屉可按用户可见且已记忆的选项，对直接选择的单个作者执行知乎账号级拉黑，或读取当前内容的点赞者并仅将其加入 Cocoon 本地黑名单；点赞者不得进入远程拉黑 POST。
- 独立管理页提供完整作者列表、搜索、标签/平台筛选、排序、单个/批量解除、标签维护，以及严格校验且原子执行的 JSON 导入与导出。
- 本地身份按 `(platformId, userId)` 隔离；当前只有知乎运行时插件，展示或导入其他平台分类不表示支持对应网站过滤。
- 具体已交付能力、待开发需求和已知浏览器缺陷以 `docs/blacklist-spec.md` 的需求状态为准。

## 技术栈

- TypeScript（严格模式）
- Vite
- Chrome Extension Manifest V3
- 原生 DOM API，不使用前端框架

## 目录结构

```text
.
├── README.md                    # 公开项目说明、安装、权限、数据行为与贡献入口
├── LICENSE                      # Apache License 2.0
├── popup/popup.html             # Popup HTML 入口
├── options/options.html         # 独立管理页 HTML 入口
├── public/
│   └── manifest.json            # Manifest 基础字段源文件（不手写 content_scripts）
├── src/
│   ├── background/              # 模块 Service Worker、Badge、RPC、锁与管理事务
│   ├── content/
│   │   ├── main.ts              # 无站点业务语义的内容脚本启动入口
│   │   └── *.ts                 # 共享黑名单、过滤、标签与知乎纯逻辑控制器
│   ├── core/plugin/             # 严格插件契约、descriptor 校验、registry 与 eager discovery
│   ├── options/                 # 管理页逻辑、视图、对话框与文件传输
│   ├── popup/                   # Popup 逻辑、视图与样式
│   ├── ui/                      # Popup/options 共用 RPC、view-model 与 URL helper
│   └── plugins/zhihu/
│       ├── plugin.json          # 知乎插件 ID 与 Manifest matches 的单一来源
│       ├── plugin.ts            # 插件能力声明与挂载入口
│       ├── runtime.ts           # 知乎 DOM/storage/network 挂载接线
│       └── plugin.css           # 知乎内容样式，构建为稳定 assets/content.css
├── scripts/
│   ├── build/                   # 插件扫描、Manifest 组合、Vite 构建守卫及测试
│   ├── capture-zhihu-snapshot.mjs # 本地知乎原始最小快照采集
│   └── lib/                     # 快照转换纯函数及测试
├── docs/
│   └── blacklist-spec.md        # 唯一跟踪的产品规格与交付状态文档
├── vite.config.ts               # Popup/options/content/background 多入口构建配置
├── tsconfig.json
└── dist/                        # 构建产物，不要手动编辑或提交
```

## 常用命令

```bash
npm ci
npm test
npm run typecheck
npm run format
npm run format:check
npm run lint
npm run check
npm run build
npm run dev
npm run snapshot:zhihu
```

- `npm ci`：按已提交的 lockfile 进行可复现安装；只有明确变更依赖时才使用 `npm install` 并同步提交 lockfile。
- `npm test`：运行 background、内容逻辑、RPC、Popup、options、UI、插件 registry、构建/Manifest、快照和工程工具纯函数测试。
- `npm run typecheck`：执行严格 TypeScript 类型检查。
- `npm run format`：格式化新增违规和内容已变化的债务文件，但默认跳过内容哈希完全未变的既有格式债务；可在 `--` 后传入维护范围内的具体文件进行显式迁移。
- `npm run format:check`：检查维护中的源码、脚本、扩展页面、样式和配置；既有格式债务必须与内容哈希基线精确一致，新增、变化、已解决、缺失或失效的条目都会失败。
- `npm run lint`：仅扫描根配置、`src/**` 和 `scripts/**` 中维护的 JS/MJS/TS；错误必须清零，warning 必须逐条匹配内容敏感基线。
- `npm run check`：依次运行格式检查、lint、测试和完整构建。
- `npm run build`：先进行类型检查，再扫描插件 descriptor、构建四个入口并生成最终 `dist/manifest.json`。
- `npm run dev`：监听源码变化并持续重新构建。
- `npm run snapshot:zhihu`：显式连接现有 Chrome，生成包含真实作者标识的本地最小知乎快照。

每次修改代码、测试、Manifest 或构建配置后，至少运行：

```bash
npm run format:check
npm run lint
npm test
npm run typecheck
npm run build
git diff --check
```

仅修改普通文档时至少运行 `git diff --check`；不得把文档中的历史验证结果冒充为本次已执行结果。

## 功能规格与交付状态

- `docs/blacklist-spec.md` 是作者黑名单功能的产品行为、技术决策、需求状态和验收标准的事实来源。
- Developer 和 Reviewer 开始相关工作前都必须读取该规格，并按需求 ID 明确本次范围；本文档与规格冲突时，应先报告冲突并由用户确认，不得自行选择行为。
- Developer 只实现规格中标记为 `READY_FOR_DEV` 的需求，不得自行实现 `DECISION_PENDING` 或 `DEFERRED` 项，也不得自行把需求标记为 `DELIVERED`。
- Developer 完成实现和自动化检查后，将需求交给 Reviewer；审查期间可由主协调者标记为 `IN_REVIEW`。
- Reviewer 必须按需求 ID 和验收标准独立审查代码、测试、构建、Manifest、安全性及相关快照证据。Reviewer `PASS` 后，主协调者即可将对应需求更新为 `DELIVERED`；真实浏览器验收不再是该状态的前置条件。
- 真实浏览器验收由用户负责。用户反馈失败时，应新增或更新对应 `BUG-*`/替代需求并标为 `READY_FOR_DEV`；原需求保留 `DELIVERED` 以记录当时已通过开发与审查，除非其产品行为已被新需求取代，此时标记为 `SUPERSEDED`。
- 新增或变更需求时应更新规格版本、状态和交付记录；已交付但被替代的行为标记为 `SUPERSEDED`，不得删除历史决策。

## Chrome 中的测试方式

1. 执行 `npm run build`。
2. 打开 `chrome://extensions`。
3. 开启开发者模式。
4. 加载或重新加载 `dist/` 目录，而不是项目根目录。
5. 刷新知乎首页。
6. 按本次修改范围验证：
   - Popup 页面状态、Badge/准确拦截数、搜索、解除、撤销和“管理全部”；
   - 管理页作者搜索、标签/平台筛选、排序、单个/批量解除、标签维护及导入导出；
   - 卡片与作者悬浮入口只打开抽屉，提交标签后才写入并过滤卡片、评论和回复；
   - 无限滚动、评论重开和动态插入不重复注入且继续过滤；
   - 若涉及知乎操作，直接作者远程 POST 与点赞者仅本地入库的边界不被破坏。

修改 Manifest、background 或内容脚本后，必须重新加载扩展；修改目标页面行为后还必须刷新知乎首页。

### Chrome DevTools 端口约定

- 本项目默认使用 `127.0.0.1:9223`，不得默认改用 `9222`。
- 用户提供其他端口，或快照脚本设置 `COCOON_CHROME_DEVTOOLS_PORT` / `COCOON_CHROME_DEVTOOLS_ACTIVE_PORT` 时，使用对应端口。

### 本地知乎快照规则

- 涉及知乎 DOM、选择器、字段解析或成员接口契约的开发与审查，必须先读取 `.pi/browser-snapshots-local/zhihu/latest.json` 及其指向的快照，再考虑使用 CDP 检查真实页面。
- Developer 应以源码、测试和最新快照作为首轮实现依据；Reviewer 必须独立检查最新快照及相关代码，不能只依赖 Developer 的摘要或结论。
- 快照不存在、格式无效、缺少相关样本，或与当前源码/线上行为冲突时，应明确报告局限；只有任务确实需要时，才使用 Chrome 补充证据。
- 快照包含真实个人数据。终端输出和开发、审查报告只能给出字段、数量和验证结论，不得复述作者名、成员 hash、`url_token` 等真实值。
- 仅在明确需要更新本地证据时运行 `npm run snapshot:zhihu`；脚本不得自动随构建或测试执行。
- 快照只写入 `.pi/browser-snapshots-local/zhihu/`，该目录必须保持 Git 忽略，不得强制提交真实采集数据。
- 快照包含真实作者名、成员 hash、资料页 `url_token` 等个人数据；不得提交、分享、上传、附加到 issue，或用于本机开发以外的任何场景；不再需要时必须删除。
- 只提交采集脚本、纯函数测试和必要配置；`docs/` 中仅 `docs/blacklist-spec.md` 允许跟踪，不得强制加入被忽略的快照说明、真实快照或其他本地文档。
- 采集范围必须保持用途限定和严格白名单，不得恢复标题、内容/问题 ID、跟踪数据、完整 HTML、Cookie、请求头、Storage、通知、React 内部数据、头像 URL 或无关信息流数据。
- 快照是采集时的本地开发证据，不代表当前生产 DOM，不能替代用户最终浏览器验收。公开 clone 不提供被忽略的本地快照说明，开发与审查必须以本节、采集脚本和已跟踪规格为准。

## 构建约束

- `public/manifest.json` 只提供 Manifest 基础字段（名称、版本、Action、权限等），不得手写 `content_scripts`；`dist/manifest.json` 由构建扫描 `src/plugins/*/plugin.json` 后组合生成，不是基础文件的直接副本。
- 不要直接修改 `dist/` 中的任何文件。
- 最终 Manifest 固定引用稳定的 `assets/content.js`、`assets/content.css` 和模块 `assets/background.js`；content 与 background 两个入口都必须自包含，不得依赖 shared/dynamic ESM chunk。
- Popup 与 options 必须保持为独立扩展页面入口，可以共享构建生成的本地普通 ESM chunk，但不得成为 content/background 的外部依赖；不得引入远程脚本。
- 基础 Manifest 必须继续声明 Action Popup、模块 Service Worker 和 tabbed options 页面；新增入口时同步更新 `vite.config.ts`，新增站点插件不应新增内容入口，而应由 eager registry 编入同一个 content bundle。
- `package.json` 和 `public/manifest.json` 的版本号应保持一致；最终 Manifest 版本必须继续来自该基础文件。
- `scripts/build/plugin-manifest.ts` 必须严格拒绝缺失配对入口、非法/重复 ID、非法/空/重复 matches、跨插件重复 matches、额外 descriptor 字段和孤立 `plugin.ts`/`plugin.json`。
- 构建扫描不得跟随 symlink 插件目录或入口；watch 模式下插件 registry、构建 bundle 和 Manifest 页面范围必须保持一致，失败时不得留下部分更新的 Manifest。

### 版本号管理

- 每次开发任务结束时，主代理必须主动判断项目版本号是否需要变更，不等待用户另行提出版本升级要求。
- 遵循语义化版本：向后兼容的缺陷修复升级 patch，向后兼容的新功能升级 minor，破坏公开契约的变更升级 major；普通文档、仅测试、格式化、内部重构或未完成工作默认不升级版本。
- 需要升级时，必须在同一原子改动中同步 `package.json` 与 `public/manifest.json`，并同步项目明确要求的其他版本记录；`dist/` 仍只由构建生成，不得手工修改。
- 完成报告必须说明本次版本决策及理由。升级版本不代表自动发布或创建 Release，除非用户或项目发布流程另有明确要求。

## 站点插件架构

- 站点插件遵循 `src/plugins/<id>/plugin.ts` + `plugin.json` 约定；目录名、descriptor ID 和 runtime metadata 必须一致。
- `plugin.json` 是插件 ID 与 Chrome match patterns 的单一来源。`plugin.ts` 必须导入同一 JSON，不得复制 ID 或页面范围；能力声明只描述实现，不会授予 Chrome 权限或扩大 Manifest 范围。
- `src/core/plugin/discovery.ts` 只使用 Vite `import.meta.glob(..., { eager: true })` 静态发现本地插件，使所有插件代码进入自包含内容脚本；禁止运行时 URL import、远程/用户代码、`eval()` 和 `new Function()`。
- registry 的 descriptor 解析、runtime 一致性检查和 URL 选择保持纯函数可测试。当前 URL 必须恰好匹配一个插件；零匹配、多匹配或无效 registry 均安全停止且不得挂载任何站点行为。
- 插件模块导入必须无浏览器副作用；只有成功选择后才可且只可调用一次 `mount()`，并由所选插件注册 DOM observer、storage listener、锁和网络接线。
- 当前只有知乎插件，不表示或暗示已支持 YouTube 或其他网站。增加站点前必须另行确认身份、DOM、storage 命名空间、Manifest 范围和验收需求。

## 工程质量与模块边界

这些目标用于约束复杂度和职责，而不是鼓励为了数字机械拆函数。拆分必须形成可命名、可测试且依赖方向清楚的边界；不得用只转发一次的碎片 helper 隐藏复杂度。

### 最小实现与避免过度设计

- 默认采用满足用户明确需求和现有强制约束的最小完整实现；不要把一次性需求扩展为通用框架、插件、配置系统或未来能力。
- 只有已有至少两个真实调用方、当前需求明确要求复用，或不抽象会直接破坏既有边界时，才新增通用抽象；不得为假设中的未来需求预留复杂度。
- 修改范围保持最小，不顺带重构无关代码、调整无关 UI/文档或扩大构建和运行时职责。
- 测试采用最小充分覆盖：优先复用现有测试，只为本次可观察行为和关键回归边界增加直接用例；不得重复已有覆盖或为低风险受控输入穷举无关安全矩阵。
- 仍须执行本文件规定的强制检查与审查，但通常只完整运行一次；修复失败时先运行针对性检查，完成后再做一次必要的完整验证，不得为追求“更完整”重复启动无必要的全量检查或多轮代理审查。
- 最小实现与任何安全、Manifest、schema、隐私、快照或明确验收规则冲突时，以后者为准，并选择符合这些约束的最小方案。

### 格式、规模与复杂度

- Prettier `printWidth` 为 100，代码和配置以 100 列为目标；不可拆分且拆分会改变语义或可读性的 URL、正则、选择器、协议字符串和其他完整字符串可以超过 100 列。
- 函数通常不超过 50 个逻辑行（忽略空行和纯注释行）。超过 80 个逻辑行必须拆分；确实不能拆分时，开发报告必须说明职责边界、风险和保留理由。
- 控制流嵌套不超过 3 层；优先使用 guard clause、提前返回或提取有业务含义的步骤，不能仅为满足规则改写成更难读的布尔表达式。
- 圈复杂度目标不超过 10；超过 12 必须重构为可独立验证的决策或阶段。10～12 需要确认分支仍属于同一职责并有覆盖关键路径的测试。
- 函数最多使用 4 个位置参数；更多输入改用有明确名称的 options 对象。不要把本应分离的职责仅包装进一个巨型 options 对象。
- 生产模块目标不超过 500 个逻辑行；超过 700 行必须在开发报告中给出按职责拆分的具体计划。测试文件可以更长，但必须按行为或场景分组，并提取重复 fixture、driver 和断言 helper。
- 既有超限文件和函数执行非回归规则：本次修改不得增加其逻辑行、复杂度、嵌套或职责面；新增职责必须提取到新模块。若修复无法避免短期增加，必须报告增量、原因和后续拆分计划。

### 单一职责与依赖方向

- “单一职责”指模块只有一个可陈述的变化原因。例如 schema 规则变化不应迫使 DOM adapter 或 Chrome listener 同时改写；页面选择器变化不应进入领域状态迁移；消息接线变化不应改动纯排序或冲突规则。
- 纯领域层负责身份、schema、迁移、验证、排序、冲突与状态转换：输入输出显式，不读取 DOM、`chrome.*`、网络、时钟或模块级可变状态。
- 站点 adapter 只把已验证的站点 DOM/响应转换为领域输入，并把领域决定应用回页面；知乎 selector、端点和成员 alias 不得泄漏到跨站核心层。
- 扩展 wiring 只负责 Manifest 入口、Chrome 事件/RPC、storage、锁和生命周期接线；listener 应委托给领域或 controller，不在回调内复制业务规则。
- 依赖方向保持为 wiring/站点 adapter 依赖领域契约，而不是领域层反向依赖浏览器实现。跨边界使用最小接口，以便用确定性 fake 测试。

### 异步、并发与生命周期

- 不允许 floating Promise。每个 Promise 必须被 `await`、明确 `return`，或在确实 fire-and-forget 时用 `void` 启动并在内部收敛错误；Node test runner 接管的 `test(...)` 注册调用是工具配置中的明确安全例外。
- 所有 storage read-modify-write、导入/迁移、alias 补写和会产生重复副作用的网络/DOM 操作必须在既有锁或等价单飞机制内完成；锁内重读权威状态，保证重试、重复消息和并发 listener 不会重复写入、POST 或注入。
- 网络、消息、长任务和可等待 UI 必须定义合理的 timeout 或取消边界。成功、超时、取消、抛错和 worker/port 中断都必须收敛到可再次操作的稳定状态，并在 `finally` 中释放锁、listener、timer、observer 和临时 DOM。
- Service Worker 随时可能终止；黑名单权威状态写入扩展自有 IndexedDB，偏好与其他持久 Chrome 状态写入 `chrome.storage.local`，会话状态写入 `chrome.storage.session`。模块内缓存只能是可丢弃优化，事件处理必须能够从持久状态重建且保持幂等。

### DOM 与可访问性

- DOM 扫描和批量更新通过 `requestAnimationFrame` 分批调度，必要时主动让出主线程；动态页面操作必须幂等，重复 observer 通知不能重复按钮、listener、请求或计数。
- controller 必须拥有并清理自己创建的 observer、listener、timer、port 和临时节点；卸载、重挂载、抽屉关闭和页面生命周期结束后不得留下活动副作用。
- 注入 UI 使用语义化原生控件，提供可访问名称、键盘操作、可见 focus、合理焦点恢复和状态文本；不得只靠颜色表达状态，并尊重受限尺寸、长文本和缩放。

### 测试、依赖、注释与工具基线

- 回归测试面向可观察行为和不变量，而不是复制实现步骤；固定时间、随机数、网络、storage 和 DOM 调度，避免真实计时等待、顺序偶然性、共享全局状态及依赖线上页面。失败用例应在修复前稳定复现。
- 复杂分支使用表驱动或按行为分组的测试，明确成功、边界、超时/取消、并发重复和失败收敛；测试名称说明条件与结果。
- 新依赖必须解决现有平台能力不能合理解决的问题，并报告用途、维护/供应链成本、bundle/runtime 影响和许可证；优先 devDependency，禁止为方便而扩大 MV3 权限、host scope 或引入远程运行时代码。
- 注释解释约束、风险和“为什么”，尤其是锁、迁移、浏览器缺陷和安全边界；不要复述代码，也不要保留与实现不一致的注释。可由名称和类型表达的规则应优先写进结构与测试。
- ESLint 明确排除 `docs/**`、`dist/**`、`node_modules/**` 和 `.pi/**`。TS 与维护中的 `scripts/**/*.mjs` 都执行 type-aware Promise 和 misused Promise error 规则；`node:test` 的 `test(...)` 注册是唯一 safe-call 例外。type import 与 switch 穷尽性规则仅用于 TS。既有 recommended、复杂度和规模债务暂为 warning，`scripts/tooling/eslint-warning-baseline.json` 按相对路径、rule/message identity、完整消息、规范化源码行和重复次数锁定；新增、替换、恶化或已解决但未清理的 warning 都会失败。
- Prettier 会扫描全部维护中的代码/配置目标；`scripts/tooling/prettier-baseline.json` 只记录引入工具时已经存在的未格式化文件及其内容哈希。新增违规、内容已变化的债务、文件缺失、已清除但未移除或越界条目都会使 `format:check` 失败。默认 `npm run format` 跳过哈希完全未变的债务，格式化其余违规并清理对应条目，避免无关全仓重排；不得把新文件加入基线来绕过格式化。

## Chrome Extension 规则

- 始终使用 Manifest V3，不得引入 Manifest V2 API。
- Popup 和其他扩展页面中不得使用内联脚本或内联事件处理器。
- 只申请功能实际需要的权限和站点访问范围。
- 当前功能只需要 `storage` 权限；不要无理由添加 `tabs`、`scripting`、`downloads`、`unlimitedStorage` 或 `<all_urls>`。
- Manifest 中引用的脚本、CSS 和图片必须真实存在于构建产物中。
- 内容脚本运行在 isolated world，但共享页面 DOM；Console 日志仍可在页面开发者工具中查看。
- Service Worker 会被随时终止；黑名单持久权威状态必须存入 IndexedDB，偏好等其他持久状态存入 `chrome.storage.local`，会话权威状态存入 `chrome.storage.session`，不得只依赖后台模块全局变量。异步消息 listener 必须同步声明保持响应通道，并确保最多响应一次。

## Schema v5 与平台身份边界

- background 独占访问的 IndexedDB 是唯一黑名单权威，逻辑 `schemaVersion` 仍为 `5`；旧 `cocoonBlacklistState` 只允许作为一次性 v1～v5 迁移来源，成功迁移后删除。`cocoonBlacklistRevision` 只是不含黑名单数据的非权威通知，不得用于重建状态或形成平行权威。
- 作者记录必须包含合法 `platformId`，身份、去重、恢复、批量解除和 alias 冲突都按 `(platformId, identifier)` 隔离；跨平台相同 `userId` 可以共存。
- 所有 v1～v4 有效历史记录迁移为 `platformId: "zhihu"`；迁移必须幂等、无图且保留标签、名称、来源和首次屏蔽时间。
- `memberHashId` 是知乎专用 alias，非知乎记录必须为 `null`；非知乎稳定 ID 不执行知乎 hash 规范化。
- 知乎卡片、评论、alias 补写、点赞者任务和账号级网络操作只能读取/写入 `platformId: "zhihu"` 的运行时记录。其他平台分类不得获得知乎页面过滤、网络请求、Manifest scope 或插件能力。
- Popup/options 只有知乎记录可以生成知乎主页链接；其他平台作者名称必须为普通文本，直到对应插件交付可信 URL 规则。

## Background RPC、管理事务与导入导出

- Popup/options 的黑名单读写必须通过严格版本化 RPC 和 background IndexedDB 事务边界；未知、额外字段、错误 operation、未授权 sender 或超限消息必须 fail closed。
- 普通管理 RPC 只接受精确内置 Popup/options 页面；JSON transfer operation 只能接受精确 `options/options.html` sender。
- 导出 envelope 只允许包含固定产品/格式/schema 元数据、authors 和 tags，不得包含设置、Badge/session 状态或其他 storage 数据。
- 导入合并与替换必须先完成固定键、版本、字段、长度、数量、标签引用、平台身份和 alias 冲突校验，再在锁内重读并最多执行一次原子写入；解析、冲突、锁或写入失败时不得留下部分状态或虚假成功。
- Transfer 文件和 RPC JSON 上限为 8 MiB，作者最多 20,000 条、标签最多 2,000 个；不得为导出新增 `downloads` 权限，继续使用扩展页面本地 Blob 下载。
- 真实 `cocoon-blacklist-*.json` 导出包含作者名称、稳定 ID、alias、标签、来源和时间等个人数据，不得提交、分享、上传或附加到 Issue，也不得直接用作测试 fixture。测试必须使用合成标识和最小构造数据。

## 公开仓库与敏感文件规则

- 用户可见功能、支持页面、权限、数据行为、安装方式或开发命令变化时同步更新 `README.md`；不得写入不存在的 Badge、截图、远程仓库或发布链接。
- 根目录 `LICENSE` 与 `package.json#license` 必须保持一致；第三方代码、素材和历史文件必须单独确认来源及再分发权，项目许可证不会自动覆盖第三方内容。
- `docs/` 默认忽略，只有 `docs/blacklist-spec.md` 允许跟踪；不得使用 `git add -f` 提交其他 docs、本地审计报告或包含真实数据的说明文件。
- 不得提交 `.env*`、私钥/证书、CRX、发布 ZIP、日志、真实导出 JSON、浏览器 Profile、Cookie、Storage dump 或个人数据。构建产物 `dist/` 只用于本地加载或经审查的发布制品，不进入源码提交。
- 示例、测试、截图和 README 素材只使用合成或明确脱敏数据；不得复述本地快照中的真实作者名、稳定 ID、member hash 或资料 token。

## 知乎内容脚本约定

知乎页面接线位于 `src/plugins/zhihu/runtime.ts`，只允许在知乎插件成功选择后的 `mount()` 内执行；迁移期纯逻辑 helper 可继续位于 `src/content/`。

当前依赖的知乎 DOM 特征：

- 卡片：`.TopstoryItem`
- 内容节点：`.ContentItem[data-zop]`
- 作者优先来自 `data-zop` JSON 的 `authorName`
- 作者后备选择器：`.AuthorInfo-name, .UserLink-link`
- 用户 ID 优先来自作者资料链接 `/people/<slug>`
- 无资料链接时，从同一内容节点的 `data-za-extra-module` JSON 读取 `card.content.author_member_hash_id`，再请求同源 `/api/v4/members/<hash>` 并读取 `url_token`

知乎 DOM 可能随时变化。修改选择器前，应先在实际知乎首页检查 DOM，不要仅凭猜测添加选择器。

内容脚本必须满足以下要求：

- 支持知乎无限滚动和动态插入的卡片。
- 使用 `MutationObserver` 监听新增内容。
- DOM 更新通过 `requestAnimationFrame` 分批处理，避免阻塞主线程。
- 注入的 CSS 类名统一使用 `cocoon-` 前缀，避免与知乎样式冲突。
- 重复扫描必须是幂等的，不能给同一卡片重复添加按钮。
- 点击注入按钮时调用 `preventDefault()` 和 `stopPropagation()`，避免触发卡片本身的跳转。
- Console 输出统一添加 `[Cocoon]` 前缀。
- JSON 解析必须有错误处理和合理的后备值。

## UI 风格

当前用户偏好极简设计。卡片按钮应保持：

- 单独的 `×` 字符
- 无边框
- 无圆形背景
- 无阴影
- 无悬停变色
- 无旋转或缩放动画

除非用户明确提出，否则不要重新加入醒目的颜色、圆圈或复杂动效。

## TypeScript 与代码风格

- 保持 `strict` 类型检查通过，不使用 `any`。
- 优先使用 `const`，仅在需要重新赋值时使用 `let`；类型导入使用 `import type` 或 inline type specifier。
- 使用 `async/await`，不要新增 `.then()` 链；Promise 所有权、并发和失败路径遵循上文规则。
- 不使用 `eval()`、`new Function()` 或其他违反扩展 CSP 的实现。
- 不要依赖内容脚本中的全局可变状态保存持久数据；需要持久化时使用 `chrome.storage`。

## 自动化测试规则

- 纯函数和包含复杂分支的逻辑应编写单元测试。
- 简单的 DOM 接线代码可以通过构建检查和 Chrome 浏览器手动验证，不强制编写单元测试。
- 修复可复现的逻辑缺陷时，应优先补充能够覆盖该缺陷的回归测试。
- 涉及 `chrome.*` API、Manifest 注入、isolated world 或真实知乎 DOM 的行为，Developer 和 Reviewer 必须明确自动化证据的边界；真实浏览器结果由用户验收并反馈，不作为 Reviewer `PASS` 或需求标记 `DELIVERED` 的前置条件。
- 当前测试框架为 Node 内置 test runner + jsdom；新增测试应优先复用现有工具，不要无说明地引入大型测试依赖。

## 完成修改前的检查清单

仅修改普通文档时，只要求执行 `git diff --check`，并核对文档引用与事实准确性；以下测试、类型检查、构建和产物项仅适用于代码、测试、Manifest 或构建配置变更。其余安全、敏感数据和真实浏览器报告项始终适用。

- [ ] 若本次涉及代码、测试、Manifest 或构建配置，`npm run format:check` 通过
- [ ] 若本次涉及代码、测试、Manifest 或构建配置，`npm run lint` 通过且 warning 逐条匹配内容敏感基线
- [ ] 若本次涉及代码、测试、Manifest 或构建配置，`npm test` 通过
- [ ] 若本次涉及代码、测试、Manifest 或构建配置，`npm run typecheck` 通过
- [ ] 若本次涉及代码、测试、Manifest 或构建配置，`npm run build` 通过
- [ ] `git diff --check` 通过
- [ ] `dist/manifest.json` 是合法 MV3 JSON，版本与 `public/manifest.json` 一致
- [ ] Manifest 引用的 Popup、options、content、background、CSS 和图片资源都存在于 `dist/`
- [ ] Popup 页面状态、准确拦截数、搜索、解除/撤销和管理入口未因本次修改回归
- [ ] 管理页搜索/筛选/排序、作者与标签操作、平台显示及导入导出按本次范围通过自动化或用户验收
- [ ] 知乎首页现有和动态卡片、评论/回复及受支持悬浮入口保持单次注入、稳定身份和失败安全
- [ ] 点击卡片/悬浮入口只打开抽屉且不会误触跳转；赋予标签后才执行持久化、过滤和当前可见选项授权的知乎操作
- [ ] schema v5、平台隔离、知乎 alias/网络范围和点赞者仅本地入库边界没有回归
- [ ] 导入导出严格校验、options-only 授权、原子写入、Blob 下载和个人数据保护没有回归
- [ ] 没有无必要新增 Chrome 权限、页面范围、远程代码、第三方请求或服务端
- [ ] 没有提交真实快照、导出 JSON、凭据、个人数据、被忽略 docs、`dist/` 或 `node_modules/`
- [ ] 真实浏览器未执行的检查明确报告为“用户验收待进行”，没有写成已验证
