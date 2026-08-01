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
  scheduled_date: string | null
  call_time: string | null
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
function daysAgoLabel(dateStr: string) {
  const d = new Date(dateStr)
  const dateLabel = d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000)
  if (days <= 0) return `${dateLabel}（今天）`
  if (days === 1) return `${dateLabel}（昨天）`
  return `${dateLabel}（${days} 天前）`
}
// 判斷這筆訂單的配送日是不是還沒到（用來隱藏「開始配送」按鈕，避免提早出車）
function isFutureScheduled(order: { scheduled_date: string | null }) {
  if (!order.scheduled_date) return false
  const sched = String(order.scheduled_date).slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)
  return sched > today
}
export default function OrderList({ refresh, onEditCustomer }: { refresh?: number; onEditCustomer?: (customerId: number) => void }) {
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
  const [notifiedIds, setNotifiedIds] = useState<Set<number>>(new Set())
  const [notifyingId, setNotifyingId] = useState<number | null>(null)
  const [predExpanded, setPredExpanded] = useState(false)
  const [lineInquiries, setLineInquiries] = useState<any[]>([])
  const [inquiriesExpanded, setInquiriesExpanded] = useState(false)
  const [inquiryActionId, setInquiryActionId] = useState<number | null>(null)
  const [drafts, setDrafts] = useState<Order[]>([])
  const [draftEditId, setDraftEditId] = useState<number | null>(null)
  const [draftItems, setDraftItems] = useState<{ gasType: string; quantity: string; unitPrice: string }[]>([{ gasType: 'BOTTLED_20KG', quantity: '1', unitPrice: '800' }])
  const [draftRememberPrice, setDraftRememberPrice] = useState(false)
  const [draftPaymentType, setDraftPaymentType] = useState('CASH')
  const [draftScheduledDate, setDraftScheduledDate] = useState('')
  const [draftConfirmLoading, setDraftConfirmLoading] = useState(false)
  const [returnAmount, setReturnAmount] = useState('')
  const [returnNote, setReturnNote] = useState('')
  const [returnLoading, setReturnLoading] = useState(false)
  // 展開編輯（多品項：每個品項各自一行）
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [editItems, setEditItems] = useState<{ id: number; gasType: string; quantity: string; unitPrice: string }[]>([])
  const [editNote, setEditNote] = useState('')
  const [editPaymentType, setEditPaymentType] = useState('CASH')
  const [editRememberPrice, setEditRememberPrice] = useState(false)
  const [editLoading, setEditLoading] = useState(false)
  const [customerHistory, setCustomerHistory] = useState<Record<number, any>>({})
  // 待送分頁多選批次標記完成（處理「其實已經送完但忘記點完成」累積下來的舊單）
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkLoading, setBulkLoading] = useState(false)
  async function load() {
    setLoading(true)
    try {
      const params: any = {}
      if (filter === 'SCHEDULED') {
        params.upcoming = true
      } else if (filter !== 'ALL') {
        params.status = filter
      }
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
        const inq = await api.getLineInquiries('PENDING')
        setLineInquiries(inq.inquiries || [])
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
    setEditPaymentType(order.payment_type)
    setEditRememberPrice(false)
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
      await api.updateOrder(order.id, { items, note: editNote, paymentType: editPaymentType })
      if (editRememberPrice && editItems.length === 1) {
        try { await api.updateCustomer(order.customer_id, { price_override: Number(editItems[0].unitPrice) || 0 }) } catch { /* 訂單已經存好了，這步失敗不影響本次修改 */ }
      }
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
  function toggleSelectMode() {
    setSelectMode(prev => !prev)
    setSelectedIds(new Set())
  }
  function toggleSelectOrder(id: number) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function selectAllPending() {
    setSelectedIds(new Set(pending.map(o => o.id)))
  }
  async function bulkMarkDelivered() {
    if (selectedIds.size === 0) return
    if (!window.confirm(`確定要把選取的 ${selectedIds.size} 筆訂單標記為「已完成」嗎？請先確認這些單真的都已經送達。`)) return
    setBulkLoading(true)
    try {
      await api.bulkUpdateOrderStatus([...selectedIds], 'DELIVERED')
      setSelectMode(false)
      setSelectedIds(new Set())
      await load()
    } catch (e: any) {
      alert(e.message || '批次更新失敗')
    } finally {
      setBulkLoading(false)
    }
  }
  // 展開來電草稿的核對表單（品項/付款方式/預約日期），取代舊版直接呼叫 updateOrderStatus
  // 跳過所有核對的快速確認鈕——那條路徑不會寫 scheduled_date，付款方式也永遠停在建草稿時的預設 CASH
  function openDraftConfirm(d: Order) {
    setDraftEditId(d.id)
    setDraftItems(
      d.items && d.items.length > 0
        ? d.items.map((i: any) => ({ gasType: i.gas_type, quantity: String(i.quantity), unitPrice: String(i.unit_price) }))
        : [{ gasType: 'BOTTLED_20KG', quantity: String(d.quantity ?? 1), unitPrice: String(d.unit_price ?? 800) }]
    )
    setDraftPaymentType(d.payment_type || 'CASH')
    setDraftScheduledDate('')
    setDraftRememberPrice(false)
  }
  function updateDraftItem(idx: number, field: 'gasType' | 'quantity' | 'unitPrice', value: string) {
    setDraftItems(prev => prev.map((it, i) => i === idx ? { ...it, [field]: value } : it))
  }
  function addDraftItem() {
    setDraftItems(prev => [...prev, { gasType: 'BOTTLED_20KG', quantity: '1', unitPrice: prev[prev.length - 1]?.unitPrice || '800' }])
  }
  function removeDraftItem(idx: number) {
    setDraftItems(prev => prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx))
  }
  function draftItemsTotal() {
    return draftItems.reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unitPrice || 0), 0)
  }
  function closeDraftConfirm() {
    setDraftEditId(null)
  }
  async function submitDraftConfirm(id: number, customerId: number) {
    setDraftConfirmLoading(true)
    try {
      await api.confirmDraft(id, {
        paymentType: draftPaymentType,
        items: draftItems.map(i => ({ gasType: i.gasType, quantity: Number(i.quantity) || 1, unitPrice: Number(i.unitPrice) || 0 })),
        scheduledDate: draftScheduledDate,
      })
      if (draftRememberPrice && draftItems.length === 1) {
        try { await api.updateCustomer(customerId, { price_override: Number(draftItems[0].unitPrice) || 0 }) } catch { /* 訂單已經建好了，這步失敗不影響本次派單 */ }
      }
      setDraftEditId(null)
      setDrafts(prev => prev.filter(x => x.id !== id))
      await load()
    } catch {
      alert('確認失敗')
    } finally {
      setDraftConfirmLoading(false)
    }
  }
  const pending = filter === 'SCHEDULED'
  ? orders
  : orders.filter(o => ['PENDING','ASSIGNED','DELIVERING'].includes(o.status))
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
              <div key={d.id} className="bg-white rounded-xl p-3 border border-orange-100">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-gray-800 text-sm truncate">{d.customer_name}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {d.items?.length > 0 ? d.items.map((i:any) => `${i.gas_type?.replace('BOTTLED_','').replace('KG','kg')} × ${i.quantity}`).join(' + ') : `${d.quantity} 桶`}
                      　{new Date(d.call_time || d.created_at).toLocaleTimeString('zh-TW', {hour:'2-digit', minute:'2-digit', timeZone: 'Asia/Taipei'})} 來電
                    </div>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    {draftEditId === d.id ? (
                      <button
                        className="px-3 py-1.5 bg-gray-100 text-gray-600 text-xs font-bold rounded-lg"
                        onClick={closeDraftConfirm}
                      >收合</button>
                    ) : (
                      <button
                        className="px-3 py-1.5 bg-orange-500 text-white text-xs font-bold rounded-lg"
                        onClick={() => openDraftConfirm(d)}
                      >✅ 核對確認</button>
                    )}
                    <button
                      className="px-3 py-1.5 bg-gray-100 text-gray-600 text-xs font-bold rounded-lg"
                      onClick={async () => {
                        if (!window.confirm('確定要刪除這筆來電草稿嗎？')) return
                        try {
                          await api.cancelDraft(d.id)
                          setDrafts(prev => prev.filter(x => x.id !== d.id))
                        } catch (e: any) { alert(`刪除失敗：${e.message || '未知錯誤'}`) }
                      }}
                    >🗑</button>
                  </div>
                </div>
                {draftEditId === d.id && (
                  <div className="mt-3 pt-3 border-t border-orange-100 space-y-2">
                    <div className="space-y-2">
                      {draftItems.map((item, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <select
                            className="w-20 flex-shrink-0 border border-gray-300 rounded-lg px-1.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-400"
                            value={item.gasType}
                            onChange={e => updateDraftItem(idx, 'gasType', e.target.value)}
                          >
                            {Object.entries(GAS_LABELS).map(([val, label]) => (
                              <option key={val} value={val}>{label}</option>
                            ))}
                          </select>
                          <div className="flex-1">
                            <label className="block text-xs text-gray-400 mb-0.5">桶數</label>
                            <input type="number" className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                              value={item.quantity} onChange={e => updateDraftItem(idx, 'quantity', e.target.value)} />
                          </div>
                          <div className="flex-1">
                            <label className="block text-xs text-gray-400 mb-0.5">單價</label>
                            <input type="number" className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                              value={item.unitPrice} onChange={e => updateDraftItem(idx, 'unitPrice', e.target.value)} />
                          </div>
                          <div className="text-xs text-gray-500 w-16 text-right flex-shrink-0">
                            ${(Number(item.quantity || 0) * Number(item.unitPrice || 0)).toLocaleString()}
                          </div>
                          <button
                            onClick={() => removeDraftItem(idx)}
                            disabled={draftItems.length <= 1}
                            className="text-red-400 hover:text-red-600 disabled:text-gray-200 text-sm flex-shrink-0 w-5"
                            title="刪除此品項"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={addDraftItem}
                        className="w-full border border-dashed border-orange-300 text-orange-500 text-xs font-medium py-1.5 rounded-lg hover:bg-orange-50 transition"
                      >
                        ＋ 新增品項（不同規格）
                      </button>
                    </div>
                    <div className="text-xs text-gray-500">合計：${draftItemsTotal().toLocaleString()}</div>
                    {draftItems.length === 1 && (
                      <label className="flex items-center gap-2 text-xs text-gray-600">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-orange-500"
                          checked={draftRememberPrice}
                          onChange={e => setDraftRememberPrice(e.target.checked)}
                        />
                        🔒 記住這個單價（存成 {d.customer_name} 的特殊單價，以後自動帶入）
                      </label>
                    )}
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">付款方式</label>
                      <div className="flex gap-2">
                        {[['CASH', '💵 現金'], ['AR', '📒 欠帳']].map(([val, label]) => (
                          <button
                            key={val}
                            onClick={() => setDraftPaymentType(val)}
                            className={`flex-1 py-1.5 rounded-lg text-sm font-medium transition ${draftPaymentType === val ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-600'}`}
                          >{label}</button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">預約配送日（留空＝今天）</label>
                      <input
                        type="date"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                        value={draftScheduledDate}
                        onChange={e => setDraftScheduledDate(e.target.value)}
                      />
                      {draftScheduledDate && (
                        <div className="text-orange-500 text-xs mt-1">⚠️ 此單將排定於 {draftScheduledDate}，在那天之前不會出現在待派送佇列</div>
                      )}
                    </div>
                    <button
                      onClick={() => submitDraftConfirm(d.id, d.customer_id)}
                      disabled={draftConfirmLoading}
                      className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 text-white text-sm font-medium py-2 rounded-lg transition"
                    >
                      {draftConfirmLoading ? '確認中...' : '💾 確認送出'}
                    </button>
                  </div>
                )}
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
                <div key={p.customerId} className="flex-shrink-0 w-48 bg-white rounded-xl p-3 border border-blue-200 shadow-sm relative">
                  <button
                    onClick={async () => {
                      setPredictions(prev => prev.filter(x => x.customerId !== p.customerId))
                      try { await api.dismissPrediction(p.customerId) } catch { /* 失敗就算了，下次重新整理還是會抓到最新狀態 */ }
                    }}
                    className="absolute top-1.5 right-1.5 text-gray-300 hover:text-gray-500 text-sm w-5 h-5 flex items-center justify-center"
                    title="取消這一輪提醒（下次他有新訂單才會重新提醒）"
                  >✕</button>
                  <div className="flex items-center gap-1 pr-4">
                    <span className="font-bold text-gray-800 text-sm truncate">{p.customerName}</span>
                    {p.confidence === 'default' && (
                      <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded flex-shrink-0" title="資料還不夠多，用客戶類型的預設值估算，僅供參考">僅供參考</span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">預測耗盡：{p.predictedDate}</div>
                  {p.overdueDays > 0 && (
                    <div className="text-xs text-red-500 font-bold">⚠️ 已過期 {p.overdueDays} 天</div>
                  )}
                  <div className="text-xs text-gray-500">上次叫 {p.lastQuantity} 桶，預估可撐 {p.estimatedDaysPerBatch} 天</div>
                  <div className="text-xs text-gray-400">單桶約撐 {p.daysPerBottle} 天{p.confidence === 'default' ? '（依客戶類型估算）' : ''}</div>
                  <div className="text-xs text-gray-500">上次：{p.lastGasType?.replace('BOTTLED_','').replace('KG','kg')} × {p.lastQuantity}</div>
                  {p.lineBound ? (
                    <button
                      onClick={async () => {
                        if (!window.confirm(`確定要發送 LINE 補貨提醒給「${p.customerName}」嗎？`)) return
                        setNotifyingId(p.customerId)
                        try {
                          await api.notifyPrediction(p.customerId)
                          setNotifiedIds(prev => new Set(prev).add(p.customerId))
                        } catch (e: any) {
                          alert(e.message || 'LINE 通知失敗')
                        } finally {
                          setNotifyingId(null)
                        }
                      }}
                      disabled={notifyingId === p.customerId || notifiedIds.has(p.customerId)}
                      className="mt-2 w-full py-1.5 bg-green-500 hover:bg-green-600 disabled:bg-gray-300 text-white text-xs font-bold rounded-lg flex items-center justify-center"
                    >
                      {notifiedIds.has(p.customerId) ? '✅ 已通知' : notifyingId === p.customerId ? '發送中...' : '📱 LINE 通知'}
                    </button>
                  ) : (
                    <a
                      href={`tel:${p.customerPhone}`}
                      className="mt-2 w-full py-1.5 bg-blue-500 text-white text-xs font-bold rounded-lg flex items-center justify-center"
                    >📞 撥打電話</a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {lineInquiries.length > 0 && (
        <div className="bg-purple-50 rounded-xl p-3">
          <button
            className="w-full flex items-center justify-between"
            onClick={() => setInquiriesExpanded(prev => !prev)}
          >
            <div className="text-sm font-bold text-purple-800">💬 LINE 詢問（不是叫瓦斯）<span className="ml-2 bg-purple-200 text-purple-800 text-xs px-2 py-0.5 rounded-full">{lineInquiries.length}</span></div>
            <span className="text-purple-400 text-xs">{inquiriesExpanded ? '▲ 收合' : '▼ 展開'}</span>
          </button>
          {inquiriesExpanded && (
            <div className="space-y-2 mt-2">
              {lineInquiries.map(inq => (
                <div key={inq.id} className="bg-white rounded-lg p-2.5 border border-purple-100">
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0">
                      <div className="text-xs text-gray-500">
                        {inq.customer_name ? `${inq.customer_name}（${inq.customer_phone}）` : '尚未綁定客戶'}
                        <span className="text-gray-300 ml-2">{new Date(inq.created_at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })}</span>
                      </div>
                      <div className="text-sm text-gray-800 mt-1 break-words">{inq.message}</div>
                    </div>
                    <button
                      onClick={async () => {
                        setInquiryActionId(inq.id)
                        try {
                          await api.handleLineInquiry(inq.id)
                          setLineInquiries(prev => prev.filter(x => x.id !== inq.id))
                        } catch { /* 失敗就算了，重新整理還是看得到 */ }
                        finally { setInquiryActionId(null) }
                      }}
                      disabled={inquiryActionId === inq.id}
                      className="text-xs text-purple-500 hover:text-purple-700 flex-shrink-0"
                    >✓ 已處理</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {['ALL','PENDING','DELIVERING','DELIVERED','SCHEDULED'].map(s => (
          <button key={s} onClick={() => setFilter(s)} className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition ${filter === s ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-600'}`}>
            {s === 'ALL' ? '全部' : s === 'SCHEDULED' ? '📅 已排定' : STATUS_LABEL[s]}
          </button>
        ))}
        <button onClick={load} className="flex-shrink-0 px-3 py-1.5 rounded-full text-sm bg-gray-100 text-gray-600">🔄</button>
        {pending.length > 0 && (
          <button
            onClick={toggleSelectMode}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition ${selectMode ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-600'}`}
          >
            ☑️ 多選
          </button>
        )}
      </div>
      {selectMode && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 flex items-center justify-between gap-2 sticky top-2 z-10">
          <div className="text-sm text-orange-800 font-medium">已選 {selectedIds.size} 筆</div>
          <div className="flex gap-2">
            <button onClick={selectAllPending} className="px-3 py-1.5 bg-white border border-orange-200 text-orange-600 text-xs font-bold rounded-lg">全選</button>
            <button
              onClick={bulkMarkDelivered}
              disabled={selectedIds.size === 0 || bulkLoading}
              className="px-3 py-1.5 bg-green-500 hover:bg-green-600 disabled:bg-gray-300 text-white text-xs font-bold rounded-lg"
            >
              {bulkLoading ? '處理中...' : `✅ 標記完成 (${selectedIds.size})`}
            </button>
          </div>
        </div>
      )}
      {loading && <div className="text-center text-gray-400 py-8">載入中...</div>}
      {!loading && pending.length > 0 && (
        <div className="space-y-3">
          {pending.map(order => {
            const lastDelivery = getLastDelivery(order)
            return (
            <div key={order.id} className={`bg-white border border-gray-200 border-l-4 ${STATUS_BORDER[order.status]} rounded-xl p-4 shadow-sm ${selectMode && selectedIds.has(order.id) ? 'ring-2 ring-orange-400' : ''}`}>
              {/* 卡片主體 - 點擊展開（多選模式下改成點擊勾選） */}
              <div className="cursor-pointer" onClick={() => selectMode ? toggleSelectOrder(order.id) : toggleExpand(order)}>
                <div className="flex justify-between items-start gap-2">
                  <div className="flex items-start gap-2 min-w-0">
                    {selectMode && (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(order.id)}
                        onChange={() => toggleSelectOrder(order.id)}
                        onClick={e => e.stopPropagation()}
                        className="w-5 h-5 mt-0.5 accent-orange-500 flex-shrink-0"
                      />
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-gray-800 text-lg">{order.customer_name}</span>
                        {onEditCustomer && (
                          <button
                            onClick={e => { e.stopPropagation(); onEditCustomer(order.customer_id) }}
                            className="text-xs text-blue-500"
                            title="編輯客戶資料"
                          >✏️</button>
                        )}
                      </div>
                      <a
                        href={mapsUrl(order.customer_address)}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        className="flex items-center gap-1 text-sm text-gray-600 hover:text-blue-600 mt-0.5"
                      >
                        <span>📍</span>
                        <span className="truncate">{order.customer_address}</span>
                      </a>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    {order.scheduled_date && (
                      <span className="text-xs px-2 py-1 rounded-full font-medium bg-purple-100 text-purple-700 whitespace-nowrap">
                        📅 {new Date(order.scheduled_date).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })}
                      </span>
                    )}
                    <span className={`text-xs px-2 py-1 rounded-full font-medium whitespace-nowrap ${STATUS_COLOR[order.status]}`}>{STATUS_LABEL[order.status]}</span>
                  </div>
                </div>

                {/* 重點區塊：品項/桶數 + 金額/付款方式，用色塊圈起來、字放大，這是司機真正要看的東西 */}
                <div className="flex justify-between items-center bg-gray-50 rounded-xl px-3 py-2.5 my-2.5">
                  <div className="text-xl font-bold text-gray-800">
                    {order.items && order.items.length > 0 ? (
                      <span>{order.items.map((i: any) => `${GAS_LABELS[i.gas_type]}×${i.quantity}`).join(' + ')}</span>
                    ) : (
                      <span>{order.quantity} 桶</span>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-xl font-bold text-gray-800">${Number(order.total_amount).toLocaleString()}</div>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${order.payment_type === 'AR' ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}>
                      {order.payment_type === 'AR' ? '📒 欠帳' : '💵 現金'}
                    </span>
                  </div>
                </div>

                {/* 次要資訊：來電時間、上次配送、備註、存氣，縮小集中放這裡，需要時看得到、平常不搶注意力 */}
                {(order.call_time || lastDelivery || order.note || returnsMap[order.customer_id]?.[0]) && (
                  <div className="text-xs text-gray-400 space-y-0.5">
                    {(order.call_time || lastDelivery) && (
                      <div className="flex gap-2 flex-wrap">
                        {order.call_time && <span>📞 {new Date(order.call_time).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })}</span>}
                        {lastDelivery && <span>🕓 上次配送 {daysAgoLabel(lastDelivery.created_at)}</span>}
                      </div>
                    )}
                    {order.note && <div className="text-orange-500">📝 {order.note}</div>}
                    {returnsMap[order.customer_id]?.[0] && (
                      <div>
                        *上次存氣 {returnsMap[order.customer_id][0].remaining_kg}kg
                        {Number(returnsMap[order.customer_id][0].amount) > 0
                          ? `（${returnsMap[order.customer_id][0].action === 'REFUND' ? '退費' : '抵扣'} $${Number(returnsMap[order.customer_id][0].amount).toLocaleString()}）`
                          : returnsMap[order.customer_id][0].action === 'RECORD' ? '（只記錄）' : ''
                        }
                      </div>
                    )}
                  </div>
                )}
                <div className="text-right text-xs text-gray-300 mt-1">{expandedId === order.id ? '收合 ▲' : '詳情 ▾'}</div>
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
                  {editItems.length === 1 && (
                    <label className="flex items-center gap-2 text-xs text-gray-600" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="w-4 h-4 accent-orange-500"
                        checked={editRememberPrice}
                        onChange={e => setEditRememberPrice(e.target.checked)}
                      />
                      🔒 記住這個單價（存成 {order.customer_name} 的特殊單價，以後自動帶入）
                    </label>
                  )}
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">備註</label>
                    <input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                      value={editNote} onChange={e => setEditNote(e.target.value)} onClick={e => e.stopPropagation()} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">付款方式</label>
                    <div className="flex gap-2">
                      {[['CASH', '💵 現金'], ['AR', '📒 欠帳']].map(([val, label]) => (
                        <button
                          key={val}
                          onClick={e => { e.stopPropagation(); setEditPaymentType(val) }}
                          className={`flex-1 py-1.5 rounded-lg text-sm font-medium transition ${editPaymentType === val ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-600'}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button onClick={e => { e.stopPropagation(); saveEdit(order) }} disabled={editLoading}
                    className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 text-white text-sm font-medium py-2 rounded-lg transition">
                    {editLoading ? '儲存中...' : '💾 儲存修改'}
                  </button>
                </div>
              )}
              {/* 操作按鈕 */}
              {/* 操作按鈕 */}
              <div className="flex gap-2 mt-3">
                <button onClick={e => { e.stopPropagation(); cancelOrder(order.id) }} disabled={actionId === order.id}
                  className="px-3 bg-gray-100 hover:bg-red-100 text-gray-500 hover:text-red-500 text-sm font-medium py-2 rounded-lg transition">
                  取消
                </button>
                {order.status === 'PENDING' && !isFutureScheduled(order) && (
                  <button onClick={e => { e.stopPropagation(); markDelivering(order.id) }} disabled={actionId === order.id}
                    className="flex-1 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-200 text-white text-sm font-medium py-2 rounded-lg transition">
                    🚛 開始配送
                  </button>
                )}
                {order.status === 'PENDING' && isFutureScheduled(order) && (
                  <div className="flex-1 bg-gray-50 text-gray-400 text-sm font-medium py-2 rounded-lg text-center">
                    ⏳ 尚未到配送日
                  </div>
                )}
                {(order.status === 'DELIVERING' || order.status === 'ASSIGNED') && (
                  <button onClick={e => { e.stopPropagation(); markDelivered(order) }} disabled={actionId === order.id}
                    className="flex-1 bg-green-500 hover:bg-green-600 disabled:bg-gray-200 text-white text-sm font-medium py-2 rounded-lg transition">
                    ✅ 完成送達
                  </button>
                )}
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
              <div className="flex justify-between items-start cursor-pointer" onClick={() => toggleExpand(order)}>
                <div>
                  <span className="font-medium text-gray-600">{order.customer_name}</span>
                  {onEditCustomer && (
                    <button
                      onClick={e => { e.stopPropagation(); onEditCustomer(order.customer_id) }}
                      className="text-xs text-blue-500 ml-2 align-middle"
                      title="編輯客戶資料"
                    >✏️ 客戶</button>
                  )}
                  <div className="text-xs text-gray-400 mt-0.5">{order.customer_address}</div>
                  {order.items && order.items.length > 0 && (
                    <div className="text-xs text-gray-400 mt-0.5">
                      {order.items.map((i: any) => `${GAS_LABELS[i.gas_type]}×${i.quantity}`).join(' + ')}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-sm text-gray-500">${Number(order.total_amount).toLocaleString()}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <button
                      onClick={e => { e.stopPropagation(); deleteOrder(order.id) }}
                      disabled={actionId === order.id}
                      className="text-xs text-gray-300 hover:text-red-500"
                      title="刪除訂單"
                    >🗑 刪除</button>
                    <span className="text-xs text-gray-300">{expandedId === order.id ? '收合 ▲' : '編輯 ▾'}</span>
                  </div>
                </div>
              </div>
              {expandedId === order.id && (
                <div className="mt-3 pt-3 border-t border-gray-200 space-y-3">
                  <div className="space-y-2">
                    {editItems.map((item, idx) => (
                      <div key={item.id || `new-${idx}`} className="flex items-center gap-2">
                        <select
                          className="w-20 flex-shrink-0 border border-gray-300 rounded-lg px-1.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-400"
                          value={item.gasType}
                          onChange={e => updateEditItem(idx, 'gasType', e.target.value)}
                        >
                          {Object.entries(GAS_LABELS).map(([val, label]) => (
                            <option key={val} value={val}>{label}</option>
                          ))}
                        </select>
                        <div className="flex-1">
                          <label className="block text-xs text-gray-400 mb-0.5">桶數</label>
                          <input type="number" className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                            value={item.quantity} onChange={e => updateEditItem(idx, 'quantity', e.target.value)} />
                        </div>
                        <div className="flex-1">
                          <label className="block text-xs text-gray-400 mb-0.5">單價</label>
                          <input type="number" className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                            value={item.unitPrice} onChange={e => updateEditItem(idx, 'unitPrice', e.target.value)} />
                        </div>
                        <div className="text-xs text-gray-500 w-16 text-right flex-shrink-0">
                          ${(Number(item.quantity || 0) * Number(item.unitPrice || 0)).toLocaleString()}
                        </div>
                        <button
                          onClick={() => removeEditItem(idx)}
                          disabled={editItems.length <= 1}
                          className="text-red-400 hover:text-red-600 disabled:text-gray-200 text-sm flex-shrink-0 w-5"
                          title="刪除此品項"
                        >✕</button>
                      </div>
                    ))}
                    <button
                      onClick={addEditItem}
                      className="w-full border border-dashed border-orange-300 text-orange-500 text-xs font-medium py-1.5 rounded-lg hover:bg-orange-50 transition"
                    >＋ 新增品項（不同規格）</button>
                  </div>
                  <div className="text-xs text-gray-500">合計：${editItemsTotal().toLocaleString()}</div>
                  {editItems.length === 1 && (
                    <label className="flex items-center gap-2 text-xs text-gray-600">
                      <input
                        type="checkbox"
                        className="w-4 h-4 accent-orange-500"
                        checked={editRememberPrice}
                        onChange={e => setEditRememberPrice(e.target.checked)}
                      />
                      🔒 記住這個單價（存成 {order.customer_name} 的特殊單價，以後自動帶入）
                    </label>
                  )}
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">備註</label>
                    <input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                      value={editNote} onChange={e => setEditNote(e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">付款方式</label>
                    <div className="flex gap-2">
                      {[['CASH', '💵 現金'], ['AR', '📒 欠帳']].map(([val, label]) => (
                        <button
                          key={val}
                          onClick={() => setEditPaymentType(val)}
                          className={`flex-1 py-1.5 rounded-lg text-sm font-medium transition ${editPaymentType === val ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-600'}`}
                        >{label}</button>
                      ))}
                    </div>
                  </div>
                  <button onClick={() => saveEdit(order)} disabled={editLoading}
                    className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 text-white text-sm font-medium py-2 rounded-lg transition">
                    {editLoading ? '儲存中...' : '💾 儲存修改'}
                  </button>
                  <div className="flex gap-2">
                    {order.status === 'DELIVERED' && (
                      <button onClick={() => undoDelivered(order.id)} disabled={actionId === order.id}
                        className="flex-1 bg-gray-100 hover:bg-orange-100 text-gray-500 hover:text-orange-600 text-xs font-medium py-2 rounded-lg transition">
                        ↩ 撤銷
                      </button>
                    )}
                    <button onClick={() => deleteOrder(order.id)} disabled={actionId === order.id}
                      className="flex-1 bg-gray-100 hover:bg-red-100 text-gray-500 hover:text-red-600 text-xs font-medium py-2 rounded-lg transition">
                      🗑 刪除
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {!loading && orders.length === 0 && <div className="text-center text-gray-400 py-12">{filter === 'SCHEDULED' ? '目前沒有排定的訂單' : '今日暫無訂單'}</div>}
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
