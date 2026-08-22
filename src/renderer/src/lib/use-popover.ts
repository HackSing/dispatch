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
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close()
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
