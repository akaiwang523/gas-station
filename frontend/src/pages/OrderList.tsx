import { useState, useEffect } from 'react'
import { api } from '../lib/api'
type Order = {
  id: number
  customer_id: number
  customer_name: string
  customer_phone: string
  customer_address: string
  driver_name: string | null
  quantity: number
  unit_price: number
  total_amount: number
  status: string
  payment_type: string
  note: string | null
  created_at: string
  items: any[]
}
const STATUS_LABEL: Record<string, string> = {
  PENDING: '待派送', ASSIGNED: '已指派', DELIVERING: '配送中',
  DELIVERED: '已完成', CANCELLED: '已取消',
}
const STATUS_COLOR: Record<string, string> = {
  PENDING: 'bg-yellow-100 text-yellow-700', ASSIGNED: 'bg-blue-100 text-blue-700',
  DELIVERING: 'bg-orange-100 text-orange-700', DELIVERED: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-gray-100 text-gray-500',
}
// 卡片左側狀態色條，跟 STATUS_COLOR 用同一套語意色
const STATUS_BORDER: Record<string, string> = {
  PENDING: 'border-l-yellow-400', ASSIGNED: 'border-l-blue-400',
  DELIVERING: 'border-l-orange-400', DELIVERED: 'border-l-green-400',
  CANCELLED: 'border-l-gray-300',
}
const GAS_LABELS: Record<string, string> = {
  BOTTLED_20KG: '20kg', BOTTLED_16KG: '16kg', BOTTLED_10KG: '10kg', BOTTLED_4KG: '4kg',
}
// 產生 Google Maps 導航連結
function mapsUrl(address: string) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
}
// 把日期轉成「6/5（14 天前）」這種好讀格式
function daysAgoLabel(dateStr: string) {
  const d = new Date(dateStr)
  const dateLabel = d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000)
  if (days <= 0) return `${dateLabel}（今天）`
  if (days === 1) return `${dateLabel}（昨天）`
  return `${dateLabel}（${days} 天前）`
}
export default function OrderList({ refresh }: { refresh?: number }) {
  const [orders, setOrders] = useState<Order[]>([])
  const [returnsMap, setReturnsMap] = useState<Record<number, any[]>>({})
  const [summary, setSummary] = useState<any>(null)
  const [filter, setFilter] = useState('ALL')
  const [loading, setLoading] = useState(true)
  const [actionId, setActionId] = useState<number | null>(null)
  const [returnModal, setReturnModal] = useState<{orderId: number, customerId: number, customerName: string} | null>(null)
  const [returnKg, setReturnKg] = useState('')
  const [returnAction, setReturnAction] = useState('RECORD')
  const [predictions, setPredictions] = useState<any[]>([])
  const [predExpanded, setPredExpanded] = useState(false)
  const [drafts, setDrafts] = useState<Order[]>([])
  const [returnAmount, setReturnAmount] = useState('')
  const [returnNote, setReturnNote] = useState('')
  const [returnLoading, setReturnLoading] = useState(false)
  // 展開編輯（多品項：每個品項各自一行）
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [editItems, setEditItems] = useState<{ id: number; gasType: string; quantity: string; unitPrice: string }[]>([])
  const [editNote, setEditNote] = useState('')
  const [editLoading, setEditLoading] = useState(false)
  const [customerHistory, setCustomerHistory] = useState<Record<number, any>>({})
  async function load() {
    setLoading(true)
    try {
      const params: any = {}
      if (filter !== 'ALL') params.status = filter
      const [res, sum] = await Promise.all([api.getOrders(params), api.getTodaySummary()])
      setOrders(res.orders)
      setSummary(sum)
      const customerIds = [...new Set(res.orders.map((o: any) => o.customer_id))]
      const map: Record<number, any[]> = {}
      await Promise.all(customerIds.map(async (cid: any) => {
        try {
          const r = await api.getPendingReturns(cid)
          if (r.returns?.length > 0) map[cid] = r.returns
        } catch {}
      }))
      setReturnsMap(map)
      // 預先撈「待處理」訂單客戶的歷史叫貨紀錄，讓卡片收合時也能顯示上次配送日期
      const pendingCustomerIds = [...new Set(
        res.orders.filter((o: any) => ['PENDING', 'ASSIGNED', 'DELIVERING'].includes(o.status))
          .map((o: any) => o.customer_id)
      )]
      const histMap: Record<number, any[]> = {}
      await Promise.all(pendingCustomerIds.map(async (cid: any) => {
        try {
          const r = await api.getOrders({ customerId: cid, all: true, limit: 5 })
          const prev = r.orders.filter((o: any) => o.status !== 'CANCELLED' && o.status !== 'DRAFT')
          if (prev.length > 0) histMap[cid] = prev
        } catch {}
      }))
      setCustomerHistory(histMap)
      try {
        const pred = await api.getPredictions()
        setPredictions(pred.predictions || [])
      } catch {}
      try {
        const draftRes = await api.getOrders({ status: 'DRAFT' })
        setDrafts(draftRes.orders || [])
      } catch {}
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [filter, refresh])
  // 取得某筆訂單「上一次」的配送紀錄（排除自己）
  function getLastDelivery(order: Order) {
    const hist = customerHistory[order.customer_id]
    if (!hist) return null
    return hist.find((h: any) => h.id !== order.id) || null
  }
  async function toggleExpand(order: Order) {
    if (expandedId === order.id) { setExpandedId(null); return }
    setExpandedId(order.id)
    if (order.items && order.items.length > 0) {
      setEditItems(order.items.map((i: any) => ({
        id: i.id, gasType: i.gas_type, quantity: String(i.quantity), unitPrice: String(i.unit_price),
      })))
    } else {
      // 沒有品項明細的舊資料，退回用訂單主表的桶數/單價當作單一品項
      setEditItems([{ id: 0, gasType: 'BOTTLED_20KG', quantity: String(order.quantity), unitPrice: String(order.unit_price) }])
    }
    setEditNote(order.note || '')
    // 若 load() 階段還沒撈到（例如已完成訂單），補撈一次
    if (!customerHistory[order.customer_id]) {
      try {
        const res = await api.getOrders({ customerId: order.customer_id, all: true, limit: 5 })
        const prev = res.orders.filter((o: any) => o.id !== order.id && o.status !== 'CANCELLED' && o.status !== 'DRAFT')
        setCustomerHistory(h => ({ ...h, [order.customer_id]: prev }))
      } catch {}
    }
  }
  async function saveEdit(order: Order) {
    if (editItems.length === 0) {
      alert('至少需要一個品項')
      return
    }
    setEditLoading(true)
    try {
      const items = editItems.map(i => ({
        id: i.id || undefined, gasType: i.gasType, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice),
      }))
      await api.updateOrder(order.id, { items, note: editNote })
      setExpandedId(null)
      await load()
    } catch (e: any) {
      alert(e.message)
    } finally {
      setEditLoading(false)
    }
  }
  // 更新編輯中某個品項的某個欄位
  function updateEditItem(index: number, field: 'gasType' | 'quantity' | 'unitPrice', value: string) {
    setEditItems(items => items.map((it, i) => i === index ? { ...it, [field]: value } : it))
  }
  // 新增一個空白品項（預設 20kg，桶數 1，單價沿用最後一個品項的單價方便快速輸入）
  function addEditItem() {
    setEditItems(items => {
      const lastPrice = items.length > 0 ? items[items.length - 1].unitPrice : ''
      return [...items, { id: 0, gasType: 'BOTTLED_20KG', quantity: '1', unitPrice: lastPrice }]
    })
  }
  // 移除一個品項（至少保留一個，不能刪到完全沒有品項）
  function removeEditItem(index: number) {
    setEditItems(items => items.length <= 1 ? items : items.filter((_, i) => i !== index))
  }
  // 編輯區目前所有品項的合計金額
  function editItemsTotal() {
    return editItems.reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unitPrice || 0), 0)
  }
  async function markDelivering(id: number) {
    setActionId(id)
    try { await api.updateOrderStatus(id, 'DELIVERING'); await load() }
    finally { setActionId(null) }
  }
  async function markDelivered(order: Order) {
    setActionId(order.id)
    try {
      if (order.payment_type === 'CASH') {
        await api.collectPayment(order.id, { amount: order.total_amount, method: 'CASH' })
      } else {
        await api.updateOrderStatus(order.id, 'DELIVERED')
      }
      await load()
      setReturnModal({ orderId: order.id, customerId: order.customer_id, customerName: order.customer_name })
      setReturnKg('')
      setReturnAction('RECORD')
      setReturnAmount('')
      setReturnNote('')
    } finally { setActionId(null) }
  }
  async function submitReturn() {
    if (!returnModal || !returnKg) { setReturnModal(null); return }
    setReturnLoading(true)
    try {
      await api.createReturn({
        customerId: returnModal.customerId,
        orderId: returnModal.orderId,
        cylinderType: 'BOTTLED_20KG',
        remainingKg: Number(returnKg),
        action: returnAction,
        amount: Number(returnAmount) || 0,
        note: returnNote,
      })
      setReturnModal(null)
      await load()
    } finally { setReturnLoading(false) }
  }
  async function undoDelivered(id: number) {
    if (!window.confirm('確定要撤銷這筆完成的訂單嗎？')) return
    setActionId(id)
    try { await api.updateOrderStatus(id, 'PENDING'); await load() }
    finally { setActionId(null) }
  }
  async function cancelOrder(id: number) {
    if (!window.confirm('確定要取消這筆訂單嗎？')) return
    setActionId(id)
    try { await api.cancelOrder(id); await load() }
    finally { setActionId(null) }
  }
  async function deleteOrder(id: number) {
    if (!window.confirm('確定要刪除這筆訂單嗎？刪除後無法復原。')) return
    setActionId(id)
    try { await api.deleteOrder(id); await load() }
    finally { setActionId(null) }
  }
  const pending = orders.filter(o => ['PENDING','ASSIGNED','DELIVERING'].includes(o.status))
  const done = orders.filter(o => ['DELIVERED','CANCELLED'].includes(o.status))
  return (
    <div className="max-w-lg mx-auto p-4 space-y-4">
      <h2 className="text-xl font-bold text-gray-800">📦 今日訂單</h2>
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
      {drafts.length > 0 && (
        <div className="bg-orange-50 rounded-xl p-3 border border-orange-200">
          <div className="text-sm font-bold text-orange-800 mb-2">📞 來電草稿（待確認）<span className="ml-2 bg-orange-200 text-orange-800 text-xs px-2 py-0.5 rounded-full">{drafts.length}</span></div>
          <div className="space-y-2">
            {drafts.sort((a,b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()).map(d => (
              <div key={d.id} className="bg-white rounded-xl p-3 border border-orange-100 flex items-center justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-gray-800 text-sm truncate">{d.customer_name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {d.items?.length > 0 ? d.items.map((i:any) => `${i.gas_type?.replace('BOTTLED_','').replace('KG','kg')} × ${i.quantity}`).join(' + ') : `${d.quantity} 桶`}
                    　{new Date(d.created_at).toLocaleTimeString('zh-TW', {hour:'2-digit', minute:'2-digit'})} 來電
                  </div>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  <button
                    className="px-3 py-1.5 bg-orange-500 text-white text-xs font-bold rounded-lg"
                    onClick={async () => {
                      try {
                        await api.updateOrderStatus(d.id, 'PENDING')
                        setDrafts(prev => prev.filter(x => x.id !== d.id))
                        await load()
                      } catch { alert('操作失敗') }
                    }}
                  >✅ 確認</button>
                  <button
                    className="px-3 py-1.5 bg-gray-100 text-gray-600 text-xs font-bold rounded-lg"
                    onClick={async () => {
                      try {
                        await api.deleteOrder(d.id)
                        setDrafts(prev => prev.filter(x => x.id !== d.id))
                      } catch { alert('刪除失敗') }
                    }}
                  >🗑</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {predictions.length > 0 && (
        <div className="bg-blue-50 rounded-xl p-3">
          <button
            className="w-full flex items-center justify-between"
            onClick={() => setPredExpanded(prev => !prev)}
          >
            <div className="text-sm font-bold text-blue-800">📞 可詢問客戶（預測需補貨）<span className="ml-2 bg-blue-200 text-blue-800 text-xs px-2 py-0.5 rounded-full">{predictions.length}</span></div>
            <span className="text-blue-400 text-xs">{predExpanded ? '▲ 收合' : '▼ 展開'}</span>
          </button>
          {predExpanded && (
            <div className="flex gap-2 overflow-x-auto pb-1 mt-2">
              {predictions.map(p => (
                <div key={p.customerId} className="flex-shrink-0 w-48 bg-white rounded-xl p-3 border border-blue-200 shadow-sm">
                  <div className="font-bold text-gray-800 text-sm truncate">{p.customerName}</div>
                  <div className="text-xs text-gray-500 mt-1">預測耗盡：{p.predictedDate}</div>
                  <div className="text-xs text-gray-500">平均間隔：{p.avgInterval} 天</div>
                  <div className="text-xs text-gray-500">上次：{p.lastGasType?.replace('BOTTLED_','').replace('KG','kg')} × {p.lastQuantity}</div>
                  <a
                    href={`tel:${p.customerPhone}`}
                    className="mt-2 w-full py-1.5 bg-blue-500 text-white text-xs font-bold rounded-lg flex items-center justify-center"
                  >📞 撥打電話</a>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {['ALL','PENDING','DELIVERING','DELIVERED'].map(s => (
          <button key={s} onClick={() => setFilter(s)} className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition ${filter === s ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-600'}`}>
            {s === 'ALL' ? '全部' : STATUS_LABEL[s]}
          </button>
        ))}
        <button onClick={load} className="flex-shrink-0 px-3 py-1.5 rounded-full text-sm bg-gray-100 text-gray-600">🔄</button>
      </div>
      {loading && <div className="text-center text-gray-400 py-8">載入中...</div>}
      {!loading && pending.length > 0 && (
        <div className="space-y-3">
          {pending.map(order => {
            const lastDelivery = getLastDelivery(order)
            return (
            <div key={order.id} className={`bg-white border border-gray-200 border-l-4 ${STATUS_BORDER[order.status]} rounded-xl p-4 shadow-sm`}>
              {/* 卡片主體 - 點擊展開 */}
              <div className="cursor-pointer" onClick={() => toggleExpand(order)}>
                <div className="flex justify-between items-start mb-1">
                  <div>
                    <span className="font-bold text-gray-800">{order.customer_name}</span>
                    <span className="text-sm text-gray-500 ml-2">{order.customer_phone}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-1 rounded-full font-medium ${STATUS_COLOR[order.status]}`}>{STATUS_LABEL[order.status]}</span>
                    <span className="text-gray-400 text-sm">{expandedId === order.id ? '▲' : '▼'}</span>
                  </div>
                </div>
                {lastDelivery && (
                  <div className="text-xs text-gray-400 mb-1.5">🕓 上次配送 {daysAgoLabel(lastDelivery.created_at)}</div>
                )}
                <a
                  href={mapsUrl(order.customer_address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="flex items-center gap-1.5 text-sm text-gray-700 bg-gray-50 hover:bg-gray-100 rounded-lg px-2.5 py-2 mb-2 transition"
                >
                  <span>📍</span>
                  <span className="flex-1">{order.customer_address}</span>
                  <span className="text-blue-500 text-xs whitespace-nowrap">導航 ›</span>
                </a>
                <div className="flex justify-between items-end mb-1">
                  <div className="text-sm text-gray-700">
                    {order.items && order.items.length > 0 ? (
                      <span>🪣 {order.items.map((i: any) => `${GAS_LABELS[i.gas_type]}×${i.quantity}`).join(' + ')}</span>
                    ) : (
                      <span>🪣 {order.quantity} 桶</span>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-bold text-gray-800 leading-tight">${Number(order.total_amount).toLocaleString()}</div>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${order.payment_type === 'AR' ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}>
                      {order.payment_type === 'AR' ? '📒 欠帳' : '💵 現金'}
                    </span>
                  </div>
                </div>
                {order.note && <div className="text-sm text-orange-600 mb-1">📝 {order.note}</div>}
                {returnsMap[order.customer_id]?.[0] && (
                  <div className="text-sm bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-1.5 flex justify-between items-center">
                    <span>⚠️ 上次存氣 {returnsMap[order.customer_id][0].remaining_kg}kg</span>
                    {Number(returnsMap[order.customer_id][0].amount) > 0
                      ? <span className="text-yellow-700 font-medium">{returnsMap[order.customer_id][0].action === 'REFUND' ? '退費' : '抵扣'} ${Number(returnsMap[order.customer_id][0].amount).toLocaleString()}</span>
                      : <span className="text-yellow-600 text-xs">{returnsMap[order.customer_id][0].action === 'RECORD' ? '只記錄' : ''}</span>
                    }
                  </div>
                )}
              </div>
              {/* 展開區塊 */}
              {expandedId === order.id && (
                <div className="mt-3 pt-3 border-t border-gray-100 space-y-3">
                  {/* 上次叫貨 */}
                  {customerHistory[order.customer_id]?.filter((h: any) => h.id !== order.id).length > 0 && (
                    <div className="bg-blue-50 rounded-lg p-2.5 space-y-1">
                      <div className="text-xs font-medium text-blue-700">📅 上次叫貨</div>
                      {customerHistory[order.customer_id].filter((h: any) => h.id !== order.id).slice(0, 3).map((h: any) => (
                        <div key={h.id} className="flex justify-between text-xs text-blue-600">
                          <span>{new Date(h.created_at).toLocaleDateString('zh-TW')}</span>
                          <span>{h.items?.length > 0 ? h.items.map((i: any) => `${GAS_LABELS[i.gas_type] || i.gas_type}×${i.quantity}`).join('+') : `${h.quantity}桶`}</span>
                          <span>${Number(h.total_amount).toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* 編輯欄位：每個品項各自一行，可新增/刪除/改規格 */}
                  <div className="space-y-2">
                    {editItems.map((item, idx) => (
                      <div key={item.id || `new-${idx}`} className="flex items-center gap-2">
                        <select
                          className="w-20 flex-shrink-0 border border-gray-300 rounded-lg px-1.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-400"
                          value={item.gasType}
                          onChange={e => updateEditItem(idx, 'gasType', e.target.value)}
                          onClick={e => e.stopPropagation()}
                        >
                          {Object.entries(GAS_LABELS).map(([val, label]) => (
                            <option key={val} value={val}>{label}</option>
                          ))}
                        </select>
                        <div className="flex-1">
                          <label className="block text-xs text-gray-400 mb-0.5">桶數</label>
                          <input type="number" className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                            value={item.quantity} onChange={e => updateEditItem(idx, 'quantity', e.target.value)} onClick={e => e.stopPropagation()} />
                        </div>
                        <div className="flex-1">
                          <label className="block text-xs text-gray-400 mb-0.5">單價</label>
                          <input type="number" className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                            value={item.unitPrice} onChange={e => updateEditItem(idx, 'unitPrice', e.target.value)} onClick={e => e.stopPropagation()} />
                        </div>
                        <div className="text-xs text-gray-500 w-16 text-right flex-shrink-0">
                          ${(Number(item.quantity || 0) * Number(item.unitPrice || 0)).toLocaleString()}
                        </div>
                        <button
                          onClick={e => { e.stopPropagation(); removeEditItem(idx) }}
                          disabled={editItems.length <= 1}
                          className="text-red-400 hover:text-red-600 disabled:text-gray-200 text-sm flex-shrink-0 w-5"
                          title="刪除此品項"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={e => { e.stopPropagation(); addEditItem() }}
                      className="w-full border border-dashed border-orange-300 text-orange-500 text-xs font-medium py-1.5 rounded-lg hover:bg-orange-50 transition"
                    >
                      ＋ 新增品項（不同規格）
                    </button>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">合計：${editItemsTotal().toLocaleString()}</label>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">備註</label>
                    <input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                      value={editNote} onChange={e => setEditNote(e.target.value)} onClick={e => e.stopPropagation()} />
                  </div>
                  <button onClick={e => { e.stopPropagation(); saveEdit(order) }} disabled={editLoading}
                    className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 text-white text-sm font-medium py-2 rounded-lg transition">
                    {editLoading ? '儲存中...' : '💾 儲存修改'}
                  </button>
                </div>
              )}
              {/* 操作按鈕 */}
              <div className="flex gap-2 mt-3">
                {order.status === 'PENDING' && (
                  <button onClick={e => { e.stopPropagation(); markDelivering(order.id) }} disabled={actionId === order.id}
                    className="flex-1 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-200 text-white text-sm font-medium py-2 rounded-lg transition">
                    🚛 出發
                  </button>
                )}
                {(order.status === 'DELIVERING' || order.status === 'ASSIGNED') && (
                  <button onClick={e => { e.stopPropagation(); markDelivered(order) }} disabled={actionId === order.id}
                    className="flex-1 bg-green-500 hover:bg-green-600 disabled:bg-gray-200 text-white text-sm font-medium py-2 rounded-lg transition">
                    ✅ 完成送達
                  </button>
                )}
                <button onClick={e => { e.stopPropagation(); cancelOrder(order.id) }} disabled={actionId === order.id}
                  className="px-3 bg-gray-100 hover:bg-red-100 text-gray-500 hover:text-red-500 text-sm font-medium py-2 rounded-lg transition">
                  取消
                </button>
              </div>
            </div>
            )
          })}
        </div>
      )}
      {!loading && done.length > 0 && filter !== 'PENDING' && filter !== 'DELIVERING' && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-gray-400">已完成</div>
          {done.map(order => (
            <div key={order.id} className="bg-gray-50 border border-gray-100 rounded-xl p-3">
              <div className="flex justify-between items-start">
                <div>
                  <span className="font-medium text-gray-600">{order.customer_name}</span>
                  <div className="text-xs text-gray-400 mt-0.5">{order.customer_address}</div>
                  {order.items && order.items.length > 0 && (
                    <div className="text-xs text-gray-400 mt-0.5">
                      {order.items.map((i: any) => `${GAS_LABELS[i.gas_type]}×${i.quantity}`).join(' + ')}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-sm text-gray-500">${Number(order.total_amount).toLocaleString()}</div>
                  {order.status === 'DELIVERED' && (
                    <button onClick={() => undoDelivered(order.id)} disabled={actionId === order.id} className="text-xs text-orange-400 hover:text-orange-600 mt-1 transition block">
                      ↩ 撤銷
                    </button>
                  )}
                  <button onClick={() => deleteOrder(order.id)} disabled={actionId === order.id} className="text-xs text-red-400 hover:text-red-600 mt-1 transition block">
                    🗑 刪除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {!loading && orders.length === 0 && <div className="text-center text-gray-400 py-12">今日暫無訂單</div>}
      {/* 存氣登記 Modal */}
      {returnModal && (
        <div className="fixed inset-0 bg-black/50 flex items-end z-50">
          <div className="bg-white w-full max-w-lg mx-auto rounded-t-2xl p-6 space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-bold">登記存氣 — {returnModal.customerName}</h3>
              <button onClick={() => setReturnModal(null)} className="text-gray-400 text-2xl">×</button>
            </div>
            <p className="text-sm text-gray-500">收回舊桶有剩餘瓦斯？填寫登記（可跳過）</p>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">剩餘公斤數</label>
                <input type="number" className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-orange-400" placeholder="例：5" value={returnKg} onChange={e => setReturnKg(e.target.value)} />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">退/抵金額</label>
                <input type="number" className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-orange-400" placeholder="0" value={returnAmount} onChange={e => setReturnAmount(e.target.value)} />
              </div>
            </div>
            <div className="flex gap-2">
              {[['RECORD','只記錄'],['REFUND','退費'],['DEDUCT','下次抵扣']].map(([val, label]) => (
                <button key={val} onClick={() => setReturnAction(val)} className={`flex-1 py-2 rounded-xl text-sm font-medium transition ${returnAction === val ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-600'}`}>{label}</button>
              ))}
            </div>
            <input className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none" placeholder="備註（選填）" value={returnNote} onChange={e => setReturnNote(e.target.value)} />
            <div className="flex gap-3">
              <button onClick={() => setReturnModal(null)} className="flex-1 bg-gray-100 text-gray-600 font-medium py-3 rounded-xl">跳過</button>
              <button onClick={submitReturn} disabled={returnLoading || !returnKg} className="flex-1 bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 text-white font-bold py-3 rounded-xl transition">
                {returnLoading ? '儲存中...' : '✅ 儲存存氣'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
