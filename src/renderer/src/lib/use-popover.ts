import { useEffect, type RefObject } from 'react'

/**
 * 弹层(⋯ 菜单 / 选择面板)统一关闭行为:外点、Esc、滚动与缩放即收起。
 * Esc 在捕获阶段拦截:弹层开着时只收起弹层,不联动关闭外层抽屉;
 * fixed 定位的弹层不随内容滚动,故滚动即收起,避免脱离锚点悬浮。
 */
export function usePopoverDismiss(
  open: boolean,
  wrapRef: RefObject<HTMLElement | null>,
  close: () => void
): void {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      // Shadow DOM 渲染(dsh 插件形态)下,document 层看到的 target 已被重定向为
      // shadow host,contains 恒假会误关弹层;composedPath 携带 shadow 内部节点,
      // light DOM 与 shadow DOM 下判定一致。
      const path = e.composedPath()
      if (wrapRef.current && !path.includes(wrapRef.current)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    const onClose = (): void => close()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [open, close, wrapRef])
}
