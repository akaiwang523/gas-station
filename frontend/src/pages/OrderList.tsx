import { useState, useEffect, useRef } from 'react'
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
  source: string | null
  items: any[]
}
// 訂單來源小標籤：目前只標 LINE（使用者最在意的區分），
// CALLER/SCHEDULED/MANUAL 已有別的方式看得出來（來電草稿區塊、已排定標籤等），先不加字重複
function SourceBadge({ source }: { source: string | null | undefined }) {
  if (source !== 'LINE') return null
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap flex-shrink-0"
      style={{ background: '#DCFCE7', color: '#15803D' }}
      title="LINE 官方帳號預訂"
    >LINE</span>
  )
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
// 基準價還沒載入或沒設定時的備用單價（與後端 fallback 一致）
const FALLBACK_PRICE: Record<string, number> = { BOTTLED_20KG: 800, BOTTLED_16KG: 650, BOTTLED_10KG: 450, BOTTLED_4KG: 200 }
// 橫向列（iPad landscape）專用狀態色票，跟設計稿的色碼對齊
const ROW_STATUS_STYLE: Record<string, { dot: string; bg: string; text: string; label: string }> = {
  PENDING: { dot: '#F59E0B', bg: '#FEF3C7', text: '#92400E', label: '待派送' },
  ASSIGNED: { dot: '#3B82F6', bg: '#EFF6FF', text: '#1E40AF', label: '配送中' },
  DELIVERING: { dot: '#3B82F6', bg: '#EFF6FF', text: '#1E40AF', label: '配送中' },
}
const ROW_SCHEDULED_STYLE = { dot: '#8B5CF6', bg: '#F3E8FF', text: '#5B21B6', label: '已排定' }
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
  // 用 toISOString() 抓「今天」是 UTC 日期，跟 scheduled_date（台北時間的日期）比較，
  // 在台北時間凌晨 0~8 點（UTC 還是前一天）會把「今天就該配送」的單誤判成「還沒到配送日」
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' })
  return sched > today
}
// 同一張待送單，當天客戶又打來一次時，後端會把「（再次來電 HH:MM）」附加進 note——
// 用這個判斷要不要在卡片上跳紅底提醒，讓司機/接單的人一眼看出這張單客戶已經催過
function isRepeatCall(order: { note: string | null }) {
  return !!order.note && order.note.includes('再次來電')
}
export default function OrderList({ refresh, onEditCustomer }: { refresh?: number; onEditCustomer?: (customerId: number) => void }) {
  const [orders, setOrders] = useState<Order[]>([])
  const [returnsMap, setReturnsMap] = useState<Record<number, any[]>>({})
  const [summary, setSummary] = useState<any>(null)
  const [counts, setCounts] = useState<any>(null)
  const [filter, setFilter] = useState('PENDING')
  const [loading, setLoading] = useState(true)
  const [actionId, setActionId] = useState<number | null>(null)
  const [returnModal, setReturnModal] = useState<{orderId: number, customerId: number, customerName: string} | null>(null)
  const [returnKg, setReturnKg] = useState('')
  const [returnAction, setReturnAction] = useState('RECORD')
  const [predictions, setPredictions] = useState<any[]>([])
  const [lowConfPredictions, setLowConfPredictions] = useState<any[]>([])
  const [notifiedIds, setNotifiedIds] = useState<Set<number>>(new Set())
  const [notifyingId, setNotifyingId] = useState<number | null>(null)
  const [predExpanded, setPredExpanded] = useState(false)
  const [lowConfExpanded, setLowConfExpanded] = useState(false)
  const [lineInquiries, setLineInquiries] = useState<any[]>([])
  const [inquiriesExpanded, setInquiriesExpanded] = useState(false)
  const [baselinePrices, setBaselinePrices] = useState<Record<string, number>>({})
  const [inquiryActionId, setInquiryActionId] = useState<number | null>(null)
  const [drafts, setDrafts] = useState<Order[]>([])
  const [draftEditId, setDraftEditId] = useState<number | null>(null)
  const [draftItems, setDraftItems] = useState<{ gasType: string; quantity: string; unitPrice: string }[]>([{ gasType: 'BOTTLED_20KG', quantity: '1', unitPrice: '800' }])
  const [draftRememberPrice, setDraftRememberPrice] = useState(false)
  const [draftRememberPriceIndex, setDraftRememberPriceIndex] = useState(0)
  const [draftPaymentType, setDraftPaymentType] = useState('CASH')
  const [draftScheduledDate, setDraftScheduledDate] = useState('')
  const [draftConfirmLoading, setDraftConfirmLoading] = useState(false)
  const [returnAmount, setReturnAmount] = useState('')
  const [returnNote, setReturnNote] = useState('')
  const [returnLoading, setReturnLoading] = useState(false)
  // 展開編輯（多品項：每個品項各自一行）
  const [expandedId, setExpandedId] = useState<number | null>(null)
  // 「更多」展開後，裡面哪一個收合區塊是打開的（歷史紀錄／修改品項），一次只開一個
  const [moreSection, setMoreSection] = useState<'history' | 'edit' | null>(null)
  const [editItems, setEditItems] = useState<{ id: number; gasType: string; quantity: string; unitPrice: string }[]>([])
  const [editNote, setEditNote] = useState('')
  const [editPaymentType, setEditPaymentType] = useState('CASH')
  const [editRememberPrice, setEditRememberPrice] = useState(false)
  const [editRememberPriceIndex, setEditRememberPriceIndex] = useState(0)
  const [editLoading, setEditLoading] = useState(false)
  // 手動改過單價的品項（index），其餘品項的單價都由系統自動帶入
  const [manualPriceIdx, setManualPriceIdx] = useState<Set<number>>(new Set())
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
      const [res, sum, cnt] = await Promise.all([api.getOrders(params), api.getTodaySummary(), api.getOrderCounts()])
      setOrders(res.orders)
      setSummary(sum)
      setCounts(cnt)
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
        setLowConfPredictions(pred.lowConfidence || [])
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
  useEffect(() => { api.getBaselinePrices().then(res => setBaselinePrices(res.prices || {})).catch(() => {}) }, [])

  // 輪詢 LINE 活動：LINE 官方帳號進來的新訂單／新對話不會經過瀏覽器裡任何操作
  // （webhook 直接寫資料庫），所以原本要手動重新整理才看得到。這裡改成每 5 秒問一次
  // 「目前最新的 LINE 訂單/詢問 id」這種輕量資訊，發現變大了才真的重新整理整個列表
  // 預測清單不再常駐在頁面最上方，改成頂部一顆「快用完 N 位」，點了才展開
  const [showPredictions, setShowPredictions] = useState(false)
  const lineActivityRef = useRef<{ orderId: number; inquiryId: number } | null>(null)
  // 計時器只在第一次建立，裡面如果直接呼叫 load 會一直拿到「第一次畫面」時的舊 load（舊篩選條件），
  // 所以透過 ref 永遠呼叫最新的 load
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    let cancelled = false
    async function checkLineActivity() {
      try {
        const res = await api.getLineActivity()
        const prev = lineActivityRef.current
        if (prev && (res.latestOrderId > prev.orderId || res.latestInquiryId > prev.inquiryId)) {
          if (!cancelled) loadRef.current()
        }
        lineActivityRef.current = { orderId: res.latestOrderId, inquiryId: res.latestInquiryId }
      } catch { /* 這只是背景檢查，失敗就下次再試，不用打擾使用者 */ }
    }
    checkLineActivity()
    const timer = setInterval(checkLineActivity, 5000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])
  // 取得某筆訂單「上一次」的配送紀錄（排除自己）
  function getLastDelivery(order: Order) {
    const hist = customerHistory[order.customer_id]
    if (!hist) return null
    return hist.find((h: any) => h.id !== order.id) || null
  }
  // 取得某位客戶「上次同規格」的單價（排除目前這筆訂單），找不到回傳 null
  function getLastUnitPrice(order: Order, gasType: string): number | null {
    const hist = customerHistory[order.customer_id]
    if (!hist) return null
    for (const h of hist) {
      if (h.id === order.id) continue
      if (h.items?.length > 0) {
        const it = h.items.find((i: any) => i.gas_type === gasType)
        if (it && Number(it.unit_price) > 0) return Number(it.unit_price)
      } else if (gasType === 'BOTTLED_20KG' && Number(h.unit_price) > 0) {
        // 沒有品項明細的舊資料，只當作 20kg 的單價
        return Number(h.unit_price)
      }
    }
    return null
  }
  async function toggleExpand(order: Order) {
    if (expandedId === order.id) { setExpandedId(null); return }
    setExpandedId(order.id)
    setMoreSection(null)
    if (order.items && order.items.length > 0) {
      setEditItems(order.items.map((i: any) => ({
        id: i.id, gasType: i.gas_type, quantity: String(Number(i.quantity)), unitPrice: String(Number(i.unit_price)),
      })))
    } else {
      // 沒有品項明細的舊資料，退回用訂單主表的桶數/單價當作單一品項
      setEditItems([{ id: 0, gasType: 'BOTTLED_20KG', quantity: String(Number(order.quantity)), unitPrice: String(Number(order.unit_price)) }])
    }
    setEditNote(order.note || '')
    setEditPaymentType(order.payment_type)
    setEditRememberPrice(false)
    setEditRememberPriceIndex(0)
    setManualPriceIdx(new Set())
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
      // 「記住這個單價」：品項單價都一樣時直接存那個數字；不一樣時用下拉選單選的那個品項的單價
      if (editRememberPrice) {
        const uniquePrices = new Set(editItems.map(i => Number(i.unitPrice) || 0))
        const chosen = uniquePrices.size === 1
          ? editItems[0]
          : (editItems[editRememberPriceIndex] || editItems[0])
        if (chosen) {
          try { await api.updateCustomer(order.customer_id, { price_override: Number(chosen.unitPrice) || 0 }) } catch { /* 訂單已經存好了，這步失敗不影響本次修改 */ }
        }
      }
      setExpandedId(null)
      await load()
    } catch (e: any) {
      alert(e.message)
    } finally {
      setEditLoading(false)
    }
  }
  // 更新編輯中某個品項的某個欄位（新增、尚未存檔的品項，改規格時價格自動帶入該規格的目前基準價）
  // 自動單價：新增品項或換規格時不用手動填，依序採用
  //   1. 同一張單裡已經有同規格的品項 → 用那一項的單價
  //   2. 這位客戶上次叫同規格的單價
  //   3. 目前的基準價
  function autoPrice(order: Order | undefined, gasType: string, items: typeof editItems, skipIdx: number): { price: number; source: string } {
    const same = items.find((it, i) => i !== skipIdx && it.gasType === gasType && Number(it.unitPrice) > 0)
    if (same) return { price: Number(same.unitPrice), source: '同單' }
    const last = order ? getLastUnitPrice(order, gasType) : null
    if (last !== null) return { price: last, source: '上次價' }
    return { price: baselinePrices[gasType] || FALLBACK_PRICE[gasType] || 0, source: '基準價' }
  }
  function priceSource(order: Order | undefined, idx: number): string {
    const it = editItems[idx]
    if (!it) return ''
    const p = Number(it.unitPrice)
    const last = order ? getLastUnitPrice(order, it.gasType) : null
    if (last !== null && last === p) return '上次價'
    if ((baselinePrices[it.gasType] || FALLBACK_PRICE[it.gasType]) === p) return '基準價'
    return ''
  }
  function updateEditItem(index: number, field: 'gasType' | 'quantity' | 'unitPrice', value: string, order?: Order) {
    setEditItems(items => items.map((it, i) => {
      if (i !== index) return it
      if (field === 'gasType') {
        // 換規格時價格一定跟著換，除非這一項已經手動改過價
        if (manualPriceIdx.has(index)) return { ...it, gasType: value }
        const { price } = autoPrice(order, value, items, index)
        return { ...it, gasType: value, unitPrice: price ? String(price) : it.unitPrice }
      }
      return { ...it, [field]: value }
    }))
  }
  // 新增品項：沿用最後一項的規格，單價自動帶入
  function addEditItem(order?: Order) {
    setEditItems(items => {
      const gasType = items[items.length - 1]?.gasType || 'BOTTLED_20KG'
      const { price } = autoPrice(order, gasType, items, -1)
      return [...items, { id: 0, gasType, quantity: '1', unitPrice: price ? String(price) : '' }]
    })
  }
  // 移除一個品項（至少保留一個，不能刪到完全沒有品項）
  function removeEditItem(index: number) {
    setEditItems(items => items.length <= 1 ? items : items.filter((_, i) => i !== index))
    setManualPriceIdx(new Set())
  }
  function toggleManualPrice(index: number, order?: Order) {
    setManualPriceIdx(prev => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
        // 恢復自動：重新套用自動單價
        setEditItems(items => items.map((it, i) => {
          if (i !== index) return it
          const { price } = autoPrice(order, it.gasType, items, index)
          return price ? { ...it, unitPrice: String(price) } : it
        }))
      } else next.add(index)
      return next
    })
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
  // 防呆：確認框寫出客戶、品項、金額，避免在清單上點錯列取消到別人的單
  async function cancelOrder(order: Order) {
    const id = order.id
    const who = order.customer_name || order.customer_phone || `#${id}`
    const items = order.items && order.items.length > 0
      ? order.items.map((i: any) => `${GAS_LABELS[i.gas_type] || i.gas_type}×${i.quantity}`).join('、')
      : `${order.quantity} 桶`
    const amount = `$${Number(order.total_amount).toLocaleString()}`
    const ar = order.payment_type === 'AR' ? '\n（欠帳單，取消後會把欠款扣回）' : ''
    if (!window.confirm(`確定取消這張訂單？\n\n${who}\n${items}　${amount}${ar}\n\n取消後會從待送清單移除。`)) return
    setActionId(id)
    try { await api.cancelOrder(id); await load() }
    finally { setActionId(null) }
  }
  // 當日沒送到的訂單改期到明天：只改 scheduled_date，品項/金額不變
  async function postponeToTomorrow(order: Order) {
    if (!window.confirm(`確定要把 ${order.customer_name} 這筆訂單延到明天嗎？`)) return
    setActionId(order.id)
    try {
      const t = new Date()
      t.setDate(t.getDate() + 1)
      const dateStr = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
      await api.rescheduleOrder(order.id, dateStr)
      await load()
    } finally { setActionId(null) }
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
    setDraftRememberPriceIndex(0)
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
      if (draftRememberPrice) {
        const uniquePrices = new Set(draftItems.map(i => Number(i.unitPrice) || 0))
        const chosen = uniquePrices.size === 1
          ? draftItems[0]
          : (draftItems[draftRememberPriceIndex] || draftItems[0])
        if (chosen) {
          try { await api.updateCustomer(customerId, { price_override: Number(chosen.unitPrice) || 0 }) } catch { /* 訂單已經建好了，這步失敗不影響本次派單 */ }
        }
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
  // 預測卡片的樣式兩個區塊共用（主清單 + 資料不足區塊），差別只在「取消提醒」要從哪一個清單移除
  function renderPredictionCard(p: any, isLowConf: boolean) {
    return (
        <div key={p.customerId} className="flex-shrink-0 w-56 bg-white rounded-xl p-3 border border-blue-200 shadow-sm relative">
          <button
            onClick={async () => {
              (isLowConf ? setLowConfPredictions : setPredictions)(prev => prev.filter((x: any) => x.customerId !== p.customerId))
              try { await api.dismissPrediction(p.customerId) } catch { /* 失敗就算了，下次重新整理還是會抓到最新狀態 */ }
            }}
            className="absolute top-1.5 right-1.5 text-gray-300 hover:text-gray-500 text-sm w-5 h-5 flex items-center justify-center"
            title="取消這一輪提醒（下次他有新訂單才會重新提醒）"
          >✕</button>
          <div className="pr-4">
            <div className="font-bold text-gray-800 text-sm break-words">{p.customerName}</div>
            {p.confidence === 'default' && (
              <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded inline-block mt-0.5" title="資料還不夠多，用客戶類型的預設值估算，僅供參考">僅供參考</span>
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
    )
  }
  return (
    <div className="max-w-lg lg:max-w-3xl mx-auto p-4 space-y-4">
      {/* 頂部：日期＋一行精簡統計（今天已送達口徑，跟「已完成」分頁一致），右邊是預測入口 */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h2 className="text-lg font-bold text-gray-800">
            {new Date().toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short', timeZone: 'Asia/Taipei' })}
          </h2>
          {summary && (
            <span className="text-sm text-gray-500">
              今日已送 {summary.delivered_orders ?? 0} 單 · {summary.delivered_cylinders ?? 0} 桶 · 現金 ${Number(summary.delivered_cash || 0).toLocaleString()}
              {Number(summary.delivered_ar || 0) > 0 && <> · 欠帳 ${Number(summary.delivered_ar).toLocaleString()}</>}
            </span>
          )}
        </div>
        {(predictions.length > 0 || lowConfPredictions.length > 0) && (
          <button
            onClick={() => { setShowPredictions(v => !v); setPredExpanded(true) }}
            className={`px-3 py-1.5 rounded-full text-sm border transition ${showPredictions ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-blue-700 border-blue-200'}`}
          >
            快用完 {predictions.length} 位 {showPredictions ? '▲' : '›'}
          </button>
        )}
      </div>
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
                    {draftItems.length > 0 && (
                      <div className="text-xs text-gray-600 space-y-1">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            className="w-4 h-4 accent-orange-500"
                            checked={draftRememberPrice}
                            onChange={e => setDraftRememberPrice(e.target.checked)}
                          />
                          🔒 記住這個單價（存成 {d.customer_name} 的特殊單價，以後自動帶入）
                        </label>
                        {draftRememberPrice && new Set(draftItems.map(i => Number(i.unitPrice) || 0)).size > 1 && (
                          <div className="flex items-center gap-2 pl-6">
                            <span>品項單價不同，記住哪一個：</span>
                            <select
                              className="border border-gray-300 rounded-lg px-2 py-1 text-xs"
                              value={draftRememberPriceIndex}
                              onChange={e => setDraftRememberPriceIndex(Number(e.target.value))}
                            >
                              {draftItems.map((it, idx) => (
                                <option key={idx} value={idx}>
                                  {GAS_LABELS[it.gasType] || it.gasType} — ${it.unitPrice}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
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
      {showPredictions && predictions.length > 0 && (
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
              {predictions.map(p => renderPredictionCard(p, false))}
            </div>
          )}
        </div>
      )}
      {showPredictions && lowConfPredictions.length > 0 && (
        <div className="bg-gray-50 rounded-xl p-3">
          <button
            className="w-full flex items-center justify-between"
            onClick={() => setLowConfExpanded(prev => !prev)}
          >
            <div className="text-sm font-bold text-gray-500">
              🤔 資料不足，僅供參考
              <span className="ml-2 bg-gray-200 text-gray-600 text-xs px-2 py-0.5 rounded-full">{lowConfPredictions.length}</span>
            </div>
            <span className="text-gray-400 text-xs">{lowConfExpanded ? '▲ 收合' : '▼ 展開'}</span>
          </button>
          {lowConfExpanded && (
            <>
              <div className="text-xs text-gray-400 mt-1">
                這些客戶只叫過 1-2 次，沒有足夠紀錄推算週期，是用客戶類型的預設值猜的，準確度低。等他們累積到第 3 次叫貨就會自動移到上面的主清單。
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1 mt-2">
                {lowConfPredictions.map(p => renderPredictionCard(p, true))}
              </div>
            </>
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
        {['PENDING','DELIVERING','DELIVERED','SCHEDULED'].map(s => {
          const countKey = s === 'PENDING' ? 'pending' : s === 'DELIVERING' ? 'delivering' : s === 'DELIVERED' ? 'delivered' : 'scheduled'
          const count = counts?.[countKey]
          return (
          <button key={s} onClick={() => setFilter(s)} className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition ${filter === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
            {s === 'SCHEDULED' ? '📅 已排定' : STATUS_LABEL[s]}
            {count != null && <span className="ml-1 opacity-70">{count}</span>}
          </button>
          )
        })}
        <button onClick={load} className="flex-shrink-0 px-3 py-1.5 rounded-full text-sm bg-gray-100 text-gray-600">🔄</button>
        {pending.length > 0 && (
          <button
            onClick={toggleSelectMode}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition ${selectMode ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'}`}
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
            const rowStatus = isFutureScheduled(order) ? ROW_SCHEDULED_STYLE : (ROW_STATUS_STYLE[order.status] || ROW_STATUS_STYLE.PENDING)
            return (
            <div key={order.id} className={`relative bg-white border border-slate-200 border-l-4 rounded-2xl shadow-sm ${selectMode && selectedIds.has(order.id) ? 'ring-2 ring-orange-400' : ''}`} style={{ borderLeftColor: rowStatus.dot }}>
              {/* 主資訊：送貨員要看的只有「誰、哪裡、什麼、多少錢」，加上一顆「完成」 */}
              <div
                className="px-4 py-3 lg:py-2.5 cursor-pointer flex flex-col lg:grid lg:items-center lg:gap-x-5"
                style={{ gridTemplateColumns: 'minmax(220px,44fr) minmax(110px,18fr) minmax(110px,16fr) minmax(170px,22fr)' }}
                onClick={() => selectMode ? toggleSelectOrder(order.id) : toggleExpand(order)}
              >
                {/* 客戶／地址／電話 */}
                <div className="min-w-0 flex items-start gap-2.5">
                  {selectMode && (
                    <input
                      type="checkbox"
                      checked={selectedIds.has(order.id)}
                      onChange={() => toggleSelectOrder(order.id)}
                      onClick={e => e.stopPropagation()}
                      className="w-5 h-5 mt-1 accent-orange-500 flex-shrink-0"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="truncate text-lg font-bold text-slate-900 leading-tight">{order.customer_name}</span>
                      {onEditCustomer && (
                        <button
                          onClick={e => { e.stopPropagation(); onEditCustomer(order.customer_id) }}
                          className="text-slate-400 hover:text-blue-600 flex-shrink-0 p-1 -m-1"
                          title="編輯客戶資料"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                        </button>
                      )}
                      {/* 在「待派送」分頁裡，一般待派送單不用再標狀態；只標例外（已排定、配送中、再次來電、LINE） */}
                      {!(order.status === 'PENDING' && !order.scheduled_date) && (
                        <span className="rounded-full font-medium whitespace-nowrap text-[11px] px-2 py-0.5 flex-shrink-0" style={{ background: rowStatus.bg, color: rowStatus.text }}>
                          {rowStatus.label}{order.scheduled_date ? ` ${new Date(order.scheduled_date).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })}` : ''}
                        </span>
                      )}
                      {isRepeatCall(order) && (
                        <span className="rounded-full font-medium whitespace-nowrap text-[11px] px-2 py-0.5 bg-red-500 text-white flex-shrink-0">再次來電</span>
                      )}
                      <SourceBadge source={order.source} />
                      {order.customer_phone && (
                        <a href={`tel:${order.customer_phone}`} onClick={e => e.stopPropagation()}
                          className="hidden lg:inline ml-1 text-[13px] text-slate-500 hover:text-blue-600 tabular-nums whitespace-nowrap">
                          {order.customer_phone}
                        </a>
                      )}
                    </div>
                    <a
                      href={mapsUrl(order.customer_address)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="flex items-center gap-1 text-[15px] text-slate-700 hover:text-blue-600 min-w-0 mt-0.5"
                    >
                      <svg className="flex-shrink-0 text-slate-400" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
                      <span className="truncate">{order.customer_address}</span>
                    </a>
                    {order.customer_phone && (
                      <a
                        href={`tel:${order.customer_phone}`}
                        onClick={e => e.stopPropagation()}
                        className="inline-flex lg:hidden items-center gap-1 text-[13px] text-slate-500 hover:text-blue-600 mt-0.5 tabular-nums"
                      >
                        <svg className="flex-shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                        {order.customer_phone}
                      </a>
                    )}
                    {(order.note || returnsMap[order.customer_id]?.[0]) && (
                      <div className="hidden lg:block truncate text-xs text-slate-500 mt-0.5">
                        {order.note && <span className="text-slate-600">備註：{order.note}</span>}
                        {order.note && returnsMap[order.customer_id]?.[0] && <span className="mx-2 text-slate-300">|</span>}
                        {returnsMap[order.customer_id]?.[0] && <span className="text-amber-700">上次存氣 {returnsMap[order.customer_id][0].remaining_kg}kg</span>}
                      </div>
                    )}
                  </div>
                </div>

                {/* 品項 + 金額（直向時合併成一個淡色區塊；橫向拆成兩欄） */}
                <div className="flex justify-between items-center bg-slate-50 rounded-xl px-3 py-2 my-2.5 lg:contents">
                  <div className="text-xl lg:text-lg font-bold text-slate-900 min-w-0">
                    {order.items && order.items.length > 0
                      ? order.items.map((i: any, idx: number) => (
                          <div key={idx} className="whitespace-nowrap">{GAS_LABELS[i.gas_type] || i.gas_type} × {i.quantity}</div>
                        ))
                      : <div className="whitespace-nowrap">{order.quantity} 桶</div>}
                  </div>
                  <div className="text-right lg:text-left flex-shrink-0">
                    <div className="text-xl lg:text-lg font-bold text-slate-900 tabular-nums">${Number(order.total_amount).toLocaleString()}</div>
                    <div className={`text-sm font-medium ${order.payment_type === 'AR' ? 'text-red-600' : 'text-slate-500'}`}>
                      {order.payment_type === 'AR' ? '記帳' : '現金'}
                    </div>
                    {order.call_time && (
                      <div className="hidden lg:block text-xs text-slate-400 tabular-nums">
                        來電 {new Date(order.call_time).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })}
                      </div>
                    )}
                  </div>
                </div>

                {/* 主要操作：完成（單一主按鈕），其他收進「更多」 */}
                <div className="order-4 lg:order-none mt-3 lg:mt-0 flex items-stretch gap-2 lg:justify-end" onClick={e => e.stopPropagation()}>
                  {isFutureScheduled(order) ? (
                    <div className="flex-1 lg:flex-none h-12 lg:h-11 lg:w-32 flex items-center justify-center bg-slate-50 text-slate-400 text-sm font-medium rounded-xl">未到配送日</div>
                  ) : (
                    <button
                      onClick={() => markDelivered(order)}
                      disabled={actionId === order.id}
                      className="flex-1 lg:flex-none h-12 lg:h-11 lg:w-32 flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:bg-slate-300 text-white text-base font-bold rounded-xl transition"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                      {actionId === order.id ? '處理中…' : '完成'}
                    </button>
                  )}
                  <button
                    onClick={() => toggleExpand(order)}
                    title={expandedId === order.id ? '收合' : '更多'}
                    className={`w-12 lg:w-11 h-12 lg:h-11 flex items-center justify-center rounded-xl border text-slate-500 hover:text-slate-800 flex-shrink-0 ${expandedId === order.id ? 'bg-slate-100 border-slate-300' : 'bg-white border-slate-200'}`}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
                  </button>
                </div>

                {/* 次要資訊：備註、存氣、上次配送、來電時間（直向） */}
                {(order.note || returnsMap[order.customer_id]?.[0] || order.call_time) && (
                  <div className="order-3 lg:hidden text-[13px] text-slate-500 space-y-0.5">
                    {order.note && <div className="text-slate-700">備註：{order.note}</div>}
                    {returnsMap[order.customer_id]?.[0] && (
                      <div className="text-amber-700">
                        上次存氣 {returnsMap[order.customer_id][0].remaining_kg}kg
                        {Number(returnsMap[order.customer_id][0].amount) > 0
                          ? `（${returnsMap[order.customer_id][0].action === 'REFUND' ? '退費' : '抵扣'} $${Number(returnsMap[order.customer_id][0].amount).toLocaleString()}）`
                          : returnsMap[order.customer_id][0].action === 'RECORD' ? '（只記錄）' : ''}
                      </div>
                    )}
                    {order.call_time && (
                      <div className="flex gap-3 flex-wrap text-slate-400">
                        {order.call_time && (
                          <span>來電 {new Date(order.call_time).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })}</span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 更多：管理／編輯功能，預設收合 */}
              {expandedId === order.id && (() => {
                const history = (customerHistory[order.customer_id] || []).filter((h: any) => h.id !== order.id)
                return (
                <div className="border-t border-slate-100 px-4 pb-4 pt-2" onClick={e => e.stopPropagation()}>
                  {/* 歷史叫貨紀錄 */}
                  {history.length > 0 && (
                    <div className="border-b border-slate-100">
                      <button onClick={() => setMoreSection(s => s === 'history' ? null : 'history')} className="w-full h-11 flex items-center justify-between text-sm text-slate-700">
                        <span>歷史叫貨紀錄（{Math.min(history.length, 3)} 筆）</span>
                        <svg className={`text-slate-400 transition ${moreSection === 'history' ? 'rotate-180' : ''}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                      </button>
                      {moreSection === 'history' && (
                        <div className="pb-3 space-y-1">
                          {history.slice(0, 3).map((h: any) => (
                            <div key={h.id} className="grid grid-cols-3 text-sm text-slate-600 tabular-nums">
                              <span>{new Date(h.created_at).toLocaleDateString('zh-TW')}</span>
                              <span>{h.items?.length > 0 ? h.items.map((i: any) => `${GAS_LABELS[i.gas_type] || i.gas_type}×${i.quantity}`).join('+') : `${h.quantity}桶`}</span>
                              <span className="text-right">${Number(h.total_amount).toLocaleString()}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* 修改品項與價格 */}
                  <div className="border-b border-slate-100">
                    <button onClick={() => setMoreSection(s => s === 'edit' ? null : 'edit')} className="w-full h-11 flex items-center justify-between text-sm text-slate-700">
                      <span>修改品項、價格、備註、付款方式</span>
                      <svg className={`text-slate-400 transition ${moreSection === 'edit' ? 'rotate-180' : ''}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                    </button>
                    {moreSection === 'edit' && (
                      <div className="pb-4 space-y-3">
                        {editItems.map((item, idx) => (
                          <div key={item.id || `new-${idx}`} className="flex items-end gap-2">
                            <div className="w-20 flex-shrink-0">
                              <label className="block text-xs text-slate-400 mb-0.5">規格</label>
                              <select
                                className="w-full h-10 border border-slate-300 rounded-lg px-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
                                value={item.gasType}
                                onChange={e => updateEditItem(idx, 'gasType', e.target.value, order)}
                              >
                                {Object.entries(GAS_LABELS).map(([val, label]) => (
                                  <option key={val} value={val}>{label}</option>
                                ))}
                              </select>
                            </div>
                            <div className="w-20">
                              <label className="block text-xs text-slate-400 mb-0.5">桶數</label>
                              <input type="number" className="w-full h-10 border border-slate-300 rounded-lg px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                                value={item.quantity} onChange={e => updateEditItem(idx, 'quantity', e.target.value)} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 text-xs text-slate-400 mb-0.5">
                                <span>單價</span>
                                <button
                                  type="button"
                                  onClick={() => toggleManualPrice(idx, order)}
                                  className="text-blue-600 hover:text-blue-800 px-1.5 py-1 -my-1 rounded"
                                >{manualPriceIdx.has(idx) ? '恢復自動' : '改價'}</button>
                              </div>
                              {manualPriceIdx.has(idx) ? (
                                <input type="number" inputMode="numeric" autoFocus className="w-full h-10 border border-slate-300 rounded-lg px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                                  value={item.unitPrice} onChange={e => updateEditItem(idx, 'unitPrice', e.target.value)} />
                              ) : (
                                <div className="h-10 flex items-center gap-2 text-base text-slate-800 tabular-nums">
                                  ${Number(item.unitPrice || 0).toLocaleString()}
                                  {priceSource(order, idx) && <span className="text-xs text-slate-400">{priceSource(order, idx)}</span>}
                                </div>
                              )}
                            </div>
                            <div className="h-10 flex items-center text-sm text-slate-600 w-16 justify-end flex-shrink-0 tabular-nums">
                              ${(Number(item.quantity || 0) * Number(item.unitPrice || 0)).toLocaleString()}
                            </div>
                            <button
                              onClick={() => removeEditItem(idx)}
                              disabled={editItems.length <= 1}
                              className="h-10 w-8 flex items-center justify-center text-slate-400 hover:text-red-500 disabled:text-slate-200 flex-shrink-0"
                              title="刪除此品項"
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                            </button>
                          </div>
                        ))}
                        <div className="flex items-center justify-between">
                          <button onClick={() => addEditItem(order)} className="h-9 px-3 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-50">＋ 新增品項</button>
                          <span className="text-sm text-slate-600">合計 <span className="font-bold tabular-nums">${editItemsTotal().toLocaleString()}</span></span>
                        </div>
                        {editItems.length > 0 && (
                          <div className="text-sm text-slate-600 space-y-1">
                            <label className="flex items-center gap-2">
                              <input type="checkbox" className="w-4 h-4 accent-blue-600" checked={editRememberPrice} onChange={e => setEditRememberPrice(e.target.checked)} />
                              記住這個單價（存成 {order.customer_name} 的特殊單價，以後自動帶入）
                            </label>
                            {editRememberPrice && new Set(editItems.map(i => Number(i.unitPrice) || 0)).size > 1 && (
                              <div className="flex items-center gap-2 pl-6">
                                <span>品項單價不同，記住哪一個：</span>
                                <select className="border border-slate-300 rounded-lg px-2 py-1 text-sm bg-white" value={editRememberPriceIndex} onChange={e => setEditRememberPriceIndex(Number(e.target.value))}>
                                  {editItems.map((it, idx) => (
                                    <option key={idx} value={idx}>{GAS_LABELS[it.gasType] || it.gasType} — ${it.unitPrice}</option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </div>
                        )}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs text-slate-400 mb-0.5">備註</label>
                            <input className="w-full h-10 border border-slate-300 rounded-lg px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                              value={editNote} onChange={e => setEditNote(e.target.value)} />
                          </div>
                          <div>
                            <label className="block text-xs text-slate-400 mb-0.5">付款方式</label>
                            <div className="grid grid-cols-2 gap-2">
                              {[['CASH', '現金'], ['AR', '記帳']].map(([val, label]) => (
                                <button
                                  key={val}
                                  onClick={() => setEditPaymentType(val)}
                                  className={`h-10 rounded-lg text-sm font-medium border ${editPaymentType === val ? 'bg-slate-800 border-slate-800 text-white' : 'bg-white border-slate-300 text-slate-600'}`}
                                >{label}</button>
                              ))}
                            </div>
                          </div>
                        </div>
                        <button onClick={() => saveEdit(order)} disabled={editLoading}
                          className="w-full h-10 bg-slate-800 hover:bg-slate-900 disabled:bg-slate-300 text-white text-sm font-medium rounded-lg">
                          {editLoading ? '儲存中…' : '儲存修改'}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* 低頻操作 */}
                  <div className="flex items-center justify-end gap-4 pt-3">
                    {order.status === 'PENDING' && !isFutureScheduled(order) && (
                      <button onClick={() => postponeToTomorrow(order)} disabled={actionId === order.id}
                        className="text-sm text-slate-500 hover:text-slate-800 disabled:opacity-50 py-1">延到明天</button>
                    )}
                    <button onClick={() => cancelOrder(order)} disabled={actionId === order.id}
                      className="text-sm text-slate-400 hover:text-red-600 disabled:opacity-50 py-1">取消此筆訂單</button>
                  </div>
                </div>
                )
              })()}
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
                  <SourceBadge source={order.source} />
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
                          onChange={e => updateEditItem(idx, 'gasType', e.target.value, order)}
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
                          <div className="flex items-center gap-2 flex-wrap text-xs text-gray-400 mb-0.5">
                            <span>單價</span>
                            <button
                              type="button"
                              onClick={e => { e.stopPropagation(); updateEditItem(idx, 'unitPrice', String(baselinePrices[item.gasType] ?? item.unitPrice)) }}
                              className="text-blue-500 hover:text-blue-700 font-normal px-1.5 py-1 -my-1 rounded"
                              title="套用目前基準價"
                            >套用基準價</button>
                            {getLastUnitPrice(order, item.gasType) !== null && (
                              <button
                                type="button"
                                onClick={e => { e.stopPropagation(); updateEditItem(idx, 'unitPrice', String(getLastUnitPrice(order, item.gasType))) }}
                                className="text-green-600 hover:text-green-800 font-normal px-1.5 py-1 -my-1 rounded"
                                title="套用這位客戶上次同規格的單價"
                              >套用上次價 ${getLastUnitPrice(order, item.gasType)}</button>
                            )}
                          </div>
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
                      onClick={() => addEditItem(order)}
                      className="w-full border border-dashed border-orange-300 text-orange-500 text-xs font-medium py-1.5 rounded-lg hover:bg-orange-50 transition"
                    >＋ 新增品項（不同規格）</button>
                  </div>
                  <div className="text-xs text-gray-500">合計：${editItemsTotal().toLocaleString()}</div>
                  {editItems.length > 0 && (
                    <div className="text-xs text-gray-600 space-y-1">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-orange-500"
                          checked={editRememberPrice}
                          onChange={e => setEditRememberPrice(e.target.checked)}
                        />
                        🔒 記住這個單價（存成 {order.customer_name} 的特殊單價，以後自動帶入）
                      </label>
                      {editRememberPrice && new Set(editItems.map(i => Number(i.unitPrice) || 0)).size > 1 && (
                        <div className="flex items-center gap-2 pl-6">
                          <span>品項單價不同，記住哪一個：</span>
                          <select
                            className="border border-gray-300 rounded-lg px-2 py-1 text-xs"
                            value={editRememberPriceIndex}
                            onChange={e => setEditRememberPriceIndex(Number(e.target.value))}
                          >
                            {editItems.map((it, idx) => (
                              <option key={idx} value={idx}>
                                {GAS_LABELS[it.gasType] || it.gasType} — ${it.unitPrice}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
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
