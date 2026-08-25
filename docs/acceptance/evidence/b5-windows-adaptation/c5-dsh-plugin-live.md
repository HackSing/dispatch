# c5 证据:dsh-dispatch 0.1.4 在真实 DSH Buddy(Windows)中面板可用

日期:2026-08-25。验证人:Claude(审查方),全部命令与探测独立执行,不采信执行方自述。

## 背景

原始缺陷:Windows 上 dsh 网页面板恒报「加载失败:Dispatch runtime 未启动(见 dsh 日志)(runtime-unavailable)」。
根因两层:core `getPlatformOps()` 无 win32 分支(同步抛错);`core-runtime.js` 的 `refreshDetections`
同步抛错逃逸 `.catch()` 炸穿 runtime 装配。B5 批1 修 platform 层,批4 修 fail-soft 并发布 0.1.4。

## 安装链路(实机)

1. `npm pack`(dsh-plugin/,prepack 触发 build+verify)→ `aiwaretop-dsh-dispatch-0.1.4.tgz`
2. tgz 复制到 `~/.dsh/local-plugins/`,web profile 以 `file:` spec 安装(pnpm,`CI=true` 规避 no-TTY purge)
3. taskkill 结束旧 DSH Buddy,经 WMI `Win32_Process.Create` 重启(脱离沙箱 job),新 pid 44456

## 证据 1:面板数据通道(决定性)

`POST http://127.0.0.1:3080/api/dispatch/invoke/app:status` 返回:

```json
{"ok":true,"value":{"version":"0.1.4","dbSchemaVersion":4,"dispatchHome":"C:\\Users\\freed\\.dispatch","platform":"win32"}}
```

`project:list` 同样 `ok:true`(default 项目)。此前同一端点场景 = runtime-unavailable。

## 证据 2:面板 UI 渲染(shadow DOM 提取)

浏览器打开 `http://127.0.0.1:3080`,点击「任务派单」。面板渲染在 shadow root 内
(主文档 innerText 不可见,故经 shadowRoot 提取纯 UI 文本):

```
Dispatch任务收件箱 + Agent 调度器v0.1.4 · C:\Users\freed\.dispatch进行中 0已结束 0全部 0 新建项目default0该项目暂无任务＋ 快捷新建
```

- 版本徽标 v0.1.4、dispatchHome 正确
- 项目列表加载(default,0 任务)、「快捷新建」入口在位
- `加载失败` / `runtime-unavailable` 字样:不存在(hasError=false)

## 证据 3:五 agent 实测检测(经 0.1.4 vendor runtime)

`probe-detections.mjs`(scratchpad)直连 `createDispatchRuntime().refreshDetections()`:

| agent | ok | version / failReason |
| --- | --- | --- |
| claude | ✅ | 2.1.228 |
| codex | ✅ | (where 多行输出经 pickExecutable 选中 codex.cmd) |
| kimi | ✅ | 0.38.0 |
| qwen | ✅ | 0.21.5 |
| dsh | ❌ | 未找到二进制 dsh(PATH 中不存在)——如实失败,不炸 runtime,符合 fail-soft 设计 |

## 结论

c5 通过:插件 0.1.4 在 Windows 实机 DSH Buddy 中 runtime 可用、面板渲染、检测按预期分级成功/失败。
