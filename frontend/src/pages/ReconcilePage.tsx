import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { showToast } from '../lib/toast'

// 每日對帳：拿紙本出貨單逐張核對。
// 有出貨單 → 打勾（verified_at）；數量／桶型不對 → 當場改；
// 對完剩下沒打勾的 → 一次作廢。
// 之後判斷「真的訂單」看有沒有對過帳就好，不再依賴 DELIVERED（那只代表被按掉）。

interface Item {
  id?: number
  gasType: string
  quantity: number
  unitPrice: number
}

interface ReconcileOrder {
  id: number
  status: string
  source: string | null
  paymentType: string
  totalAmount: number
  note: string | null
  verifiedAt: string | null
  createdAt: string
  hasPayment: boolean
  customer: { id: number; name: string; address: string; phone: string }
  items: (Item & { subtotal: number })[]
}

const GAS_LABELS: Record<string, string> = {
  BOTTLED_20KG: '20kg', BOTTLED_16KG: '16kg', BOTTLED_10KG: '10kg', BOTTLED_4KG: '4kg',
}
const GAS_TYPES = ['BOTTLED_20KG', 'BOTTLED_16KG', 'BOTTLED_10KG', 'BOTTLED_4KG']
const FALLBACK_PRICE: Record<string, number> = {
  BOTTLED_20KG: 800, BOTTLED_16KG: 650, BOTTLED_10KG: 450, BOTTLED_4KG: 200,
}
const SOURCE_LABEL: Record<string, string> = {
  CALLER: '來電', LINE: 'LINE', MANUAL: '手動', SCHEDULED: '固定',
}

function todayTaipei() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })
}

function shiftDate(date: string, days: number) {
  const d = new Date(`${date}T12:00:00+08:00`)
  d.setDate(d.getDate() + days)
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })
}

function isPlaceholder(name: string) {
  return !name || name.startsWith('來電')
}

function isMissingAddress(address: string) {
  return !address || address === '（待補）'
}

