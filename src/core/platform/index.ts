/** 平台差异统一收敛处(dev-plan §0):B5 只需在此补 win32 实现,业务代码不感知平台。 */

export interface PlatformOps {
  /** 杀整个进程组/进程树,任务进程必须以 detached 进程组方式启动 */
  killTree(pid: number): Promise<void>
  /** 二进制探测(which / where),找不到返回 null */
  findBinary(name: string): Promise<string | null>
}

import { darwinOps } from './darwin'

export function getPlatformOps(platform: NodeJS.Platform = process.platform): PlatformOps {
  switch (platform) {
    case 'darwin':
      return darwinOps
    default:
      throw new Error(`platform ${platform} 尚未支持(Windows 适配见 dev-plan B5)`)
  }
}
