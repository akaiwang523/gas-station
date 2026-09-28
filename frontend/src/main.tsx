import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// /liff 是客人在 LINE 裡開的訂購頁：獨立載入，不經過後台登入，也不把 LIFF SDK 塞進後台的 bundle
const LiffOrder = lazy(() => import('./pages/LiffOrder'))
const isLiff = window.location.pathname.startsWith('/liff')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isLiff ? <Suspense fallback={null}><LiffOrder /></Suspense> : <App />}
  </StrictMode>,
)
