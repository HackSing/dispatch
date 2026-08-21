import { useEffect, useState } from 'react'
import type { AppStatus } from '@shared/ipc'

const page: React.CSSProperties = {
  fontFamily: 'system-ui, -apple-system, sans-serif',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100vh',
  margin: 0,
  background: '#f5f5f7',
  color: '#1d1d1f'
}

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.dispatchApi
      .invoke('app:status', undefined)
      .then(setStatus)
      .catch((e: Error) => setError(e.message))
  }, [])

  return (
    <div style={page}>
      <div style={{ textAlign: 'center', lineHeight: 1.8 }}>
        <h1 style={{ fontSize: 28, margin: 0 }}>Dispatch</h1>
        <p style={{ color: '#6e6e73', margin: '4px 0 16px' }}>任务收件箱 + Agent 调度器</p>
        {error && <p style={{ color: '#c0392b' }}>IPC 异常:{error}</p>}
        {status && (
          <p style={{ fontSize: 13, color: '#6e6e73' }}>
            v{status.version} · schema v{status.dbSchemaVersion} · {status.platform}
            <br />
            {status.dispatchHome}
          </p>
        )}
      </div>
    </div>
  )
}
