import { useEffect, useState } from 'react'
import { subscribeToasts, Toast } from '../lib/toast'

export default function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([])
  useEffect(() => subscribeToasts(setToasts), [])

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 w-[90%] max-w-md pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`px-4 py-3 rounded-xl shadow-lg text-white font-medium text-sm ${t.type === 'success' ? 'bg-green-600' : 'bg-red-600'}`}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}
