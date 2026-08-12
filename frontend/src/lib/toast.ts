export type Toast = { id: number; message: string; type: 'success' | 'error' | 'info' }
type Listener = (toasts: Toast[]) => void

let toasts: Toast[] = []
let listeners: Listener[] = []
let nextId = 1

function emit() {
  listeners.forEach(l => l(toasts))
}

// 給背景執行的動作用（例如「稍後建單」）：使用者可能已經切到別的分頁，
// 所以不能用該頁面自己的 local state 顯示結果，改用這個全域通知
export function showToast(message: string, type: Toast['type'] = 'success', durationMs = 4000) {
  const id = nextId++
  toasts = [...toasts, { id, message, type }]
  emit()
  setTimeout(() => {
    toasts = toasts.filter(t => t.id !== id)
    emit()
  }, durationMs)
}

export function subscribeToasts(listener: Listener) {
  listeners.push(listener)
  listener(toasts)
  return () => { listeners = listeners.filter(l => l !== listener) }
}
