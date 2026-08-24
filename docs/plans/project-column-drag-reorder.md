> 状态：已实施-仅追溯（代码已是真源，2026-08-23 核对）
<!-- docs-harness:plan-document/v1 -->

# 项目看板列拖拽排序(桌面端 + dsh 插件)

- 冻结合同：`sha256:e445e8ec7f3998404bb7e70dc9f06758de297547b568b543889f1ad1508b6c22`
- 关键符号：`project:reorder`、`ProjectStore.reorder`、`sort_order`、`ProjectColumn`

## 背景

Dispatch 看板列头的 grip 手柄(src/renderer/src/components/ProjectColumn.tsx)目前只是装饰图标,无任何拖拽逻辑;项目顺序由 ProjectStore.list() 的 ORDER BY created_at 固定,projects 表无排序字段,无法持久化自定义顺序。dsh 插件经 dsh-plugin/src/client/panel.tsx 直接复用桌面端 App/ProjectColumn,两端同源缺失。

## 目标

看板项目列支持拖拽排序并持久化,桌面端与 dsh 插件同一份 renderer 实现同时生效;插件 host 的 ipc-bridge 同步新增通道。

## 非目标

不做列内任务卡拖拽、不做跨列拖任务、不引入第三方 dnd 库(用原生 HTML5 DnD)、不改任务数据流。

## 成功标准

1) 拖动列头 grip 可将项目列拖到目标位置,松手后顺序立即更新;2) 重启应用后顺序保持;3) 桌面端与插件面板行为一致;4) project-store/db 模块聚焦测试通过。

## 执行范围

src/core/db(migrations.ts, project-store.ts)、src/shared/ipc.ts、src/shell/ipc-handlers.ts、src/renderer/src(App.tsx, components/ProjectColumn.tsx, styles.css)、dsh-plugin/src/host/ipc-bridge.js、tests(db/project-store 相关)。

## 执行内容

批次1 core 契约:migrations.ts 追加 v4 project-sort-order(ALTER TABLE projects ADD COLUMN sort_order INTEGER + 按 created_at 排名回填);ProjectStore.list 改 ORDER BY sort_order, created_at,create 赋 max(sort_order)+1,新增 reorder(ids) 事务化重排并 onChange;shared/ipc.ts 注册 project:reorder(req {ids:string[]} res void)。批次2 shell+renderer:ipc-handlers.ts 接 project:reorder;App.tsx 看板列实现原生 HTML5 DnD(仅 grip 手柄可拖拽),drop 时乐观重排并 invoke,失败回滚重拉;styles.css 加拖拽态样式。批次3 插件:dsh-plugin/src/host/ipc-bridge.js 增加 case 'project:reorder'(ctx.projects.reorder),client api-bridge 为通用透传无需改。每批完成跑受影响模块测试后进入下一批。

## 验收方案

1) vitest 聚焦运行 project-store/db 与 ipc 相关测试;2) npm run build(electron-vite)验证编译;3) 手动/脚本验证:排序后 project:list 返回新顺序、重启持久。插件层验证 host ipc-bridge 新 case 的单元测试(若 tests 目录存在对应测试)或聚焦运行插件既有测试集。

## 是否需要 Acceptance 资产闭环

```json
true
```

## Knowledge 影响

unchanged

## 约束

迁移只增不改;新增通道需同步进 INVOKE_CHANNELS 白名单;不新增第三方依赖。

## 风险与回滚

风险:既有库升级迁移回填顺序异常(回滚=删库重建 dev 库);DnD 与列内文本选择冲突(限定 grip 手柄触发拖拽规避)。回滚:迁移为新版本条目,代码回退即恢复 ORDER BY created_at 行为(多出的列无害)。

<!-- docs-harness:plan-governance:start -->
## 资产治理

- 关联验收：`docs/acceptance/project-column-drag-reorder.json`
- 需要 Acceptance：true
- Knowledge 影响：unchanged
<!-- docs-harness:plan-governance:end -->
