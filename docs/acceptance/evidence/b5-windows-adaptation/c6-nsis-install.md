# c6 证据:NSIS 安装包 Windows 实机安装 + 启动冒烟

日期:2026-08-25。验证人:Claude(审查方)。用户已在会话中批准「安装并验证」,并确认保留安装。

## 产物

`npm run pack:win`(electron-vite build && electron-builder --win,批3)exit 0,产出
`dist/Dispatch Setup 0.1.0.exe`(97,232,567 字节);dist/ 已确认在 .gitignore 内,不入库。

## 安装(实机)

```
Start-Process "dist\Dispatch Setup 0.1.0.exe" -ArgumentList '/S' → exit code 0
```

安装位置:`C:\Users\freed\AppData\Local\Programs\Dispatch\Dispatch.exe`(210,149,888 字节,per-user)。

## 启动冒烟(隔离 DISPATCH_HOME)

真实 `~/.dispatch` 正被 dsh 插件 runtime 使用,冒烟以隔离 home 启动避免双调度器竞争:

- `DISPATCH_HOME=<scratchpad>\nsis-smoke-home` 启动安装版 Dispatch.exe,pid 52708
- 12 秒后进程存活(`Get-Process` 确认)
- 隔离 home 被完整初始化:`dispatch.db`(+ -shm/-wal,SQLite WAL 活跃 → better-sqlite3
  原生模块在安装版 Electron ABI 下加载成功)、`config.json`、`ui-state.json`、
  `archives/ logs/ prompts/ reports/ worktrees/`
- `logs/main.log` 关键行:
  - `Dispatch 0.1.0 启动,home=<隔离目录>`
  - `崩溃恢复完成: interrupted=0 reattached=0 missedRun=0 missedSkipped=0 awaitingMerge=0`
  - `default 项目已创建: C:\Users\freed\Dispatch\default`
  - 1 条 warn:`全局快捷键 CommandOrControl+Shift+Space 注册失败,可能被其他应用占用`
    ——本机 dsh 常驻已占用该快捷键,预期内,非缺陷

## 清理

`taskkill /PID 52708 /T /F` 终止冒烟进程树(5 个进程全部 SUCCESS),确认无残留
Dispatch 进程。应用按用户要求保留安装。

注:冒烟启动创建了 `C:\Users\freed\Dispatch\default`(default 项目目录的固定路径,
与隔离 home 无关的产品既有行为);目录创建为幂等操作,不影响真实实例数据。

## 结论

c6 通过:NSIS 包可静默安装、安装版应用在 Windows 上正常启动并完成 core 初始化(含原生模块)。
