# AGENTS.md

## 项目概述

Cocoon 是一个使用 TypeScript、Vite 和 Chrome Manifest V3 开发的浏览器扩展。

当前功能：

- 点击扩展图标，Popup 显示 `Hello`。
- 进入知乎首页 `https://www.zhihu.com/` 后，为每张内容信息流卡片添加一个极简 `×` 按钮。
- 点击 `×` 后打开本地标签抽屉；选择或创建标签后，将作者稳定标识、名称、标签、来源和首次屏蔽时间记录到 `chrome.storage.local`，并隐藏当前及后续出现的同作者卡片与评论；不采集或保存卡片图像。
- 具体已交付能力、待开发需求和已知浏览器缺陷以 `docs/blacklist-spec.md` 的需求状态为准。

## 技术栈

- TypeScript（严格模式）
- Vite
- Chrome Extension Manifest V3
- 原生 DOM API，不使用前端框架

## 目录结构

```text
.
├── popup/popup.html             # Popup HTML 入口
├── public/
│   ├── manifest.json            # Manifest 源文件
│   └── content/content.css      # 注入知乎页面的样式
├── src/
│   ├── content/main.ts          # 知乎内容脚本
│   └── popup/
│       ├── main.ts              # Popup TypeScript 入口
│       └── popup.css            # Popup 样式
├── scripts/
│   ├── capture-zhihu-snapshot.mjs # 本地知乎原始最小快照采集
│   └── lib/                     # 快照转换纯函数及测试
├── docs/
│   ├── blacklist-spec.md        # 作者黑名单功能规格与交付状态
│   └── zhihu-browser-snapshots.md
├── vite.config.ts               # Vite 多入口构建配置
├── tsconfig.json
└── dist/                        # 构建产物，不要手动编辑
```

## 常用命令

```bash
npm install
npm run typecheck
npm run build
npm run dev
npm run snapshot:zhihu
```

- `npm run typecheck`：执行 TypeScript 类型检查。
- `npm run build`：先进行类型检查，再构建到 `dist/`。
- `npm run dev`：监听源码变化并持续重新构建。
- `npm run snapshot:zhihu`：显式连接现有 Chrome，生成包含真实作者标识的本地最小知乎快照。

每次修改代码后，至少运行：

```bash
npm run build
```

## 功能规格与交付状态

- `docs/blacklist-spec.md` 是作者黑名单功能的产品行为、技术决策、需求状态和验收标准的事实来源。
- Developer 和 Reviewer 开始相关工作前都必须读取该规格，并按需求 ID 明确本次范围；本文档与规格冲突时，应先报告冲突并由用户确认，不得自行选择行为。
- Developer 只实现规格中标记为 `READY_FOR_DEV` 的需求，不得自行实现 `DECISION_PENDING` 或 `DEFERRED` 项，也不得自行把需求标记为 `DELIVERED`。
- Developer 完成实现和自动化检查后，将需求交给 Reviewer；审查期间可由主协调者标记为 `IN_REVIEW`。
- Reviewer 必须按需求 ID 和验收标准独立审查代码、测试、构建、Manifest、安全性及相关快照证据。Reviewer `PASS` 后，主协调者即可将对应需求更新为 `DELIVERED`；真实浏览器验收不再是该状态的前置条件。
- 真实浏览器验收由用户负责。用户反馈失败时，应新增或更新对应 `BUG-*`/替代需求并标为 `READY_FOR_DEV`；原需求保留 `DELIVERED` 以记录当时已通过开发与审查，除非其产品行为已被新需求取代，此时标记为 `SUPERSEDED`。
- 未经用户明确授权，Developer 和 Reviewer 不得自行操作浏览器；未执行的浏览器检查必须明确报告为“用户验收待进行”，但不妨碍 Reviewer 基于其职责范围给出 `PASS`。
- 新增或变更需求时应更新规格版本、状态和交付记录；已交付但被替代的行为标记为 `SUPERSEDED`，不得删除历史决策。

## Chrome 中的测试方式

1. 执行 `npm run build`。
2. 打开 `chrome://extensions`。
3. 开启开发者模式。
4. 加载或重新加载 `dist/` 目录，而不是项目根目录。
5. 刷新知乎首页。
6. 点击卡片右上角的 `×`，验证标签抽屉、无图存储记录，以及作者卡片和评论隐藏行为。

修改 Manifest 或内容脚本后，必须同时重新加载扩展并刷新目标网页。

### Chrome DevTools 连接约定

Pi 必须通过用户级配置 `~/.pi/agent/pi-chrome-devtools.json` 禁止 Chrome DevTools 自动启动浏览器：

```json
{
  "browser": {
    "autoLaunch": false
  }
}
```

配置后直接运行 `pi`；不得再使用已弃用的 `PI_CHROME_DEVTOOLS_AUTO_LAUNCH` 环境变量。浏览器检查必须遵守：

