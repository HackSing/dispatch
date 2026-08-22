# TODO

条目格式:`- [ ] 事项(owner,YYYY-MM-DD)`;完成后改为 `- [x]` 并保留在「已完成」。

## 待办

### B4 可见性(下一批次,见 docs/dev-plan.md §4)
- [ ] 日报生成(21:00 定时 + 手动,`daily_report_notify` 开关)
- [ ] follow_up 收件箱(扫描归档聚合,一键转正式任务)
- [ ] 清理策略兜底:failed/conflict 残留超 14 天批量提示清理
- [ ] 设置页(快捷键/并发/超时/agent 参数/项目编辑删除,core 层 project delete 已备)
- [ ] TaskArchive 契约扩 reviews 字段,详情页内联渲染审查报告(当前仅文件名探测 + 打开归档)
- [ ] 配置迁移方案:用户已有 config.json 吸收新默认值(当前靠手动同步)

### B5 Windows 适配
- [ ] platform 层 win32 实现(taskkill/where/快捷键默认值)、NSIS 打包、CI 矩阵

### 已知边角(修复前先读 docs/flows.md「已知边角」)
- [ ] conflict worktree 内 MERGE_HEAD 残留时重试合并 → failed,可检测并给更好提示
- [ ] missed_task_policy=skip 的瞬时 running 闪变(状态机无 scheduled→failed 直达边)
- [ ] 二次启动提示(托盘常驻应用的重启认知成本,dev 阶段易误以为已重启)
- [ ] dsh 安装后补校准(DEFAULT_AGENTS 占位待填,docs/agent-calibration.md)
- [ ] qwen 流式日志过滤器(可选,当前无头输出近乎静默)

## 已完成

- [x] B0~B3 全批次 + 工作流第一阶段 W1 + 清理闭环(2026-08-22,见 CHANGELOG)
