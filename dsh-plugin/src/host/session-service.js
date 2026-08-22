/**
 * Panel session service, plugin variant of the standalone app's
 * src/shell/session-service.ts: the session engine (FollowUpSession) lives in
 * core; this file only owns the active-session table and forwards engine
 * callbacks to an injected broadcaster instead of Electron windows.
 *
 * @module dsh-dispatch/host/session-service
 */
import { FollowUpSession } from '../../vendor/dispatch-core.mjs';

/**
 * @param {import('../../vendor/dispatch-core.mjs').ExecutorDeps} deps shared executor deps.
 * @param {(channel: 'task:session-event', payload: unknown) => void} broadcast event sink.
 * @param {{ error: (msg: string) => void }} logger diagnostics sink.
 */
export function createSessionService(deps, broadcast, logger) {
  /** @type {Map<string, import('../../vendor/dispatch-core.mjs').FollowUpSession>} relay task id → live session */
  const sessions = new Map();
  /** @type {Map<string, string>} parent task id → relay task id(同一任务不开第二个面板) */
  const byParent = new Map();

  function mustGet(taskId) {
    const session = sessions.get(taskId);
    if (!session) throw new Error('该任务没有活跃的面板会话');
    return session;
  }

  return {
    async start(parentId) {
      if (byParent.has(parentId)) throw new Error('该任务已有进行中的面板会话');
      const session = await FollowUpSession.start(deps, parentId, {
        onRoundStart: (task, round) =>
          broadcast('task:session-event', { taskId: task.id, kind: 'round-start', round }),
        onChunk: (taskId, text) => broadcast('task:session-event', { taskId, kind: 'chunk', text }),
        onRoundResult: (task, round, result) =>
          broadcast('task:session-event', { taskId: task.id, kind: 'round-result', round, result }),
        onClosed: (task, reason) => {
          sessions.delete(task.id);
          byParent.delete(parentId);
          broadcast('task:session-event', { taskId: task.id, kind: 'closed', reason });
        },
      });
      sessions.set(session.taskId, session);
      byParent.set(parentId, session.taskId);
      return deps.tasks.get(session.taskId);
    },

    /** 契约:同步校验后立即返回,轮次进展与失败均经 task:session-event 广播 */
    send(taskId, text) {
      const session = mustGet(taskId);
      if (!text.trim()) throw new Error('追问内容不能为空');
      if (!session.open) throw new Error('会话已关闭');
      if (session.busy) throw new Error('上一轮未结束,不可发送');
      // 轮次级失败(超时/进程退出/首轮模板渲染)已由引擎落任务终态并广播 closed,此处仅记录编排日志
      void session.sendTurn(text).catch((e) => logger.error(`会话 ${taskId} 轮次失败: ${e.message}`));
    },

    finish(taskId) {
      const session = mustGet(taskId);
      void session.finish().catch((e) => logger.error(`会话 ${taskId} 完成合并异常: ${e.message}`));
      return deps.tasks.get(taskId);
    },

    abandon(taskId) {
      const session = mustGet(taskId);
      void session.abandon().catch((e) => logger.error(`会话 ${taskId} 放弃异常: ${e.message}`));
      return deps.tasks.get(taskId);
    },

    /** 活跃会话的工作目录 */
    workingDirOf(taskId) {
      return sessions.get(taskId)?.workingDir ?? null;
    },

    get activeCount() {
      return sessions.size;
    },

    /** 卸载统一收口:杀传输,任务落 failed;5s 宽限由传输层保证 */
    async disposeAll(reason) {
      const pending = [...sessions.values()].map((s) =>
        s.dispose(reason).catch((e) => logger.error(`会话 ${s.taskId} 退出收口失败: ${e.message}`)),
      );
      await Promise.all(pending);
    },
  };
}
