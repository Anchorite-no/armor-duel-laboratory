# 参赛脚本投稿

在 fork 中新增 `bots/<脚本名>/bot.js` 和同目录的 `README.md`，然后发起 Pull Request。目录名用小写英文、数字和连字符。说明里写明脚本显示名、作者、策略和预期行为。请仅提交自己有权分享的代码，不附带录像、日志、模型笔记、安装包或凭据。

脚本运行在实验室提供的异步 JavaScript 环境中。通过 `lab.observe()` 获取 JPEG，使用 `lab.pixels(observation)` 解码像素，再用 `lab.act()` 提交移动、旋转和瞄准。`lab.fire()` 请求单发。完整接口见 [脚本接口](../README.md#脚本接口)。参赛脚本的动态输入为画面，应通过该接口闭环操作。

房主审阅源码后，可退出 DSH（使用系统托盘的「退出」），从仓库根目录导入脚本：

```powershell
node --import tsx scripts/import-bot.ts bots/my-bot/bot.js '显示名称'
```

把 `my-bot` 换成投稿目录名。该命令检查语法后保存到 `.local/scripts.json`。重新打开 DSH 后，可为红蓝席位各选一个脚本，在相同参数下观战或录制。运行器限制文件和进程访问，网络不具备完整的系统级隔离，请先审核准备运行的投稿。
