// vendor bundle 的入口:host 半所需 core/shared 运行时面(类型经 esbuild 剥除)。
// seed-vendor.mjs 以此文件为 bundle 入口;client 批次另行打包,不经此文件。
export * from '@core/paths';
export * from '@core/config';
export * from '@core/db';
export * from '@core/bootstrap';
export * from '@core/scheduler';
export * from '@core/executor';
export * from '@core/executor/locks';
export * from '@core/executor/follow-up';
export * from '@core/executor/cleanup';
export * from '@core/agents/generic-cli-adapter';
export * from '@core/agents/detection';
export * from '@core/agents/session';
export * from '@core/platform';
export * from '@core/task-edit';
export * from '@core/project-ops';
export * from '@core/archive/read';
export * from '@core/ui-state';
export { INVOKE_CHANNELS, EVENT_CHANNELS } from '@shared/ipc';
export { AGENT_IDS } from '@shared/types';
