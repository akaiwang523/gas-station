import { useState, useEffect } from 'react'
import Login from './pages/Login'
import NewOrder from './pages/NewOrder'
import OrderList from './pages/OrderList'
import ArPage from './pages/ArPage'
import ReportPage from './pages/ReportPage'
import CustomerPage from './pages/CustomerPage'
import ReconcilePage from './pages/ReconcilePage'
import IncomingCallModal from './components/IncomingCallModal'
import BaselinePriceSettings from './components/BaselinePriceSettings'
import ToastContainer from './components/ToastContainer'
import './index.css'

type Page = 'orders' | 'new' | 'reconcile' | 'ar' | 'customers' | 'report'

export default function App() {
  const [authed, setAuthed] = useState(!!localStorage.getItem('token'))
  const [page, setPage] = useState<Page>('orders')
  const [orderRefresh, setOrderRefresh] = useState(0)
  const [customerEditId, setCustomerEditId] = useState<number | null>(null)
  const [customerModalOpen, setCustomerModalOpen] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

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

  function handleEditCustomer(customerId: number) {
    setCustomerEditId(customerId)
    setCustomerModalOpen(true)
  }

  const navItems: { key: Page; label: string; icon: string }[] = [
    { key: 'orders', label: '訂單', icon: '📦' },
    { key: 'new', label: '接單', icon: '➕' },
    { key: 'reconcile', label: '對帳', icon: '✅' },
    { key: 'ar', label: '欠帳', icon: '📒' },
    { key: 'customers', label: '客戶', icon: '👥' },
    { key: 'report', label: '報表', icon: '📊' },
  ]

  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      <ToastContainer />
      <IncomingCallModal />

      {/* Header */}
      <div className="bg-white text-gray-800 px-4 py-3 flex justify-between items-center sticky top-0 z-10 border-b border-gray-200">
        <span className="font-bold text-lg">瓦斯行管理</span>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowSettings(true)}
            className="text-gray-500 text-lg"
            title="基準價設定"
          >
            🔧
          </button>
          <button
            onClick={() => { localStorage.removeItem('token'); setAuthed(false) }}
            className="text-gray-500 text-sm"
          >
            登出
          </button>
        </div>
      </div>

      {showSettings && <BaselinePriceSettings onClose={() => setShowSettings(false)} />}

      {/* Content */}
      <div className="pt-2">
        {page === 'orders' && <OrderList refresh={orderRefresh} onEditCustomer={handleEditCustomer} />}
        {page === 'new' && <NewOrder onOrderCreated={handleOrderCreated} />}
        {page === 'reconcile' && <ReconcilePage refresh={orderRefresh} onEditCustomer={handleEditCustomer} />}
        {page === 'ar' && <ArPage />}
        {page === 'customers' && <CustomerPage openEditId={customerEditId} onOpenEditConsumed={() => setCustomerEditId(null)} />}
        {page === 'report' && <ReportPage onEditCustomer={handleEditCustomer} />}
      </div>

      {/* 從訂單/報表頁點「編輯客戶」時，只彈出編輯表單，訂單頁維持在背景，不整頁跳轉 */}
      {customerModalOpen && page !== 'customers' && (
        <CustomerPage
          openEditId={customerEditId}
          onOpenEditConsumed={() => setCustomerEditId(null)}
          quickEditOnly
          onQuickEditClose={() => { setCustomerModalOpen(false); setCustomerEditId(null); setOrderRefresh(r => r + 1) }}
        />
      )}

      {/* Bottom Nav */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 flex z-10">
        {navItems.map(item => (
          <button
            key={item.key}
            onClick={() => setPage(item.key)}
            className={`flex-1 py-4 flex items-center justify-center transition ${page === item.key ? 'text-blue-600 font-bold' : 'text-gray-500'}`}
          >
            <span className="text-base">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
