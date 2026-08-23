# 知乎浏览器快照缓存

## 用途

该工具从用户已经运行且登录的 Chrome 中，采集少量知乎首页卡片结构，供 Cocoon 开发时核对选择器、字段和用户 ID 接口契约。快照是项目本地开发证据，不是当前线上 DOM 永远有效的证明，也不能代替发布前的最终浏览器验证。

## 使用

1. 在现有 Chrome 中保持且仅保持一个 URL 严格为 `https://www.zhihu.com/` 的已加载标签页。
2. 确保用户已在 `127.0.0.1:9223` 启动并登录需要连接的 Chrome，且该端口的 `/json/version` 可返回 Browser WebSocket URL。
3. 在项目根目录显式执行：

```bash
npm run snapshot:zhihu
```

项目默认连接本机 Chrome DevTools 端口 `9223`：

```text
http://127.0.0.1:9223/json/version
```

如现有 Chrome 使用其他端口，可设置 `COCOON_CHROME_DEVTOOLS_PORT`。如必须改为读取某个现有 Profile 的 `DevToolsActivePort` 文件，可设置 `COCOON_CHROME_DEVTOOLS_ACTIVE_PORT`；该文件覆盖端口环境变量。默认最多采集 3 张回答和 3 篇文章；可用 `COCOON_ZHIHU_SNAPSHOT_LIMIT=1` 至 `10` 调整。

默认情况下，脚本只通过本机发现端点取得并直连现有 Browser WebSocket；设置 `COCOON_CHROME_DEVTOOLS_ACTIVE_PORT` 时则从指定文件读取同一连接信息。连接后，脚本只在唯一精确匹配的标签页上调用 `Target.attachToTarget`、`Page.getFrameTree`、`Page.createIsolatedWorld` 和会话级 `Runtime.evaluate`。采集函数在任何 DOM 查询前核对精确 URL，并在每次成员接口请求前再次核对；隔离执行上下文共享只读 DOM，但不受页面覆写的 JavaScript 全局对象影响。脚本不会启动浏览器、创建 Profile、导航、刷新、修改 DOM 或关闭页面。

## 输出

本地输出严格位于：

```text
.pi/browser-snapshots-local/zhihu/
```

每次成功采集会通过随机排他临时目录原子写入一个带时间戳的目录及 `latest.json` 指针。缓存目录权限为 `0700`，文件权限为 `0600`。目录整体必须保持 Git 忽略，不得强制加入版本控制。新 schema 的快照和 latest 指针明确标记 `localRaw: true` 与 `containsPersonalData: true`。

## 数据与隐私边界

本地快照不进行占位符替换，保留当前开发确实需要的真实值：作者名、`author_member_hash_id`、已有资料页的 `url_token`，以及同源成员接口 `/api/v4/members/<author_member_hash_id>` 的状态和最小响应 `url_token`。`data-zop` 只重建所需的作者名/type 字段；`data-za-extra-module` 只重建成员 hash/type 契约。HTML 只保留白名单结构标签、类名及所需的 `class`、`data-zop`、`data-za-extra-module`、同源资料页 `href` 属性。

不会采集或保存标题、内容/问题 ID、跟踪 blob、宽泛原始属性、完整页面 HTML、Cookie、请求头、Web Storage、通知、React 内部数据、头像 URL或无关信息流数据。浏览器返回结果在写入前必须通过严格固定键、类型、长度、数组、计数和递归结构白名单验证。

快照包含真实作者标识和个人数据。绝对不要提交、分享、上传、附加到 issue，或用于本机开发以外的任何场景；不再需要时立即删除整个本地快照目录。Git 忽略规则是强制安全边界，不能移除。

旧版已脱敏快照可以继续保留，但不能据此误判新快照为脱敏数据。

## 限制

- 仅采集当前已渲染且能识别为回答或文章的少量卡片；某一类型可能为零。
- 页面必须已有且 URL 精确匹配；没有或存在多个匹配标签页时会失败，不会替用户改变浏览器状态。
- 知乎 DOM 与接口可能变化。快照只能说明采集时观察到的结构，修改选择器前仍应检查真实页面，完成功能后仍需浏览器验证。
