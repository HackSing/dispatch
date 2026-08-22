/** 全局执行并发信号量(spec §7.2 上限)与每项目合并锁(合并串行),B3 调度器直接复用 */

export class Semaphore {
  private active = 0
  private readonly waiters: (() => void)[] = []

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`信号量上限必须为正整数: ${max}`)
  }

  /** 返回释放函数,重复调用幂等;释放时名额直接移交队首等待者 */
  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active += 1
    } else {
      await new Promise<void>((r) => this.waiters.push(r))
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) next()
      else this.active -= 1
    }
  }
}

export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>()

  /** 同 key 串行、异 key 并行;fn 抛错不阻断后续排队者 */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    this.tails.set(key, tail)
    try {
      return await run
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}
