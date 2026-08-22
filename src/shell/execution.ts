import { app } from 'electron'
import log from 'electron-log/main'
import { join } from 'node:path'
import type { AgentId, Task } from '@shared/types'
import { GenericCliAdapter } from '@core/agents/generic-cli-adapter'
import { getPlatformOps } from '@core/platform'
import { KeyedLock, Semaphore } from '@core/executor/locks'
import { runTask, type ExecutorDeps } from '@core/executor'
import type { AppContext } from './context'

/**
 * executor 的壳层装配:B2 只接 immediate 与手动「立即执行」;
 * 30s 扫描/定时触发/崩溃恢复(B3)复用同一 deps 接入。
 */
export class ExecutionService {
  private readonly deps: ExecutorDeps

  constructor(ctx: AppContext) {
    this.deps = {
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
      builtinPromptFile: join(app.getAppPath(), 'resources/prompts/default.md')
    }
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
}
