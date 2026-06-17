import { useState, useEffect } from 'react'
import Login from './pages/Login'
import NewOrder from './pages/NewOrder'
import OrderList from './pages/OrderList'
import ArPage from './pages/ArPage'
import ReportPage from './pages/ReportPage'
import CustomerPage from './pages/CustomerPage'
import IncomingCallModal from './components/IncomingCallModal'
import './index.css'

type Page = 'orders' | 'new' | 'ar' | 'customers' | 'report'

export default function App() {
  const [authed, setAuthed] = useState(!!localStorage.getItem('token'))
  const [page, setPage] = useState<Page>('orders')
  const [orderRefresh, setOrderRefresh] = useState(0)

  useEffect(() => {
    const handler = () => setOrderRefresh(r => r + 1)
    window.addEventListener('order-refresh', handler)
    return () => window.removeEventListener('order-refresh', handler)
  }, [])

  if (!authed) {
    return <Login onLogin={() => setAuthed(true)} />
  }

  function handleOrderCreated() {
    setOrderRefresh(r => r + 1)
    setPage('orders')
  }

  const navItems: { key: Page; label: string; icon: string }[] = [
    { key: 'orders', label: '訂單', icon: '📦' },
    { key: 'new', label: '接單', icon: '➕' },
    { key: 'ar', label: '欠帳', icon: '📒' },
    { key: 'customers', label: '客戶', icon: '👥' },
    { key: 'report', label: '報表', icon: '📊' },
  ]

  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      <IncomingCallModal />

      {/* Header */}
      <div className="bg-orange-500 text-white px-4 py-3 flex justify-between items-center sticky top-0 z-10 shadow">
        <span className="font-bold text-lg">🔥 瓦斯行管理</span>
        <button
          onClick={() => { localStorage.removeItem('token'); setAuthed(false) }}
          className="text-orange-100 text-sm"
        >
          登出
        </button>
      </div>

      {/* Content */}
      <div className="pt-2">
        {page === 'orders' && <OrderList refresh={orderRefresh} />}
        {page === 'new' && <NewOrder onOrderCreated={handleOrderCreated} />}
        {page === 'ar' && <ArPage />}
        {page === 'customers' && <CustomerPage />}
        {page === 'report' && <ReportPage />}
      </div>

      {/* Bottom Nav */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 flex z-10">
        {navItems.map(item => (
          <button
            key={item.key}
            onClick={() => setPage(item.key)}
            className={`flex-1 py-3 flex flex-col items-center gap-0.5 transition ${page === item.key ? 'text-orange-500' : 'text-gray-400'}`}
          >
            <span className="text-xl">{item.icon}</span>
            <span className="text-xs font-medium">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
