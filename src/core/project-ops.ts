import { statSync } from 'node:fs'
import { basename } from 'node:path'
import type { Project } from '@shared/types'
import type { ProjectStore } from './db/project-store'

/**
 * 项目创建统一编排(独立壳与 dsh 插件共用的唯一入口):trim 与存在性校验、
 * 同路径幂等返回、basename 默认名。此前两个壳各持一份相同逻辑,校验缺失导致
 * 幽灵路径项目入库、派任务时才在 worktree 阶段远因报错(2026-08-23 实测)。
 * 校验只到「存在且是目录」为止:可写性与 git 探测各有自己的失败路径,
 * 非 git 目录也是合法项目,不在此重复防御。
 */
export function createProject(store: ProjectStore, input: { path: string; name?: string }): Project {
  const path = input.path.trim()
  if (!path) throw new Error('项目路径不能为空')
  let isDirectory: boolean
  try {
    isDirectory = statSync(path).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) throw new Error(`路径不存在或不是文件夹: ${path}`)
  const existing = store.list().find((p) => p.path === path)
  if (existing) return existing
  return store.create({ name: input.name?.trim() || basename(path), path })
}
