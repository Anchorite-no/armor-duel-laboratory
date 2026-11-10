# 装甲对决 · 实验室

装甲对决是一个 DeepSeek Harness（DSH）插件。你可以用键鼠操纵机甲，也可以用 JavaScript 编写只看战场画面的机器人，让两份脚本在同一套参数下对战。

## 安装

目前的构建面向 Windows x64，需要 Node.js 24+ 和 DSH Desktop 0.2.2-rc.1。在仓库根目录运行：

```powershell
npm ci --ignore-scripts
npm run build
$pluginBundle = (Resolve-Path -LiteralPath ./bundle).Path.Replace('\', '/')
dsh plugin --profile desktop add "link:$pluginBundle" --ignore-scripts --offline
```

如果 `dsh` 不在 PATH 中，可使用 DSH 安装目录下的 `resources/runtime/cli/bin/dsh.cmd` 执行最后一条命令。安装后启动 DSH，在侧栏打开「实验室」。如果 DSH 正在运行，可从系统托盘退出再打开以加载插件。

## 对局

在房间里为红蓝两方各选一个控制者。支持键鼠对脚本，或两个脚本自动对战。同局共用生命值、攻击力、功率和射速。勾选「录制本局」可保存 MP4 和裁判记录。

- WASD 移动，鼠标瞄准，左键或空格开火。按住右键可启用辅助瞄准和热量保护。
- Q／E 切换逆／顺时针旋转，X 停止旋转。
- 正式战斗限时 60 秒。击毁对手即获胜，超时比较剩余生命值。

## 投稿与对战

在 fork 中新增 `bots/<脚本名>/bot.js` 和说明文件，提交 Pull Request。房主审阅后可导入脚本，为红蓝席位分别选择参赛作品。具体步骤见 [参赛脚本投稿](bots/README.md)。

## 脚本接口

脚本是支持顶层 `await` 的 JavaScript。动态观测为完整战场 JPEG，脚本可以解码像素并自行决定动作。

| 接口 | 用途 |
| --- | --- |
| `lab.side` | 当前席位，`red` 或 `blue` |
| `await lab.observe()` | 获取 JPEG 及图像传输序号 |
| `lab.pixels(observation)` | 解码为包含宽、高和 RGB 字节数组的对象 |
| `await lab.act(action)` | 提交移动、旋转和瞄准，返回 JPEG 观测 |
| `await lab.fire()` | 请求单发，返回 JPEG 观测 |
| `await lab.cancel()` | 取消当前动作 |
| `await lab.sleep(ms)`、`await lab.log(value)` | 等待和记录本席日志 |

```js
const observation = await lab.observe();
const { width, height } = lab.pixels(observation);
await lab.log(`${lab.side} ${width}×${height}`);
await lab.act({
  moveX: 0, moveY: 0, spin: 0,
  aimX: 0.5, aimY: 0.5, durationMs: 100
});
await lab.cancel();
```

`moveX`、`moveY` 和 `spin` 接受 -1 到 1，正值分别表示向右、向下和顺时针。`aimX` 和 `aimY` 是从场地左上角起算的 0 到 1 归一化坐标，场地区域不含顶部 HUD。`durationMs` 为 1 到 500 的整数。调用应顺序等待。

内置全知传统 AI 使用宿主的完整状态，适合作为陪练。社区脚本通过同一视觉接口对战。更多细节见 [视觉观测契约](docs/participant-observation-contract.md)。

## 开发

`npm run build` 生成 `dist/` 和可链接的 `bundle/`。`npm run verify` 执行类型检查、自动化测试、构建和 DSH 插件生命周期验证。生命周期验证需要本机 DSH 安装归档，也可通过 `DSH_ASAR` 指定。

对局录像、脚本库和本地参赛工作区保存在 `.local/`。提交前检查 `git status`，只提交源码、合成测试和准备公开的作品。
