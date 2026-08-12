# AGENTS.md

## 项目概述

Cocoon 是一个使用 TypeScript、Vite 和 Chrome Manifest V3 开发的浏览器扩展。

当前功能：

- 点击扩展图标，Popup 显示 `Hello`。
- 进入知乎首页 `https://www.zhihu.com/` 后，为每张内容信息流卡片添加一个极简 `×` 按钮。
- 点击 `×` 时不移除卡片，只在页面 DevTools Console 中输出卡片作者：

```text
[Cocoon] 卡片作者：作者名
```

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
```

- `npm run typecheck`：执行 TypeScript 类型检查。
- `npm run build`：先进行类型检查，再构建到 `dist/`。
- `npm run dev`：监听源码变化并持续重新构建。

每次修改代码后，至少运行：

```bash
npm run build
```

## Chrome 中的测试方式

1. 执行 `npm run build`。
2. 打开 `chrome://extensions`。
3. 开启开发者模式。
4. 加载或重新加载 `dist/` 目录，而不是项目根目录。
5. 刷新知乎首页。
6. 打开页面 DevTools Console，点击卡片右上角的 `×` 验证作者输出。

修改 Manifest 或内容脚本后，必须同时重新加载扩展并刷新目标网页。

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
- 当前功能不需要额外 `permissions`；不要无理由添加 `tabs`、`scripting` 或 `<all_urls>`。
- Manifest 中引用的脚本、CSS 和图片必须真实存在于构建产物中。
- 内容脚本运行在 isolated world，但共享页面 DOM；Console 日志仍可在页面开发者工具中查看。

## 知乎内容脚本约定

当前依赖的知乎 DOM 特征：

- 卡片：`.TopstoryItem`
- 内容节点：`.ContentItem[data-zop]`
- 作者优先来自 `data-zop` JSON 的 `authorName`
- 作者后备选择器：`.AuthorInfo-name, .UserLink-link`

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

## 完成修改前的检查清单

- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] `dist/manifest.json` 是合法 JSON
- [ ] Manifest 引用的文件都存在于 `dist/`
- [ ] Popup 仍能正常显示 `Hello`
- [ ] 知乎首页现有卡片和滚动后新增卡片都只有一个 `×`
- [ ] 点击按钮能输出正确作者且不会误触卡片跳转
- [ ] 没有无必要新增 Chrome 权限
- [ ] 没有手动提交或修改 `dist/`、`node_modules/`
