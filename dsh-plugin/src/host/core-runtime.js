/**
 * Dispatch core runtime for the host half: the plugin equivalent of the
 * standalone app's src/shell assembly (index.ts + execution.ts). All Electron
 * touchpoints are replaced by injected collaborators — broadcast instead of
 * window IPC, logger instead of electron-log, bundled prompts instead of
 * app.getAppPath(). Stores, scheduler, executor and recovery are the untouched
 * core from vendor/dispatch-core.mjs.
 *
 * @module dsh-dispatch/host/core-runtime
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../../vendor/dispatch-core.mjs';
import { createSessionService } from './session-service.js';

const PLUGIN_ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** 内置提示词模板:随包分发的 vendor 副本(用户可编辑真源仍在 ~/.dispatch/prompts) */
export const BUILTIN_PROMPTS_DIR = join(PLUGIN_ROOT, 'vendor', 'prompts');

/**
 * Assemble the full dispatch runtime. 同步完成装配并返回:loadConfig/
 * openDatabase/stores 均为同步 API,invoke 链路立即可用;崩溃恢复、default
 * 项目种子与 agent 检测是异步启动项,fire-and-forget,错误落 logger。
 *
 * @param {{
 *   broadcast: (channel: string, payload: unknown) => void,
 *   logger: { info: (msg: string) => void, warn: (msg: string) => void, error: (msg: string) => void },
 *   version: string,
 * }} collaborators
 * @returns {{
 *   ctx: object, execution: object, sessions: object,
 *   refreshDetections: () => Promise<unknown>, dispose: () => Promise<void>,
 * }}
 */
export function createDispatchRuntime({ broadcast, logger, version }) {
  const paths = core.resolvePaths();
  core.ensureDispatchDirs(paths);
  const config = core.loadConfig(paths.configFile);
  const db = core.openDatabase(paths.dbFile);
  const tasks = new core.TaskStore(db, (t) => broadcast('task:changed', { taskId: t.id, status: t.status }));
  const projects = new core.ProjectStore(db, (projectId) => broadcast('project:changed', { projectId }));
  const detections = new core.DetectionStore(db);

  const { deps, execution } = createExecution({ config, paths, tasks, projects, logger });
  const sessions = createSessionService(deps, broadcast, logger);

  const scheduler = new core.Scheduler({
    tasks,
    enqueue: (id) => execution.enqueue(id),
    retryMerge: (id) => execution.retryMerge(id),
  });

  const ctx = { paths, config, db, tasks, projects, detections, version };

  let detectionInFlight = null;
  const refreshDetections = () => {
    detectionInFlight ??= core
      .runDetections(config.agents, core.getPlatformOps(), detections)
      .then((list) => {
        broadcast('agent:detections-changed', { detections: list });
        return list;
      })
      .finally(() => {
        detectionInFlight = null;
      });
    return detectionInFlight;
  };

  // 异步启动项统一登记:dispose 须等它们落定再关库,否则在途恢复/种子/检测
  // 会写已关闭的连接(unhandledRejection)。每项自带 catch,reject 不会外漏。
  const startup = [
    core
      .recoverOnStartup({ tasks, projects, config, paths, enqueue: (id) => scheduler.enqueueNow(id) })
      .then((r) =>
        logger.info(
          `崩溃恢复完成: interrupted=${r.interrupted.length} reattached=${r.reattached.length} ` +
            `missedRun=${r.missedRun.length} missedSkipped=${r.missedSkipped.length} ` +
            `awaitingMerge=${r.awaitingMerge.length}`,
        ),
      )
      .catch((e) => logger.error(`崩溃恢复失败: ${e.message}`))
      .finally(() => scheduler.start()),
    // 首启种子 default 项目;git 初始化失败不建项目行,下次启动重试
    core
      .seedDefaultProject(projects)
      .then((r) => {
        if (r.created) logger.info(`default 项目已创建: ${r.project.path}`);
      })
      .catch((e) => logger.error(`default 项目初始化失败: ${e.message}`)),
    refreshDetections().catch((e) => logger.error(`agent 检测失败: ${e.message}`)),
  ];
  logger.info(`Dispatch runtime 启动,home=${paths.home}`);

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    scheduler.stop();
    // 运行中任务登记中断:executor 落 failed(user_interrupted)、worktree 保留可重跑;
    // 中断收尾异步进行,dsh 退出后遗留的执行进程由下次启动的崩溃恢复兜底
    for (const t of tasks.listByStatus('running')) execution.interrupt(t.id);
    await sessions.disposeAll('plugin_dispose');
    // 等在途启动项落定(有界:检测等子进程各有自身超时,3s 上限防 dispose 悬挂)
    await Promise.race([Promise.allSettled(startup), new Promise((r) => setTimeout(r, 3000))]);
    db.close();
  };

  return { ctx, execution, sessions, refreshDetections, dispose };
}

/** ExecutionService 的插件版(src/shell/execution.ts):唯一差异是 prompts 路径与日志来源 */
function createExecution({ config, paths, tasks, projects, logger }) {
  const cancellations = new core.TaskCancellations();
  const deps = {
    cancellations,
    tasks,
    projects,
    config,
    paths,
    adapterFor: (agent) => {
      const cfg = config.agents[agent];
      if (!cfg) throw new Error(`config.agents 缺少 ${agent} 配置`);
      return new core.GenericCliAdapter(agent, cfg, core.getPlatformOps());
    },
    semaphore: new core.Semaphore(config.max_concurrency),
    mergeLocks: new core.KeyedLock(),
    builtinPromptFile: join(BUILTIN_PROMPTS_DIR, 'default.md'),
    builtinPromptsDir: BUILTIN_PROMPTS_DIR,
  };
  const enqueue = (taskId) => {
    void core.runTask(deps, taskId).catch((e) => logger.error(`任务 ${taskId} 执行编排异常: ${e.message}`));
  };
  return {
    deps,
    execution: {
      enqueue,
      maybeRunImmediate(task) {
        if (task.triggerType === 'immediate' && task.status === 'scheduled') enqueue(task.id);
      },
      /** 用户中断运行中任务;agent 运行窗口之外(如合并中)返回 false */
      interrupt: (taskId) => cancellations.interrupt(taskId),
      retryMerge(taskId) {
        void core.retryMerge(deps, taskId).catch((e) => logger.error(`任务 ${taskId} 重试合并编排异常: ${e.message}`));
      },
    },
  };
}
