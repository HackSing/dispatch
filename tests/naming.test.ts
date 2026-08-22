import { describe, expect, it } from 'vitest'
import { sanitizeName, taskBranchName, taskSlug } from '@core/naming'

describe('taskSlug', () => {
  it('取前几词转 ascii-kebab', () => {
    expect(taskSlug('Fix the login bug in auth module')).toBe('fix-the-login-bug')
  })

  it('全非 ascii 返回空串', () => {
    expect(taskSlug('修复登录问题')).toBe('')
  })

  it('混合内容剔除非 ascii 并收敛连字符', () => {
    expect(taskSlug('修复 login 页面 bug')).toBe('login-bug')
  })
})

describe('taskBranchName', () => {
  it('有 slug 时拼接短 id 与 slug', () => {
    expect(taskBranchName('abcdef1234567890', 'Fix login')).toBe('task/abcdef12-fix-login')
  })

  it('非 ascii 回退纯短 id', () => {
    expect(taskBranchName('abcdef1234567890', '修复登录')).toBe('task/abcdef12')
  })
})

describe('sanitizeName', () => {
  it('清洗路径危险字符与空白', () => {
    expect(sanitizeName('my proj/v2: test')).toBe('my-proj-v2-test')
  })

  it('清洗后为空回退 unnamed', () => {
    expect(sanitizeName('///')).toBe('unnamed')
  })
})
