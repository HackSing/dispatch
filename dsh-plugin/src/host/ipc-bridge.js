/**
 * The 28-channel invoke bridge: the plugin's port of src/shell/ipc-handlers.ts.
 * 通道语义与独立 app 逐一对齐;仅 Electron 专属通道在此降级(not_supported/no-op),
 * client 半对降级通道有对应的替代交互。通道白名单来自 core 的 INVOKE_CHANNELS。
 *
 * @module dsh-dispatch/host/ipc-bridge
 */
import { basename } from 'node:path';
import * as core from '../../vendor/dispatch-core.mjs';

const NOT_SUPPORTED = ['task:open-session-terminal', 'task:open-archive', 'project:pick-directory'];

/**
 * @param {{
 *   runtime: { ctx: object, execution: object, sessions: object, refreshDetections: () => Promise<unknown> } | null,
 *   broadcast: (channel: string, payload: unknown) => void,
 * }} parts
 * @returns {(channel: string, payload: unknown) => Promise<unknown>} the invoke entry.
 */
export function createIpcBridge({ runtime, broadcast }) {
  return async function invoke(channel, payload) {
    if (!core.INVOKE_CHANNELS.includes(channel)) {
      throw httpError('unknown-channel', `未知通道: ${channel}`);
    }
    if (!runtime) {
      throw httpError('runtime-unavailable', 'Dispatch runtime 未启动(见 dsh 日志)');
    }
    if (NOT_SUPPORTED.includes(channel)) {
      throw httpError('not_supported', `通道 ${channel} 依赖桌面壳能力,插件形态不支持`);
    }
    return handle(runtime, broadcast, channel, payload);
  };
}

/** 与 ipc-handlers.ts 的 handler 一一对应;body 形状即 InvokeMap[C]['req'] */
async function handle(rt, broadcast, channel, p) {
  const { ctx, execution, sessions } = rt;
  switch (channel) {
    case 'app:status':
      return {
        version: ctx.version,
        dbSchemaVersion: core.SCHEMA_VERSION,
        dispatchHome: ctx.paths.home,
        platform: process.platform,
      };
    case 'app:hotkey-status': {
      // dsh-buddy 壳注册成功时在子进程 env 注入状态(lib/global-hotkey.js
      // hotkeyChildEnv);无壳/旧壳/注册失败时诚实返回未注册
      const registered = process.env.DSH_BUDDY_HOTKEY_REGISTERED === '1';
      const accelerator = process.env.DSH_BUDDY_HOTKEY_ACCELERATOR || ctx.config.hotkey;
      return { accelerator, registered };
    }
    case 'capture:hide':
      // client 模态自管理,此通道仅为兼容 CaptureApp 调用面
      return undefined;
    case 'task:create': {
      if (!p.text.trim()) throw new Error('任务文本不能为空');
      const task = ctx.tasks.create({ text: p.text, projectId: p.projectId, agent: p.agent, subAgent: p.subAgent, triggerType: p.triggerType, triggerAt: p.triggerAt });
      execution.maybeRunImmediate(task);
      return task;
    }
    case 'task:list':
      return ctx.tasks.list();
    case 'task:update': {
      const { id, ...patch } = p;
      return core.editTask(ctx.tasks, id, patch);
    }
    case 'task:toggle-todo':
      return core.toggleTodo(ctx.tasks, p.id);
    case 'task:cancel':
      return core.cancelScheduled(ctx.tasks, p.id);
    case 'task:run-now': {
      const task = mustTask(ctx, p.id);
      if (task.status !== 'scheduled') throw new Error(`任务状态 ${task.status} 不可立即执行`);
      if (!task.agent) throw new Error('任务未指定 agent,请先编辑补充');
      execution.enqueue(task.id);
      return task;
    }
    case 'task:rerun': {
      const task = await core.rerunFailedTask({ tasks: ctx.tasks, projects: ctx.projects }, p.id);
      execution.maybeRunImmediate(task);
      return task;
    }
    case 'task:abandon':
      core.abandonTask(ctx.tasks, p.id);
      return core.cleanupTaskWorkspace({ tasks: ctx.tasks, projects: ctx.projects }, p.id);
    case 'task:cleanup-worktree':
      return core.cleanupTaskWorkspace({ tasks: ctx.tasks, projects: ctx.projects }, p.id);
    case 'task:interrupt': {
      const task = mustTask(ctx, p.id);
      if (task.status !== 'running') throw new Error(`任务状态 ${task.status} 不可中断`);
      if (sessions.workingDirOf(p.id)) throw new Error('面板会话请在面板内终止或放弃');
      if (!execution.interrupt(p.id)) throw new Error('当前阶段不可中断(可能正在合并),稍候再试');
      return undefined;
    }
    case 'task:delete': {
      const task = mustTask(ctx, p.id);
      // 删行不走 TaskStore.onChange(避免误发失败通知),完成后显式广播触发列表刷新
      await core.deleteTask({ tasks: ctx.tasks, projects: ctx.projects }, p.id);
      broadcast('task:changed', { taskId: p.id, status: task.status });
      return undefined;
    }
    case 'task:follow-up-start':
      return sessions.start(p.parentId);
    case 'task:follow-up-send':
      sessions.send(p.id, p.text);
      return undefined;
    case 'task:follow-up-finish':
      return sessions.finish(p.id);
    case 'task:follow-up-abandon':
      return sessions.abandon(p.id);
    case 'task:retry-merge': {
      const task = mustTask(ctx, p.id);
      if (task.status !== 'awaiting_merge' && task.status !== 'conflict') {
        throw new Error(`任务状态 ${task.status} 不可重试合并`);
      }
      // 契约:立即返回当前任务,合并异步进行,进展经 task:changed 广播
      execution.retryMerge(p.id);
      return task;
    }
    case 'task:archive':
      return core.readTaskArchive(mustTask(ctx, p.id).archiveDir);
    case 'agent:capabilities': {
      const result = {};
      for (const id of core.AGENT_IDS) {
        const cfg = ctx.config.agents[id];
        result[id] = {
          followUp: cfg ? core.followUpTransport(cfg) !== null : false,
          terminal: cfg ? core.supportsTerminalResume(cfg) : false,
        };
      }
      return result;
    }
    case 'project:list':
      return ctx.projects.list();
    case 'project:create': {
      const path = p.path.trim();
      if (!path) throw new Error('项目路径不能为空');
      const existing = ctx.projects.list().find((item) => item.path === path);
      if (existing) return existing;
      return ctx.projects.create({ name: p.name?.trim() || basename(path), path });
    }
    case 'agent:detections':
      return ctx.detections.list();
    case 'agent:refresh':
      return rt.refreshDetections();
    case 'ui-state:get':
      return core.loadUiState(ctx.paths.uiStateFile);
    case 'ui-state:set':
      return core.saveUiState(ctx.paths.uiStateFile, p);
    default:
      throw httpError('unknown-channel', `通道未实现: ${channel}`);
  }
}

function mustTask(ctx, id) {
  const task = ctx.tasks.get(id);
  if (!task) throw new Error(`任务不存在: ${id}`);
  return task;
}

function httpError(code, message) {
  return Object.assign(new Error(message), { code });
}
