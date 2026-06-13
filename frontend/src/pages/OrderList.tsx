import { useState, useEffect } from 'react'
import { api } from '../lib/api'

type Order = {
  id: number
  customer_name: string
  customer_phone: string
  customer_address: string
  customer_district: string
  driver_name: string | null
  quantity: number
  unit_price: number
  total_amount: number
  status: string
  payment_type: string
  note: string | null
  created_at: string
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: '待派送',
  ASSIGNED: '已指派',
  DELIVERING: '配送中',
  DELIVERED: '已完成',
  CANCELLED: '已取消',
}

const STATUS_COLOR: Record<string, string> = {
  PENDING: 'bg-yellow-100 text-yellow-700',
  ASSIGNED: 'bg-blue-100 text-blue-700',
  DELIVERING: 'bg-orange-100 text-orange-700',
  DELIVERED: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-gray-100 text-gray-500',
}

export default function OrderList({ refresh }: { refresh?: number }) {
  const [orders, setOrders] = useState<Order[]>([])
  const [summary, setSummary] = useState<any>(null)
  const [filter, setFilter] = useState('ALL')
  const [loading, setLoading] = useState(true)
  const [actionId, setActionId] = useState<number | null>(null)

  async function load() {
    setLoading(true)
    try {
      const params: any = {}
      if (filter !== 'ALL') params.status = filter
      const [res, sum] = await Promise.all([
        api.getOrders(params),
        api.getTodaySummary(),
      ])
      setOrders(res.orders)
      setSummary(sum)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [filter, refresh])

  async function markDelivered(order: Order) {
    setActionId(order.id)
    try {
      if (order.payment_type === 'CASH') {
        await api.collectPayment(order.id, { amount: order.total_amount, method: 'CASH' })
      } else {
        await api.updateOrderStatus(order.id, 'DELIVERED')
      }
      await load()
    } finally {
      setActionId(null)
    }
  }

  async function markDelivering(id: number) {
    setActionId(id)
    try {
      await api.updateOrderStatus(id, 'DELIVERING')
      await load()
    } finally {
      setActionId(null)
    }
  }

  const pending = orders.filter(o => o.status === 'PENDING' || o.status === 'ASSIGNED' || o.status === 'DELIVERING')
  const done = orders.filter(o => o.status === 'DELIVERED' || o.status === 'CANCELLED')

  return (
    <div className="max-w-lg mx-auto p-4 space-y-4">
      <h2 className="text-xl font-bold text-gray-800">📦 今日訂單</h2>

      {/* 今日統計 */}
      {summary && (
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-orange-50 rounded-xl p-3 text-center">
            <div className="text-2xl font-bold text-orange-600">{summary.total_orders || 0}</div>
            <div className="text-xs text-gray-500 mt-0.5">總訂單</div>
          </div>
          <div className="bg-blue-50 rounded-xl p-3 text-center">
            <div className="text-2xl font-bold text-blue-600">{summary.total_cylinders || 0}</div>
            <div className="text-xs text-gray-500 mt-0.5">總桶數</div>
          </div>
          <div className="bg-green-50 rounded-xl p-3 text-center">
            <div className="text-lg font-bold text-green-600">${Number(summary.cash_amount || 0).toLocaleString()}</div>
            <div className="text-xs text-gray-500 mt-0.5">現金收入</div>
          </div>
        </div>
      )}

      {/* 篩選 */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {['ALL', 'PENDING', 'DELIVERING', 'DELIVERED'].map(s => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition ${filter === s ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-600'}`}
          >
            {s === 'ALL' ? '全部' : STATUS_LABEL[s]}
          </button>
        ))}
        <button onClick={load} className="flex-shrink-0 px-3 py-1.5 rounded-full text-sm bg-gray-100 text-gray-600">
          🔄
        </button>
      </div>

      {loading && <div className="text-center text-gray-400 py-8">載入中...</div>}

      {/* 待送訂單 */}
      {!loading && pending.length > 0 && (
        <div className="space-y-3">
          {pending.map(order => (
            <div key={order.id} className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <span className="font-bold text-gray-800">{order.customer_name}</span>
                  <span className="text-sm text-gray-500 ml-2">{order.customer_phone}</span>
                </div>
                <span className={`text-xs px-2 py-1 rounded-full font-medium ${STATUS_COLOR[order.status]}`}>
                  {STATUS_LABEL[order.status]}
                </span>
              </div>
              <div className="text-sm text-gray-600 mb-1">📍 {order.customer_address}</div>
              <div className="flex gap-3 text-sm text-gray-700 mb-1">
                <span>🪣 {order.quantity} 桶</span>
                <span>💰 ${Number(order.total_amount).toLocaleString()}</span>
                <span className={order.payment_type === 'AR' ? 'text-red-500 font-medium' : 'text-green-600'}>
                  {order.payment_type === 'AR' ? '📒 欠帳' : '💵 現金'}
                </span>
              </div>
              {order.note && <div className="text-sm text-orange-600 mb-2">📝 {order.note}</div>}
              <div className="flex gap-2 mt-3">
                {order.status === 'PENDING' && (
                  <button
                    onClick={() => markDelivering(order.id)}
                    disabled={actionId === order.id}
                    className="flex-1 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-200 text-white text-sm font-medium py-2 rounded-lg transition"
                  >
                    🚛 出發
                  </button>
                )}
                {(order.status === 'DELIVERING' || order.status === 'ASSIGNED') && (
                  <button
                    onClick={() => markDelivered(order)}
                    disabled={actionId === order.id}
                    className="flex-1 bg-green-500 hover:bg-green-600 disabled:bg-gray-200 text-white text-sm font-medium py-2 rounded-lg transition"
                  >
                    ✅ 完成送達
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 已完成訂單 */}
      {!loading && done.length > 0 && filter !== 'PENDING' && filter !== 'DELIVERING' && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-gray-400">已完成</div>
          {done.map(order => (
            <div key={order.id} className="bg-gray-50 border border-gray-100 rounded-xl p-3">
              <div className="flex justify-between">
                <span className="font-medium text-gray-600">{order.customer_name}</span>
                <span className="text-sm text-gray-400">{order.quantity} 桶 ${Number(order.total_amount).toLocaleString()}</span>
              </div>
              <div className="text-xs text-gray-400 mt-0.5">{order.customer_address}</div>
            </div>
          ))}
        </div>
      )}

      {!loading && orders.length === 0 && (
        <div className="text-center text-gray-400 py-12">今日暫無訂單</div>
      )}
    </div>
  )
}
