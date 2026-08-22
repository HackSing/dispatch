import { describe, expect, it } from 'vitest'
import { KeyedLock, Semaphore } from '@core/executor/locks'

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('Semaphore', () => {
  it('并发不超过上限,释放后等待者继续', async () => {
    const sem = new Semaphore(2)
    let active = 0
    let peak = 0
    const gate = defer()
    const job = async (): Promise<void> => {
      const release = await sem.acquire()
      active += 1
      peak = Math.max(peak, active)
      await gate.promise
      active -= 1
      release()
    }
    const jobs = [job(), job(), job(), job()]
    await new Promise((r) => setTimeout(r, 20))
    expect(active).toBe(2)
    gate.resolve()
    await Promise.all(jobs)
    expect(peak).toBe(2)
    expect(active).toBe(0)
  })

  it('重复释放幂等', async () => {
    const sem = new Semaphore(1)
    const release = await sem.acquire()
    release()
    release()
    const second = await sem.acquire()
    second()
  })

  it('非法上限拒绝', () => {
    expect(() => new Semaphore(0)).toThrow()
  })
})

describe('KeyedLock', () => {
  it('同 key 串行,异 key 并行', async () => {
    const lock = new KeyedLock()
    const order: string[] = []
    const gate = defer()
    const first = lock.withLock('p1', async () => {
      order.push('p1-a-start')
      await gate.promise
      order.push('p1-a-end')
    })
    const second = lock.withLock('p1', async () => {
      order.push('p1-b')
    })
    const other = lock.withLock('p2', async () => {
      order.push('p2')
    })
    await other
    expect(order).toContain('p2')
    expect(order).not.toContain('p1-b')
    gate.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['p1-a-start', 'p2', 'p1-a-end', 'p1-b'])
  })

  it('fn 抛错不阻断后续排队者', async () => {
    const lock = new KeyedLock()
    await expect(
      lock.withLock('p1', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    await expect(lock.withLock('p1', async () => 'ok')).resolves.toBe('ok')
  })
})
