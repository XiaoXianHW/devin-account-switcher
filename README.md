# Devin Account Switcher

一个 Manifest V3 的 Chrome 扩展：一次性导入多个 GitHub 账号，自动完成 Devin 的
「Continue with GitHub」登录，随后在**整页仪表盘**里一键来回切换、查看剩余额度、结束并永久删除会话。

移植自 VS Code 扩展 `vwdevin-switch`，把原本依赖 Node HTTP / 文件系统 / CDP 的逻辑改成了
浏览器里的 `fetch` + `chrome.cookies` + `chrome.scripting`。

## 功能

- **批量导入账号（两种模式）**：
  - **GitHub 登录**：每行 `邮箱----密码----TOTP密钥`（TOTP 可选，也兼容逗号/制表符分隔）。
  - **Devin 直登**：每行 `邮箱----密码`，直接用 Devin 邮箱密码登录（无需 TOTP）。
- **GitHub 登录 + Devin 自动登录**：复刻 OAuth（PKCE）流程，自动处理密码、2FA(TOTP)、
  授权同意页，拿到 Devin 会话 token。
- **一键刷新全部**：在「账号」标题右侧点「刷新全部」，批量刷新所有已登录账号的状态、额度与套餐。
- **登录方式与套餐展示**：每张卡片显示该账号是 GitHub 还是 Devin 直登，以及 Free / Pro / 已结束 套餐状态。
- **整页仪表盘 UI**：点扩展图标在新标签页打开铺满整页的暗色面板，含概览统计、账号搜索、
  账号卡片网格、会话侧栏。
- **账号列表**：卡片式展示邮箱、组织、登录状态、额度、API Key 就绪状态。
- **一键切换**：把选中账号的会话写入 `app.devin.ai` 的 `localStorage`，刷新页面即登录该账号。
- **额度展示**：读取 `billing/quota/usage` 的 `overage_balance`，并在概览里汇总。
- **会话永久删除**：调用官方 v3 接口 `DELETE /v3/organizations/{orgId}/sessions/{sessionId}`
  真正结束并删除会话（**不再降级为归档**）。该接口需要 Service API Key，插件会用账号的会话
  **自动创建**一个组织级 Service User（Admin 角色）并保存其 Key 复用；删除成功后本地隐藏该会话，
  以免它在列表里重现。

## 安装（加载已解压的扩展）

1. 解压发给你的 zip（或直接用本项目目录）。
2. 打开 `chrome://extensions`，右上角开启 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选择解压后的目录。
4. 固定工具栏上的扩展图标，**点一下图标即在新标签页打开整页面板**。

## 使用

1. 点 **导入账号**，粘贴账号（每行一个），点 **导入**。
2. 每张卡片点 **登录**：扩展会自动跑一遍 GitHub → Devin 登录，日志实时显示在卡片里。
3. 登录成功后按钮变成 **切换到此账号**，点一下即把当前浏览器的 Devin 登录态换成该账号。
4. 卡片上的 **📋** 打开会话侧栏，点 **🗑** 永久删除会话（首次会自动创建 API Key）；
   **↻** 重新登录刷新会话；**🗑** 从插件里移除账号。
5. 概览卡片里的 **刷新额度** 一键刷新所有已登录账号的额度。

## 安全说明

- 账号密码 / TOTP 密钥 / Devin 会话 token / 自动创建的 Service API Key 都保存在浏览器本地的
  `chrome.storage.local`（明文，仅本机，方便自动重登与调用 API），**不加密、不上传任何服务器**。
  这只是本地浏览器存储，不是安全的凭据保险库；介意的话可在用完后从插件里移除账号以清除。
- 自动创建的 Service User 会常驻在你的 Devin 组织里（默认 30 天过期），可随时在
  `设置 → Devin API → Service users` 里手动删除。
- Devin API 请求使用 `credentials:'omit'`，不会携带或干扰你当前浏览器里其它站点的 cookie。
- 登录前会清理 `github.com` 的 cookie 以保证登录的是目标账号——这会让你在浏览器里手动登录的
  GitHub 掉线，属正常现象。
- token / 密码 / TOTP 均不会打印到日志。

## 开发

```bash
npm install
npm run lint
```

目录结构：

```
manifest.json          # MV3 清单
background.js          # service worker：登录编排 / 切换 / 额度 / 会话 / API Key
dashboard.html/css/js  # 整页仪表盘 UI
lib/
  devin-login.js       # GitHub OAuth + Devin token 交换（fetch 版）
  devin-api.js         # 额度 / 会话列表 / Service Key 创建 / 会话删除
  totp.js              # TOTP（WebCrypto HMAC-SHA1）
  forms.js             # GitHub HTML 表单解析
  store.js             # chrome.storage.local 账号存储 + 导入解析
```