- 只连接用户已经运行且已登录的 Chrome，不得启动新的 Chrome、Chromium 或 Chrome for Testing 实例。
- 不得创建临时浏览器 Profile，也不得通过 `bash`、`open`、`nohup` 或其他子进程绕过限制启动浏览器。
- 优先使用 Chrome DevTools 工具列出现有页面，不要为了发现页面而调用导航工具。
- `/json/version`、`/json/list` 等 HTTP 发现接口返回 `404`，只表示该发现接口不可用，不能据此认定 CDP 不可用。
- HTTP 发现接口返回 `404` 时，应读取现有 Chrome Profile 中的 `DevToolsActivePort`，连接其中记录的 Browser WebSocket。
- 通过 Browser WebSocket 调用 `Target.getTargets` 查找现有标签页，再使用 `Target.attachToTarget` 和带 `sessionId` 的 CDP 命令（如 `Runtime.evaluate`）检查页面。
- 同一次用户授权的浏览器检查必须优先建立一个长生命周期的 Browser WebSocket，并复用同一个目标页 `sessionId` 完成全部已规划检查；不得为每个查询分别启动短命进程、重复连接或重复 attach，避免反复触发 Chrome 的 “Allow” 提示。
- 应先汇总需要执行的只读检查，再在单个 CDP 会话中批量完成。只有连接意外断开或目标会话失效时才允许重连；重连前应告知用户可能再次触发 Chrome 授权提示。
- 仅当常规发现和 Browser WebSocket 直连都失败时，才能判定 CDP 不可用；此时应报告准确错误，不得回退到新浏览器实例。
- 除非用户明确要求，不得导航、刷新或关闭用户已有标签页。
- 浏览器验证报告必须区分真实观察结果与源码推断，不得把未执行的检查描述为已验证。

### 本地知乎快照规则

- 涉及知乎 DOM、选择器、字段解析或成员接口契约的开发与审查，必须先读取 `.pi/browser-snapshots-local/zhihu/latest.json` 及其指向的快照，再考虑使用 CDP 检查真实页面。
- Developer 应以源码、测试和最新快照作为首轮实现依据；Reviewer 必须独立检查最新快照及相关代码，不能只依赖 Developer 的摘要或结论。
- 快照不存在、格式无效、缺少相关样本，或与当前源码/线上行为冲突时，应明确报告局限；只有任务确实需要且用户允许浏览器检查时，才使用现有 Chrome 补充证据。
- 快照包含真实个人数据。终端输出和开发、审查报告只能给出字段、数量和验证结论，不得复述作者名、成员 hash、`url_token` 等真实值。
- 仅在明确需要更新本地证据时运行 `npm run snapshot:zhihu`；脚本不得自动随构建或测试执行。
- 快照只写入 `.pi/browser-snapshots-local/zhihu/`，该目录必须保持 Git 忽略，不得强制提交真实采集数据。
- 快照包含真实作者名、成员 hash、资料页 `url_token` 等个人数据；不得提交、分享、上传、附加到 issue，或用于本机开发以外的任何场景；不再需要时必须删除。
- 只提交采集脚本、纯函数测试、配置和文档；采集范围必须保持用途限定和严格白名单，不得恢复标题、内容/问题 ID、跟踪数据、完整 HTML、Cookie、请求头、Storage、通知、React 内部数据、头像 URL 或无关信息流数据。
- 采集只能连接现有 Chrome 和精确 URL `https://www.zhihu.com/` 的唯一已有标签页，不得导航、刷新、关闭页面或启动浏览器。
- 快照是采集时的本地开发证据，不代表当前生产 DOM，不能替代用户最终浏览器验收。详细说明见 `docs/zhihu-browser-snapshots.md`。

## 构建约束

- `public/manifest.json` 是 Manifest 源文件；`dist/manifest.json` 是自动生成的副本。
- 不要直接修改 `dist/` 中的任何文件。
- Manifest 直接引用 `assets/content.js`，因此内容脚本输出文件名必须保持稳定。
- 新增构建入口时，需要同步更新 `vite.config.ts`。
- `package.json` 和 `public/manifest.json` 的版本号应保持一致。

## Chrome Extension 规则

- 始终使用 Manifest V3，不得引入 Manifest V2 API。
- Popup 和其他扩展页面中不得使用内联脚本或内联事件处理器。
- 只申请功能实际需要的权限和站点访问范围。
- 当前功能只需要 `storage` 权限；不要无理由添加 `tabs`、`scripting`、`unlimitedStorage` 或 `<all_urls>`。
- Manifest 中引用的脚本、CSS 和图片必须真实存在于构建产物中。
- 内容脚本运行在 isolated world，但共享页面 DOM；Console 日志仍可在页面开发者工具中查看。

## 知乎内容脚本约定

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

- 保持 `strict` 类型检查通过。
- 不使用 `any`；为外部数据定义最小必要接口。
- 优先使用 `const`，仅在需要重新赋值时使用 `let`。
- 函数职责保持单一，DOM 查询和数据解析应便于独立调整。
- 使用 `async/await`，不要新增 `.then()` 链。
- 不使用 `eval()`、`new Function()` 或其他违反扩展 CSP 的实现。
- 不要依赖内容脚本中的全局可变状态保存持久数据；需要持久化时使用 `chrome.storage`。

## 自动化测试规则

- 纯函数和包含复杂分支的逻辑应编写单元测试。
- 简单的 DOM 接线代码可以通过构建检查和 Chrome 浏览器手动验证，不强制编写单元测试。
- 修复可复现的逻辑缺陷时，应优先补充能够覆盖该缺陷的回归测试。
- 涉及 `chrome.*` API、Manifest 注入、isolated world 或真实知乎 DOM 的行为，Developer 和 Reviewer 必须明确自动化证据的边界；真实浏览器结果由用户验收并反馈，不作为 Reviewer `PASS` 或需求标记 `DELIVERED` 的前置条件。
- 如果项目尚未配置测试框架，而本次修改按上述规则需要测试，应先提出最小化的测试方案，不要无说明地引入大型测试依赖。

## 完成修改前的检查清单

- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] `dist/manifest.json` 是合法 JSON
- [ ] Manifest 引用的文件都存在于 `dist/`
- [ ] Popup 仍能正常显示 `Hello`
- [ ] 知乎首页现有卡片和滚动后新增卡片都只有一个 `×`
- [ ] 点击 `×` 只打开标签抽屉且不会误触卡片跳转；赋予标签后才执行持久化和屏蔽
- [ ] 没有无必要新增 Chrome 权限
- [ ] 没有手动提交或修改 `dist/`、`node_modules/`
