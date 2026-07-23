import { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '../lib/api'

const POLL_INTERVAL = 4000

interface DraftItem {
  gasType: string
  quantity: number
  unitPrice: number
  subtotal: number
}

interface EditItem {
  gasType: string
  quantity: number
  unitPrice: number
}

interface Draft {
  id: number
  customer: {
    id: number
    name: string
    phone: string
    address: string
    note?: string
    amountOwed: number
  }
  items: DraftItem[]
  totalAmount: number
  paymentType: string
  createdAt: string
}

const GAS_LABELS: Record<string, string> = {
  BOTTLED_20KG: '20kg', BOTTLED_16KG: '16kg', BOTTLED_10KG: '10kg', BOTTLED_4KG: '4kg',
}
const FALLBACK_PRICE: Record<string, number> = {
  BOTTLED_20KG: 800, BOTTLED_16KG: 650, BOTTLED_10KG: 450, BOTTLED_4KG: 200,
}

export default function IncomingCallModal() {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [unknownPhone, setUnknownPhone] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [paymentType, setPaymentType] = useState<'CASH' | 'AR'>('CASH')
  const [baselinePrices, setBaselinePrices] = useState<Record<string, number>>(FALLBACK_PRICE)
  // 品項改成陣列，才能一次接單好幾種規格（例如 20kg 一桶 + 16kg 一桶），
  // 而且會直接帶入上一單的所有品項，正常情況只要確認、有誤再改就好，不用整個重選
  const [editItems, setEditItems] = useState<EditItem[]>([{ gasType: 'BOTTLED_20KG', quantity: 1, unitPrice: FALLBACK_PRICE.BOTTLED_20KG }])
  const [scheduledDate, setScheduledDate] = useState('')
  const [loading, setLoading] = useState(false)
  const [newName, setNewName] = useState('')
  const [newAddress, setNewAddress] = useState('')
  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ id: number; name: string; address: string }[]>([])
  const [searching, setSearching] = useState(false)

  const shownDraftId = useRef<number | null>(null)
  const shownUnknownPhone = useRef<string | null>(null)
  const token = localStorage.getItem('token')

  useEffect(() => {
    api.getBaselinePrices()
      .then(res => {
        const raw: Record<string, number> = res.prices || {}
        const valid: Record<string, number> = {}
        for (const key of Object.keys(raw)) {
          const v = Number(raw[key])
          if (v > 0) valid[key] = v
        }
        setBaselinePrices(prev => ({ ...prev, ...valid }))
      })
      .catch(() => {})
  }, [])

  // 抽成共用函式：輪詢計時器跟「確認/取消後立刻檢查下一筆」都呼叫這個
  const poll = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch('/api/caller/draft', {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()

      if (data.draft) {
        if (data.draft.id !== shownDraftId.current) {
          shownDraftId.current = data.draft.id
          shownUnknownPhone.current = null
          setDraft(data.draft)
          setUnknownPhone(null)
          setPaymentType(data.draft.paymentType === 'AR' ? 'AR' : 'CASH')
          setEditItems(
            data.draft.items && data.draft.items.length > 0
              ? data.draft.items.map((i: DraftItem) => ({ gasType: i.gasType, quantity: i.quantity, unitPrice: i.unitPrice }))
              : [{ gasType: 'BOTTLED_20KG', quantity: 1, unitPrice: baselinePrices.BOTTLED_20KG }]
          )
          setScheduledDate('')
          setVisible(true)
        }
      } else if (data.unknownPhone) {
        if (data.unknownPhone !== shownUnknownPhone.current) {
          shownUnknownPhone.current = data.unknownPhone
          shownDraftId.current = null
          setUnknownPhone(data.unknownPhone)
          setDraft(null)
          setNewName('')
          setNewAddress('')
          // 多數陌生來電其實是「還沒登記市話的舊客戶」，所以預設先進搜尋模式，
          // 真的要新增客戶要手動切換過去，避免手滑重複建檔
          setSearchMode(true)
          setSearchQuery('')
          setSearchResults([])
          setVisible(true)
        }
      } else {
        // 目前沒有任何待處理草稿/陌生來電，重設記錄，避免漏接下一筆新進來的同 ID 情況
        shownDraftId.current = null
        shownUnknownPhone.current = null
      }
    } catch {
      // 靜默失敗
    }
  }, [token, baselinePrices])

  useEffect(() => {
    if (!token) return
    setTimeout(poll, 1000) // 延遲1秒等token準備好
    const timer = setInterval(poll, POLL_INTERVAL)
    return () => clearInterval(timer)
  }, [token, poll])

  async function handleConfirm() {
    if (!draft) return
    setLoading(true)
    try {
      await fetch(`/api/caller/draft/${draft.id}/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ paymentType, items: editItems, scheduledDate })
      })
      setVisible(false)
      setDraft(null)
      shownDraftId.current = null
      window.dispatchEvent(new Event('order-refresh'))
      // 立刻檢查有沒有下一筆排隊中的草稿，不用等下一次輪詢
      poll()
    } finally {
      setLoading(false)
    }
  }

  async function handleCancel() {
    if (!draft) return
    setLoading(true)
    try {
      await fetch(`/api/caller/draft/${draft.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })
    } finally {
      setVisible(false)
      setDraft(null)
      shownDraftId.current = null
      setLoading(false)
      // 立刻檢查有沒有下一筆排隊中的草稿
      poll()
    }
  }

  function updateEditItem(idx: number, field: keyof EditItem, value: string | number) {
    setEditItems(prev => prev.map((it, i) => {
      if (i !== idx) return it
      const updated = { ...it, [field]: value }
      if (field === 'gasType') {
        updated.unitPrice = baselinePrices[value as string] || FALLBACK_PRICE[value as string] || it.unitPrice
      }
      return updated
    }))
  }

  function addEditItem() {
    setEditItems(prev => [...prev, { gasType: 'BOTTLED_20KG', quantity: 1, unitPrice: baselinePrices.BOTTLED_20KG }])
  }

  function removeEditItem(idx: number) {
    setEditItems(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev)
  }

  // 搜尋既有客戶（debounce 400ms）
  useEffect(() => {
    if (!searchMode || !searchQuery.trim()) {
      setSearchResults([])
      return
    }
    const timer = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`/api/customers?search=${encodeURIComponent(searchQuery)}&limit=8`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        const data = await res.json()
        setSearchResults((data.customers || []).map((c: any) => ({ id: c.id, name: c.name, address: c.address })))
      } catch {
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [searchQuery, searchMode, token])

  async function handleBind(customerId: number) {
    if (!unknownPhone) return
    setLoading(true)
    try {
      await fetch('/api/caller/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ customerId, phone: unknownPhone })
      })
      shownUnknownPhone.current = null
      window.dispatchEvent(new Event('order-refresh'))
    } finally {
      setVisible(false)
      setUnknownPhone(null)
      setSearchMode(false)
      setLoading(false)
      poll()
    }
  }

  async function handleCreateAndOrder() {
    if (!unknownPhone) return
    setLoading(true)
    try {
      const res = await fetch('/api/caller/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          phone: unknownPhone,
          name: newName || `來電 ${unknownPhone}`,
          address: newAddress || '（待補）',
          apiKey: 'gas2026secret'
        })
      })
      const data = await res.json()
      if (data.customer?.id) {
        await fetch('/api/caller/incoming-by-id', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ customerId: data.customer.id, phone: unknownPhone })
        })
      }
      shownUnknownPhone.current = null
      window.dispatchEvent(new Event('order-refresh'))
    } finally {
      setVisible(false)
      setUnknownPhone(null)
      setLoading(false)
      // 立刻檢查有沒有下一筆排隊中的草稿/來電
      poll()
    }
  }

  async function handleDismiss() {
    if (unknownPhone) {
      // 找到對應的 unknown_calls id 並標記已處理，避免下次輪詢又跳出來
      try {
        const res = await fetch('/api/caller/draft', {
          headers: { Authorization: `Bearer ${token}` }
        })
        const data = await res.json()
        const match = data.unknownCalls?.find((u: any) => u.phone === unknownPhone)
        if (match) {
          await fetch(`/api/caller/unknown/${match.id}/dismiss`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
          })
        }
      } catch {
        // 靜默失敗，畫面還是會關閉，之後輪詢頂多再跳一次
      }
    }
    setVisible(false)
    setDraft(null)
    setUnknownPhone(null)
    setSearchMode(false)
    shownUnknownPhone.current = null
  }

  if (!visible) return null

  if (unknownPhone) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
          <div className="bg-gray-700 text-white px-5 py-4 flex items-center gap-3">
            <span className="text-3xl">📞</span>
            <div>
              <div className="font-bold text-lg">陌生來電</div>
              <div className="text-gray-300 text-sm">{unknownPhone}</div>
            </div>
          </div>

          {!searchMode ? (
            <>
              <div className="px-5 py-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-gray-500 text-sm">尚未建檔，要新增客戶並建單嗎？</div>
                  <button
                    onClick={() => setSearchMode(true)}
                    className="text-orange-500 text-xs font-medium whitespace-nowrap ml-2"
                  >
                    🔍 是舊客戶？搜尋
                  </button>
                </div>
                <div>
                  <label className="text-xs text-gray-500">姓名</label>
                  <input
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    placeholder={`來電 ${unknownPhone}`}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2.5 mt-1 text-sm focus:outline-none focus:border-orange-400"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500">地址</label>
                  <input
                    value={newAddress}
                    onChange={e => setNewAddress(e.target.value)}
                    placeholder="（待補）"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2.5 mt-1 text-sm focus:outline-none focus:border-orange-400"
                  />
                </div>
              </div>

              <div className="px-5 pb-5 flex gap-3">
                <button onClick={handleDismiss} className="flex-1 py-3 rounded-xl bg-gray-100 text-gray-600 font-medium">
                  略過
                </button>
                <button onClick={handleCreateAndOrder} disabled={loading} className="flex-[2] py-3 rounded-xl bg-orange-500 text-white font-bold">
                  ➕ 新增並建單
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="px-5 py-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-gray-500 text-sm">先搜尋看看是不是舊客戶</div>
                  <button
                    onClick={() => setSearchMode(false)}
                    className="text-orange-500 text-xs font-medium whitespace-nowrap ml-2"
                  >
                    ➕ 真的是新客戶？
                  </button>
                </div>
                <input
                  autoFocus
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="輸入姓名或地址關鍵字"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-orange-400"
                />
                <div className="max-h-56 overflow-y-auto space-y-2">
                  {searching && (
                    <div className="text-center text-gray-400 text-sm py-3">搜尋中…</div>
                  )}
                  {!searching && searchQuery.trim() && searchResults.length === 0 && (
                    <div className="text-center text-gray-400 text-sm py-3 space-y-2">
                      <div>找不到符合的客戶</div>
                      <button
                        onClick={() => setSearchMode(false)}
                        className="text-orange-500 text-xs font-medium underline"
                      >
                        建立新客戶
                      </button>
                    </div>
                  )}
                  {searchResults.map(c => (
                    <button
                      key={c.id}
                      onClick={() => handleBind(c.id)}
                      disabled={loading}
                      className="w-full text-left bg-gray-50 hover:bg-orange-50 rounded-xl px-3 py-2.5 transition"
                    >
                      <div className="font-medium text-gray-800 text-sm">{c.name}</div>
                      <div className="text-gray-500 text-xs">{c.address}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="px-5 pb-5">
                <button onClick={handleDismiss} className="w-full py-3 rounded-xl bg-gray-100 text-gray-600 font-medium">
                  略過
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  if (!draft) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
        <div className="bg-orange-500 text-white px-5 py-4 flex items-center gap-3">
          <span className="text-3xl animate-bounce">📞</span>
          <div>
            <div className="font-bold text-lg">來電自動草稿</div>
            <div className="text-orange-100 text-sm">{draft.customer.phone}</div>
          </div>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="bg-gray-50 rounded-xl p-3 space-y-1">
            <div className="font-bold text-gray-800 text-lg">{draft.customer.name}</div>
            <div className="text-gray-500 text-sm">{draft.customer.address}</div>
            {draft.customer.note && (
              <div className="text-orange-600 text-sm">📝 {draft.customer.note}</div>
            )}
            {draft.customer.amountOwed > 0 && (
              <div className="text-red-500 text-sm font-medium">⚠️ 欠款 ${draft.customer.amountOwed}</div>
            )}
          </div>

          <div>
            <div className="text-gray-500 text-xs mb-2">品項（可修改，已帶入上次品項，只要確認或微調就好）</div>
            <div className="space-y-2">
              {editItems.map((item, idx) => (
                <div key={idx} className="bg-gray-50 rounded-xl p-2.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex gap-1.5 flex-wrap">
                      {['BOTTLED_20KG', 'BOTTLED_16KG', 'BOTTLED_10KG', 'BOTTLED_4KG'].map(type => (
                        <button
                          key={type}
                          onClick={() => updateEditItem(idx, 'gasType', type)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-medium transition ${item.gasType === type ? 'bg-orange-500 text-white' : 'bg-white border border-gray-200 text-gray-500'}`}
                        >
                          {GAS_LABELS[type]}
                        </button>
                      ))}
                    </div>
                    {editItems.length > 1 && (
                      <button onClick={() => removeEditItem(idx)} className="text-red-400 text-lg font-bold ml-2">×</button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5 flex-1">
                      <button onClick={() => updateEditItem(idx, 'quantity', Math.max(1, item.quantity - 1))} className="w-7 h-7 rounded-full bg-gray-200 font-bold">-</button>
                      <span className="w-5 text-center font-medium text-sm">{item.quantity}</span>
                      <button onClick={() => updateEditItem(idx, 'quantity', item.quantity + 1)} className="w-7 h-7 rounded-full bg-orange-400 text-white font-bold">+</button>
                      <span className="text-gray-500 text-xs ml-0.5">桶</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-gray-500 text-sm">$</span>
                      <input
                        type="number"
                        value={item.unitPrice}
                        onChange={e => updateEditItem(idx, 'unitPrice', Number(e.target.value))}
                        className="w-20 border border-gray-200 rounded-lg px-2 py-1 text-sm text-right"
                      />
                    </div>
                    <div className="text-sm font-bold text-orange-600 w-16 text-right">${(item.quantity * item.unitPrice).toLocaleString()}</div>
                  </div>
                </div>
              ))}
            </div>
            <button onClick={addEditItem} className="mt-2 w-full border-2 border-dashed border-gray-300 text-gray-500 rounded-xl py-2 text-sm font-medium">
              + 新增品項
            </button>
            <div className="flex justify-between items-center pt-3 font-bold text-orange-500 text-lg">
              <span>合計</span>
              <span>${editItems.reduce((s, it) => s + it.quantity * it.unitPrice, 0).toLocaleString()}</span>
            </div>
          </div>

          <div>
            <div className="text-gray-500 text-xs mb-2">配送日期</div>
            <div className="flex gap-2">
              <button
                onClick={() => setScheduledDate('')}
                className={`flex-1 py-2 rounded-xl text-sm font-medium transition ${!scheduledDate ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-600'}`}
              >
                📅 今天
              </button>
              <input
                type="date"
                value={scheduledDate}
                min={new Date().toISOString().slice(0, 10)}
                onChange={e => setScheduledDate(e.target.value)}
                className={`flex-1 border rounded-xl px-3 py-2 text-sm ${scheduledDate ? 'border-orange-400 text-orange-600 font-medium' : 'border-gray-200 text-gray-500'}`}
              />
            </div>
            {scheduledDate && (
              <div className="text-orange-500 text-xs mt-1.5">⚠️ 此單將排定於 {scheduledDate}，在那天之前不會出現在待派送佇列</div>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setPaymentType('CASH')}
              className={`flex-1 py-2.5 rounded-xl font-medium transition ${paymentType === 'CASH' ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-600'}`}
            >
              💵 現金
            </button>
            <button
              onClick={() => setPaymentType('AR')}
              className={`flex-1 py-2.5 rounded-xl font-medium transition ${paymentType === 'AR' ? 'bg-yellow-500 text-white' : 'bg-gray-100 text-gray-600'}`}
            >
              📒 欠帳
            </button>
          </div>
        </div>

        <div className="px-5 pb-5 flex gap-3">
          <button onClick={handleCancel} disabled={loading} className="flex-1 py-3 rounded-xl bg-gray-100 text-gray-600 font-medium">
            取消派單
          </button>
          <button onClick={handleConfirm} disabled={loading} className="flex-[2] py-3 rounded-xl bg-orange-500 text-white font-bold text-lg">
            ✅ 確認派單
          </button>
        </div>
      </div>
    </div>
  )
}
