# Pulse 0.3.0：Codex 云端接续

目标是用户手机截图中 Codex 的「云端」入口。已通过任务列表确认现有任务「查看云端数据」运行在云端，工作目录为 `/workspace`；当前项目仍位于本机 `T:\CodexWorkspace\钱`。本地文件不会自动同步，必须实际传入源码后才能在云端运行。

当前本地工具可以读取该云端任务，但没有向它附加本地文件的接口，也没有把当前聊天直接迁移至 Codex Cloud 的接口。先前打开普通 ChatGPT 网页的登录窗口不代表完成了目标云端的迁移。

## 将源码带入现有云端任务

在手机或桌面的 Codex「云端」中打开承接任务，使用该任务提供的附件入口选择 `Pulse-Trading-Demo-0.3.0-source.zip`。只有界面确认附件上传成功，且云端能实际读取、解压源码，才记录传输完成；若入口不接受 ZIP 或没有文件上传能力，改用下文的 GitHub 仓库流程。不能根据文件名出现在聊天里就认定工作区已有源码。

## 导入与验证

1. 确认当前确为 Codex 云端任务，且已实际收到源码附件或拉取了源码仓库。
2. 解压到该云端任务自己的工作目录，进入压缩包内的 `Pulse-Trading-Demo-0.3.0-source` 文件夹。
3. 使用 Node.js 24 与 pnpm 11.25.0。先检查云端任务的网络策略及其可用运行环境；公共行情不需要 OKX 密钥，AI 保持未配置。
4. 安装依赖并验证：`pnpm install --frozen-lockfile`、`pnpm test`、`pnpm build`、`node scripts/smoke.mjs`。已验收版本为 40 项测试；Windows EXE 检查只在 Windows x64 执行。
5. 运行 `node scripts/package-win.mjs --fingerprint`，源码指纹应为 `028d19f19f36c3148c8e2bf79d32be21b6365ad57d6582f10fba0b4d9b25cb7e`。验收记录和截图不纳入自引用源码指纹。
6. 按云端环境支持的端口预览方式启动网页版，验证现货与 USDT 永续均能自动扫描。依赖地址通常包括 npm 注册表；实际行情使用 `openapi.okx.com` HTTPS 和 `ws.okx.com` WSS 443，须按环境策略允许。
7. 返回云端实际文件路径、运行时版本、安装/测试/构建结果与行情可达性。任何未执行或被网络阻断的步骤应明确说明，不能把上传完成等同于运行完成。

## 保持项目约定

- 读取 README、执行计划与双Agent验收流程.md、docs/milestones.md；继续使用“里程碑检阅 → FAIL 交修复 → 重新检阅”的流程。
- 保留现货与 USDT 永续的独立账户及数据；该源码包不含本机账户数据库、密钥、用户 .env、依赖或 Windows 运行时。
- 永续仍为无杠杆虚拟积分模拟，价格为最新成交价，资金费、保证金和强平边界不变。
- 本次任务仅导入并验证项目，不额外增加产品功能、付费 AI 调用、真实下单或公开发布。

## 可发送给云端任务的指令

> 请将我附加的 Pulse 0.3.0 源码 ZIP 解压到当前云端工作目录，按 docs/GPT云端接续说明.md 安装依赖、核对源码指纹并完成测试和构建。保留现货/USDT永续切换及账户隔离，继续遵守双 Agent 验收约定。先报告云端真实文件路径和验证结果；未运行的步骤如实标明，不增加新功能。

## 创建可复用的 Codex Cloud 环境

官方流程为：将干净源码提交到用户可访问的 GitHub 仓库；在桌面或网页选择 `Work in > Cloud > Select environment > Create environment`，选择仓库并完成连接；让 Codex 准备和测试环境，审阅后 `Publish`，最后从已发布环境启动任务。建议个人项目使用私有仓库和私有环境。仓库和环境的创建、源码推送及云端运行都必须分别以实际结果确认。

此流程与往现有任务传入一个源码附件不同。不要把普通 ChatGPT Work 云端任务、原型环境配置工具或本地归档当成已经创建了正式 Codex Cloud 环境。云端工作区也不能代替源码版本管理或永久软件托管。

官方参考：[Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments)、[Codex environments](https://learn.chatgpt.com/docs/environments/modes)。
