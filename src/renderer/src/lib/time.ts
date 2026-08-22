function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** ISO → datetime-local 控件值(本地时区) */
export function toDatetimeLocal(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local 控件值 → ISO,非法输入返回 null */
export function fromDatetimeLocal(value: string): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function formatTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 起点至今的耗时,如 "3分16秒" / "1小时02分" */
export function formatElapsed(startIso: string | null, nowMs: number = Date.now()): string {
  if (!startIso) return ''
  const start = new Date(startIso).getTime()
  if (Number.isNaN(start)) return ''
  const sec = Math.max(0, Math.floor((nowMs - start) / 1000))
  if (sec < 60) return `${sec}秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分${pad(sec % 60)}秒`
  return `${Math.floor(min / 60)}小时${pad(min % 60)}分`
}