export default function ReconcilePage({ refresh, onEditCustomer }: { refresh?: number; onEditCustomer?: (customerId: number) => void }) {
  const [date, setDate] = useState(todayTaipei())
  const [orders, setOrders] = useState<ReconcileOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [onlyUnverified, setOnlyUnverified] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editItems, setEditItems] = useState<Item[]>([])
  const [baselinePrices, setBaselinePrices] = useState<Record<string, number>>(FALLBACK_PRICE)

  useEffect(() => {
    api.getBaselinePrices()
      .then(res => {
        const valid: Record<string, number> = {}
        for (const [k, v] of Object.entries(res.prices || {})) {
          if (Number(v) > 0) valid[k] = Number(v)
        }
        setBaselinePrices(prev => ({ ...prev, ...valid }))
      })
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.getReconcileDay(date)
      setOrders(res.orders || [])
    } catch (e: any) {
      showToast(e.message || '讀取失敗', 'error')
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => { load() }, [load, refresh])
  useEffect(() => { setEditingId(null) }, [date])

  const verifiedCount = orders.filter(o => o.verifiedAt).length
  const unverified = orders.filter(o => !o.verifiedAt)

  const shown = useMemo(() => {
    const q = search.trim()
    return orders.filter(o => {
      if (onlyUnverified && o.verifiedAt) return false
      if (!q) return true
      const c = o.customer
      return [c.name, c.address, c.phone].some(v => (v || '').includes(q))
    })
  }, [orders, search, onlyUnverified])

  async function toggleVerified(o: ReconcileOrder) {
    const next = !o.verifiedAt
    // 樂觀更新：對帳時會連續點很多張，不等 API 回來
    setOrders(prev => prev.map(x => x.id === o.id ? { ...x, verifiedAt: next ? new Date().toISOString() : null } : x))
    try {
      await api.setOrdersVerified([o.id], next)
    } catch {
      setOrders(prev => prev.map(x => x.id === o.id ? { ...x, verifiedAt: o.verifiedAt } : x))
      showToast('更新失敗，請再點一次', 'error')
    }
  }

  function startEdit(o: ReconcileOrder) {
    if (editingId === o.id) { setEditingId(null); return }
    setEditingId(o.id)
    setEditItems(o.items.length > 0
      ? o.items.map(i => ({ id: i.id, gasType: i.gasType, quantity: i.quantity, unitPrice: i.unitPrice }))
      : [{ gasType: 'BOTTLED_20KG', quantity: 1, unitPrice: baselinePrices.BOTTLED_20KG }])
  }

  function updateItem(idx: number, patch: Partial<Item>) {
    setEditItems(prev => prev.map((it, i) => {
      if (i !== idx) return it
      const next = { ...it, ...patch }
      if (patch.gasType) next.unitPrice = baselinePrices[patch.gasType] || FALLBACK_PRICE[patch.gasType] || it.unitPrice
      return next
    }))
  }

  // 改完品項 = 已經拿出貨單對過了，所以儲存時順便打勾
  async function saveAndVerify(o: ReconcileOrder) {
    setBusy(true)
    try {
      await api.updateOrder(o.id, { items: editItems })
      if (!o.verifiedAt) await api.setOrdersVerified([o.id], true)
      setEditingId(null)
      await load()
    } catch (e: any) {
      showToast(e.message || '儲存失敗', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function voidOrders(ids: number[], confirmText: string) {
    if (ids.length === 0) return
    if (!window.confirm(confirmText)) return
    setBusy(true)
    try {
      const res = await api.voidUnverifiedOrders(ids)
      const skipped = res.skipped?.length || 0
      showToast(
        skipped > 0
          ? `已作廢 ${res.voided.length} 張，${skipped} 張有收款紀錄沒有作廢`
          : `已作廢 ${res.voided.length} 張`,
        skipped > 0 ? 'info' : 'success'
      )
      setEditingId(null)
      await load()
      window.dispatchEvent(new Event('order-refresh'))
    } catch (e: any) {
      showToast(e.message || '作廢失敗', 'error')
    } finally {
      setBusy(false)
    }
  }

  const editTotal = editItems.reduce((s, i) => s + i.quantity * i.unitPrice, 0)

  return (
    <div className="max-w-3xl mx-auto px-3 pb-24">
      {/* 日期 */}
      <div className="flex items-center gap-2 py-2">
        <button onClick={() => setDate(d => shiftDate(d, -1))} className="w-10 h-10 rounded-xl bg-white border border-gray-200 text-gray-600 text-lg">‹</button>
        <input
          type="date"
          value={date}
          onChange={e => e.target.value && setDate(e.target.value)}
          className="flex-1 h-10 rounded-xl bg-white border border-gray-200 px-3 text-center font-medium"
        />
        <button onClick={() => setDate(d => shiftDate(d, 1))} className="w-10 h-10 rounded-xl bg-white border border-gray-200 text-gray-600 text-lg">›</button>
        {date !== todayTaipei() && (
          <button onClick={() => setDate(todayTaipei())} className="h-10 px-3 rounded-xl bg-white border border-gray-200 text-sm text-gray-600">今天</button>
        )}
      </div>

      {/* 進度 */}
      <div className="bg-white rounded-2xl border border-gray-100 px-4 py-3 mb-2">
        <div className="flex items-baseline justify-between">
          <div className="text-sm text-gray-500">共 {orders.length} 張</div>
          <div className="text-sm">
            <span className="text-blue-600 font-bold">已對 {verifiedCount}</span>
            <span className="text-gray-300 mx-2">·</span>
            <span className={unverified.length > 0 ? 'text-orange-600 font-bold' : 'text-gray-400'}>未對 {unverified.length}</span>
          </div>
        </div>
        <div className="h-2 bg-gray-100 rounded-full mt-2 overflow-hidden">
          <div className="h-full bg-blue-500 transition-all" style={{ width: orders.length ? `${(verifiedCount / orders.length) * 100}%` : '0%' }} />
        </div>
      </div>

      {/* 搜尋／篩選 */}
      <div className="flex gap-2 mb-2">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="找名稱、地址或電話"
          className="flex-1 h-10 rounded-xl bg-white border border-gray-200 px-3 text-sm"
        />
        <button
          onClick={() => setOnlyUnverified(v => !v)}
          className={`h-10 px-3 rounded-xl text-sm border ${onlyUnverified ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-gray-200 text-gray-600'}`}
        >
          只看未對
        </button>
      </div>

      {loading && orders.length === 0 && <div className="text-center text-gray-400 py-10">載入中…</div>}
      {!loading && orders.length === 0 && <div className="text-center text-gray-400 py-10">這天沒有訂單</div>}

      <div className="bg-white rounded-2xl border border-gray-100 divide-y divide-gray-100 overflow-hidden">
        {shown.map(o => {
          const c = o.customer
          const placeholder = isPlaceholder(c.name)
          const verified = !!o.verifiedAt
          const editing = editingId === o.id
          return (
            <div key={o.id} className={verified ? 'bg-blue-50/40' : ''}>
              <div className="flex items-center gap-3 px-3 py-3">
                <button
                  onClick={() => toggleVerified(o)}
                  aria-label={verified ? '取消打勾' : '有出貨單，打勾'}
                  className={`w-12 h-12 shrink-0 rounded-xl border-2 flex items-center justify-center text-2xl ${verified ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-300 text-transparent'}`}
                >
                  ✓
                </button>

                <div className="flex-1 min-w-0" onClick={() => toggleVerified(o)}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-gray-800">{placeholder ? c.phone : c.name}</span>
                    {placeholder && <span className="text-xs bg-orange-100 text-orange-700 rounded px-1.5 py-0.5">陌生</span>}
                    {o.source && <span className="text-xs text-gray-400">{SOURCE_LABEL[o.source] || o.source}</span>}
                    {o.paymentType === 'AR' && <span className="text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">欠帳</span>}
                  </div>
                  <div className={`text-sm truncate ${isMissingAddress(c.address) ? 'text-orange-600' : 'text-gray-600'}`}>
                    {isMissingAddress(c.address) ? '缺地址' : c.address}
                    {!placeholder && c.phone && <span className="text-gray-400 ml-2">{c.phone}</span>}
                  </div>
                  <div className="text-sm text-gray-500">
                    {o.items.map(i => `${GAS_LABELS[i.gasType] || i.gasType}×${i.quantity}`).join('、')}
                    <span className="ml-2 text-gray-700 font-medium">${o.totalAmount.toLocaleString()}</span>
                  </div>
                </div>

                <button
                  onClick={() => startEdit(o)}
                  className={`shrink-0 px-3 py-2 rounded-xl text-sm border ${editing ? 'bg-gray-700 text-white border-gray-700' : 'bg-white text-gray-600 border-gray-200'}`}
                >
                  {editing ? '收起' : '修改'}
                </button>
              </div>

              {editing && (
                <div className="px-3 pb-3 pl-[4.5rem] space-y-2">
                  {editItems.map((it, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <div className="flex gap-1">
                        {GAS_TYPES.map(g => (
                          <button
                            key={g}
                            onClick={() => updateItem(idx, { gasType: g })}
                            className={`px-2 py-1.5 rounded-lg text-xs border ${it.gasType === g ? 'bg-blue-50 border-blue-400 text-blue-700 font-bold' : 'bg-white border-gray-200 text-gray-500'}`}
                          >
                            {GAS_LABELS[g]}
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center gap-1 ml-auto">
                        <button onClick={() => updateItem(idx, { quantity: Math.max(1, it.quantity - 1) })} className="w-8 h-8 rounded-full bg-gray-100 font-bold">−</button>
                        <span className="w-6 text-center font-bold">{it.quantity}</span>
                        <button onClick={() => updateItem(idx, { quantity: it.quantity + 1 })} className="w-8 h-8 rounded-full bg-gray-100 font-bold">+</button>
                      </div>
                      <input
                        type="number"
                        inputMode="numeric"
                        value={it.unitPrice}
                        onChange={e => updateItem(idx, { unitPrice: Number(e.target.value) || 0 })}
                        className="w-20 h-8 rounded-lg border border-gray-200 px-2 text-sm text-right"
                      />
                      {editItems.length > 1 && (
                        <button onClick={() => setEditItems(prev => prev.filter((_, i) => i !== idx))} className="text-gray-400 px-1">×</button>
                      )}
                    </div>
                  ))}
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => setEditItems(prev => [...prev, { gasType: 'BOTTLED_20KG', quantity: 1, unitPrice: baselinePrices.BOTTLED_20KG }])}
                      className="text-sm text-gray-500 px-2 py-1.5 border border-dashed border-gray-300 rounded-lg"
                    >
                      ＋ 品項
                    </button>
                    {onEditCustomer && (
                      <button onClick={() => onEditCustomer(c.id)} className="text-sm text-gray-600 px-3 py-1.5 border border-gray-200 rounded-lg">
                        補客戶資料
                      </button>
                    )}
                    {!verified && !o.hasPayment && (
                      <button
                        onClick={() => voidOrders([o.id], '這張沒有出貨單，確定作廢？')}
                        disabled={busy}
                        className="text-sm text-red-600 px-3 py-1.5 border border-red-200 rounded-lg"
                      >
                        作廢
                      </button>
                    )}
                    <button
                      onClick={() => saveAndVerify(o)}
                      disabled={busy}
                      className="ml-auto px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-bold"
                    >
                      儲存並打勾 ${editTotal.toLocaleString()}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* 對完之後：沒打勾的一次作廢 */}
      {/* 至少對過一張才出現，避免還沒開始對帳就誤按整批作廢 */}
      {verifiedCount > 0 && unverified.length > 0 && (
        <div className="fixed bottom-16 left-0 right-0 z-10 px-3 pb-2">
          <div className="max-w-3xl mx-auto bg-white border border-gray-200 rounded-2xl shadow-lg px-4 py-3 flex items-center gap-3">
            <div className="flex-1 text-sm text-gray-600">
              對完了？剩下 <span className="font-bold text-orange-600">{unverified.length}</span> 張沒有出貨單
            </div>
            <button
              onClick={() => {
                const pending = unverified.filter(o => o.status !== 'DELIVERED').length
                voidOrders(
                  unverified.map(o => o.id),
                  `確定把 ${unverified.length} 張沒打勾的訂單全部作廢？` +
                  (pending > 0 ? `\n\n⚠️ 其中 ${pending} 張還沒按完成，如果只是還沒送，請先到訂單頁改期。` : '') +
                  `\n（有收款紀錄的會自動跳過）`
                )
              }}
              disabled={busy}
              className="px-4 py-2 rounded-xl bg-gray-700 text-white text-sm font-bold"
            >
              全部作廢
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
