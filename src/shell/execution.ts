import { app } from 'electron'
import log from 'electron-log/main'
import { join } from 'node:path'
import type { AgentId, Task } from '@shared/types'
import { GenericCliAdapter } from '@core/agents/generic-cli-adapter'
import { getPlatformOps } from '@core/platform'
import { KeyedLock, Semaphore, TaskCancellations } from '@core/executor/locks'
import { retryMerge, runTask, type ExecutorDeps } from '@core/executor'
import type { AppContext } from './context'

/**
 * executor 的壳层装配:B2 只接 immediate 与手动「立即执行」;
 * 30s 扫描/定时触发/崩溃恢复(B3)复用同一 deps 接入。
 */
export class ExecutionService {
  private readonly deps: ExecutorDeps
  private readonly cancellations = new TaskCancellations()

  constructor(ctx: AppContext) {
    this.deps = {
      cancellations: this.cancellations,
      tasks: ctx.tasks,
      projects: ctx.projects,
      config: ctx.config,
      paths: ctx.paths,
      adapterFor: (agent: AgentId) => {
        const cfg = ctx.config.agents[agent]
        if (!cfg) throw new Error(`config.agents 缺少 ${agent} 配置`)
        return new GenericCliAdapter(agent, cfg, getPlatformOps())
      },
      semaphore: new Semaphore(ctx.config.max_concurrency),
      mergeLocks: new KeyedLock(),
      builtinPromptFile: join(app.getAppPath(), 'resources/prompts/default.md'),
      builtinPromptsDir: join(app.getAppPath(), 'resources/prompts')
    }
  }

  /** 面板会话服务等壳层同侪复用同一份 deps(adapter 工厂/锁/路径单一装配点) */
  get executorDeps(): ExecutorDeps {
    return this.deps
  }

  /** 入队执行(fire-and-forget):任务级失败由 executor 转 failed,这里只兜底编排异常 */
  enqueue(taskId: string): void {
    void runTask(this.deps, taskId).catch((e: Error) =>
      log.error(`任务 ${taskId} 执行编排异常: ${e.message}`)
    )
  }

  maybeRunImmediate(task: Task): void {
    if (task.triggerType === 'immediate' && task.status === 'scheduled') this.enqueue(task.id)
  }

  /** 用户中断运行中任务;agent 运行窗口之外(如合并中)返回 false */
  interrupt(taskId: string): boolean {
    return this.cancellations.interrupt(taskId)
  }

  /** 重试合并(fire-and-forget):调度器周期重试与 task:retry-merge 手动触发共用 */
  retryMerge(taskId: string): void {
    void retryMerge(this.deps, taskId).catch((e: Error) =>
      log.error(`任务 ${taskId} 重试合并编排异常: ${e.message}`)
    )
  }
}
