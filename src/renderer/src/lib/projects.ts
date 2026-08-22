/** 「新建项目…」统一流程:系统选文件夹 → 入库 → 刷新列表,取消返回 null */
export async function pickAndCreateProject(
  refreshProjects: () => Promise<void>
): Promise<string | null> {
  const path = await window.dispatchApi.invoke('project:pick-directory', undefined)
  if (!path) return null
  const project = await window.dispatchApi.invoke('project:create', { path })
  await refreshProjects()
  return project.id
}
