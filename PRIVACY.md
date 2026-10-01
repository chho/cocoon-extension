# Cocoon Privacy Policy / 隐私政策

Last updated / 最后更新：2026-10-01

This policy describes Cocoon 0.4.3. Cocoon is a local-first author-based content filtering tool. The current version supports only the Zhihu home feed at `https://www.zhihu.com/`; support for other websites is not implied.

本政策适用于 Cocoon 0.4.3。Cocoon 是以本地存储为主、按作者过滤内容的工具。当前版本仅支持知乎首页 `https://www.zhihu.com/`，不代表已支持其他网站。

## 1. Data processed / 处理的数据

Cocoon reads author names, profile links, member identifiers, and content-related links on supported pages to identify authors and filter content. When you assign a tag, it stores the platform, author display name, stable identifier, optional member alias, tag association, block source, and first-blocked time locally. Tags contain text you provide. Imported backups can also supply author and tag records.

Cocoon reads identity and content references temporarily when needed for identity resolution and optional voter lookups. It does not maintain a browsing-history archive or save feed screenshots or content bodies. It stores your two optional Zhihu action preferences and a data-change notification locally. Temporary page counts and tab identifiers are stored for the browser session. Identity caches, voter results, and the current account identifier are processed in memory.

Cocoon 读取受支持页面上的作者名称、资料链接、成员标识及内容相关链接，用于识别作者和过滤内容。你赋予标签后，扩展在本机保存平台、作者显示名称、稳定标识、可选成员别名、标签关联、屏蔽来源和首次屏蔽时间。标签包含你填写的文字，导入备份也可以提供作者和标签记录。

扩展按需临时处理身份及内容标识，用于身份解析和可选的点赞者查询；不建立浏览历史档案，不保存信息流截图或正文。两项知乎操作偏好及数据变更通知在本机保存，页面计数和标签页标识保存在浏览器会话存储中。身份缓存、点赞者查询结果和当前账号标识在内存中处理。

## 2. Zhihu requests and credentials / 知乎请求与登录凭据

Cocoon may automatically query Zhihu member information to resolve author identities, including while filtering with an existing local blocklist. If you enable the voter option and submit a tag, it queries your current account and the content's voters or likers, then adds eligible authors to the local blocklist. These voters are not remotely blocked on Zhihu.

If you enable the account-level blocking option and submit a tag, Cocoon sends the directly selected author's identifier to Zhihu to update your signed-in account's real blocklist. Both options are off by default and remember saved choices. Submitting a tag authorizes the enabled actions without an additional confirmation.

Requests use your existing same-origin Zhihu session; the browser sends applicable cookies. Account-level blocking also temporarily reads the `xsrf`/`_xsrf` anti-forgery cookie and sends its value to Zhihu in a request header. Cocoon does not save this token in its blacklist database or exports. Zhihu receives request targets, applicable session credentials, and normal network connection information. Its handling of those requests is governed by [Zhihu's privacy policy](https://www.zhihu.com/term/privacy).

Cocoon 可能自动查询知乎成员信息以解析作者身份，包括使用已有本地列表过滤页面时。启用点赞者选项并提交标签后，扩展查询当前账号及内容的点赞者，将符合条件的作者加入本地屏蔽列表，不对这些点赞者执行知乎账号级拉黑。

启用账号级拉黑选项并提交标签后，扩展将直接选定的作者标识发送给知乎，修改你当前登录账号的真实黑名单。两个选项默认关闭并记忆保存后的选择；提交标签即授权当前启用的操作，不另行确认。

请求使用你已有的知乎同源登录会话，浏览器会携带适用 Cookie。账号级拉黑还临时读取 `xsrf`/`_xsrf` 防伪 Cookie，将其值作为请求头发送给知乎；扩展不把该令牌保存在黑名单数据库或导出文件中。知乎会收到请求目标、适用的会话凭据和正常网络连接信息，其处理受[知乎隐私政策](https://www.zhihu.com/term/privacy)约束。

## 3. Storage, sharing, and diagnostics / 存储、分享与诊断

Author and tag records are stored in extension-owned IndexedDB on your device. Preferences use Chrome's local extension storage. Legacy local blacklist data is validated and migrated into IndexedDB; successful migration removes the legacy copy.

The current version has no developer-operated data server, cloud synchronization, advertising, analytics, or telemetry. It does not upload your full local blocklist to the developer. Data is not sold, used for unrelated purposes, or used for creditworthiness or lending decisions. Necessary Zhihu requests described above are not an upload to a Cocoon server.

Cocoon may write local diagnostic errors, counts, and timing information to the developer console; these logs are not automatically uploaded. If you choose to contact us through GitHub, GitHub processes that submission under its own privacy policy. Public issues can be read by others: do not include personal records, cookies, credentials, or unredacted exports, screenshots, or logs.

作者与标签记录保存在本机扩展自有 IndexedDB，偏好保存在 Chrome 本地扩展存储。旧版本地黑名单经过校验后迁移到 IndexedDB，成功迁移后删除旧副本。

当前版本没有开发者运营的数据服务器、云同步、广告、分析追踪或遥测，不会向开发者上传完整本地列表。数据不出售，不用于无关用途，也不用于信用或贷款判断。上述必要的知乎请求不属于向 Cocoon 服务器上传数据。

扩展可能在本机开发者 Console 输出诊断错误、数量和耗时信息，不自动上传日志。如果你通过 GitHub 联系我们，GitHub 会根据其隐私政策处理提交内容。公开 Issue 可被他人查看，请勿提交个人记录、Cookie、凭据或未脱敏的导出文件、截图及日志。

## 4. Retention, deletion, and backups / 保留、删除与备份

You can remove local author records and manage tags through the popup or management page. Uninstalling clears extension-managed local data. Neither local removal nor uninstalling reverses completed Zhihu account-level blocks; manage those on Zhihu.

Exports are user-initiated JSON files containing author and tag data, without password protection. Uninstalling does not delete downloaded backups; you are responsible for securing and deleting them.

Imports temporarily stage records on your device for validation and atomic commit. Successful finalization or explicit cancellation cleans the corresponding staged data. Interrupted sessions expire after 24 hours, but expired staging is cleaned when a later import begins, not by a guaranteed timed deletion. Removing an active author record does not independently purge interrupted import staging.

你可以通过 Popup 或管理页移除本地作者记录、维护标签。卸载扩展会清除扩展管理的本地数据；本地解除或卸载都不会撤销已完成的知乎账号级拉黑，请在知乎自行管理远程黑名单。

导出由你主动发起，JSON 文件包含作者和标签数据，不带密码保护。卸载不会删除已经下载的备份，你需要自行保管和删除这些文件。

导入会在本机暂存记录，以完成校验和原子提交；成功完成或显式取消时清理相应暂存。中断的会话在 24 小时后失效，但过期暂存在下次开始导入时才清理，不保证定时物理删除。移除当前作者记录不会单独清除中断导入的暂存副本。

## 5. Changes and contact / 变更与联系

We will update this policy when data practices change. For product or privacy questions, contact the maintainer through [Cocoon GitHub Issues](https://github.com/chho/cocoon-extension/issues). Please describe privacy concerns without posting sensitive data publicly.

数据处理方式变化时，我们会更新本政策。产品或隐私问题请通过 [Cocoon GitHub Issues](https://github.com/chho/cocoon-extension/issues) 联系维护者，请勿在公开沟通中附上敏感数据。

Source code / 项目源码：[github.com/chho/cocoon-extension](https://github.com/chho/cocoon-extension)
