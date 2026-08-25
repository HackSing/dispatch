/** 平台差异统一收敛处(dev-plan §0):业务代码不感知平台,分支只允许出现在本目录与 proc/ */

export interface SpawnPlan {
  file: string
  args: string[]
  /** win32 经 cmd.exe 包装时为 true,调用方原样透传给 spawn/execFile */
  windowsVerbatimArguments?: boolean
}

export interface PlatformOps {
  /** 杀整个进程组/进程树,任务进程必须以 detached 进程组方式启动 */
  killTree(pid: number): Promise<void>
  /** 二进制探测(which / where),找不到返回 null */
  findBinary(name: string): Promise<string | null>
  /** 拉起系统终端并在 cwd 下执行 command(终端逃生舱);失败上抛给 UI 明示 */
  openTerminal(cwd: string, command: string): Promise<void>
  /** 把 findBinary 解析出的完整路径 + 参数转成可直接 spawn/execFile 的调用形状 */
  buildSpawn(binPath: string, args: string[]): SpawnPlan
}

import { darwinOps } from './darwin'
import { win32Ops } from './win32'

export function getPlatformOps(platform: NodeJS.Platform = process.platform): PlatformOps {
  switch (platform) {
    case 'darwin':
      return darwinOps
    case 'win32':
      return win32Ops
    default:
      throw new Error(`platform ${platform} 尚未支持(目前仅支持 darwin 与 win32)`)
  }
}
