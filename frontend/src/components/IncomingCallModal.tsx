import { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '../lib/api'
import { showToast } from '../lib/toast'

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
  // 一支電話比對到不只一筆客戶時（同一人開多間店，電話都填一樣），
  // 直接列出這幾筆客戶讓人選，不用像真的陌生號碼那樣要打字搜尋
  const [matchedCustomers, setMatchedCustomers] = useState<{ id: number; name: string; address: string }[]>([])
  const [visible, setVisible] = useState(false)
  const [paymentType, setPaymentType] = useState<'CASH' | 'AR'>('CASH')
  const [baselinePrices, setBaselinePrices] = useState<Record<string, number>>(FALLBACK_PRICE)
  // 品項改成陣列，才能一次接單好幾種規格（例如 20kg 一桶 + 16kg 一桶），
  // 而且會直接帶入上一單的所有品項，正常情況只要確認、有誤再改就好，不用整個重選
  const [editItems, setEditItems] = useState<EditItem[]>([{ gasType: 'BOTTLED_20KG', quantity: 1, unitPrice: FALLBACK_PRICE.BOTTLED_20KG }])
  const [scheduledDate, setScheduledDate] = useState('')
  const [rememberPrice, setRememberPrice] = useState(false)
  const [rememberPriceIndex, setRememberPriceIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [newName, setNewName] = useState('')
  const [newAddress, setNewAddress] = useState('')
  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ id: number; name: string; address: string }[]>([])
  const [searching, setSearching] = useState(false)

  const shownDraftId = useRef<number | null>(null)
  const shownUnknownPhone = useRef<string | null>(null)
  const shownUnknownId = useRef<number | null>(null)
  // 按過「稍後」的項目，暫時跳過它、換下一筆顯示，而不是整個佇列卡住等這筆被處理完
  // key 用 "draft-<id>" / "unknown-<id>" 區分，因為合併佇列後草稿跟陌生來電共用同一個 Set
  const deferredIds = useRef<Set<string>>(new Set())
  const token = localStorage.getItem('token')
  // 再次來電 toast 通知的輪詢游標：null 代表還沒初始化，第一次拿到的是「目前最新 id」，
  // 用它當起點，不會把過去累積的舊事件在剛打開頁面時一次全部跳出來
  const repeatCallCursor = useRef<number | null>(null)

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

  // 抽成共用函式：輪詢計時器跟「確認/取消/稍後後立刻檢查下一筆」都呼叫這個
  const poll = useCallback(async () => {
    if (!token) return
    try {
      const res = await fetch('/api/caller/draft', {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()

      // 合併後的佇列：已知客戶草稿＋陌生來電依實際時間排序，不再是「草稿一律優先」
      const queue: Array<
        | { kind: 'draft'; draft: any }
        | { kind: 'unknown'; unknownCall: any }
      > = data.queue || []

      // 清掉已經不在佇列裡的稍後記錄（該筆已經被確認/取消掉了），避免這個 Set 無限長大
      const currentKeys = new Set(
        queue.map(item => item.kind === 'draft' ? `draft-${item.draft.id}` : `unknown-${item.unknownCall.id}`)
      )
      for (const key of deferredIds.current) {
        if (!currentKeys.has(key)) deferredIds.current.delete(key)
      }

      // 從合併佇列裡挑「還沒被按過稍後」、時間最早的一筆——不分草稿或陌生來電
      const nextItem = queue.find(item => {
        const key = item.kind === 'draft' ? `draft-${item.draft.id}` : `unknown-${item.unknownCall.id}`
        return !deferredIds.current.has(key)
      }) || null

      if (nextItem?.kind === 'draft') {
        const nextDraft = nextItem.draft
        if (nextDraft.id !== shownDraftId.current) {
          shownDraftId.current = nextDraft.id
          shownUnknownPhone.current = null
          shownUnknownId.current = null
          setDraft(nextDraft)
          setUnknownPhone(null)
          setPaymentType(nextDraft.paymentType === 'AR' ? 'AR' : 'CASH')
          setEditItems(
            nextDraft.items && nextDraft.items.length > 0
              ? nextDraft.items.map((i: DraftItem) => ({ gasType: i.gasType, quantity: i.quantity, unitPrice: i.unitPrice }))
              : [{ gasType: 'BOTTLED_20KG', quantity: 1, unitPrice: baselinePrices.BOTTLED_20KG }]
          )
          setScheduledDate('')
          setRememberPrice(false)
          setRememberPriceIndex(0)
          setVisible(true)
        }
      } else if (nextItem?.kind === 'unknown') {
        const nextUnknown = nextItem.unknownCall
        if (nextUnknown.phone !== shownUnknownPhone.current) {
          shownUnknownPhone.current = nextUnknown.phone
          shownUnknownId.current = nextUnknown.id
          shownDraftId.current = null
          setUnknownPhone(nextUnknown.phone)
          setMatchedCustomers(nextUnknown.matchedCustomers || [])
          setDraft(null)
          setNewName('')
          setNewAddress('')
          // 多數陌生來電其實是「還沒登記市話的舊客戶」，所以預設先進搜尋模式，
          // 真的要新增客戶要手動切換過去，避免手滑重複建檔
          setSearchMode(true)
          setSearchQuery('')
          setSearchResults([])
          setVisible(true)
        } else {
          // 電話號碼沒變，但同一筆陌生來電紀錄背後比對到的客戶清單可能有更新——
          // 例如第一次來電時查無客戶，後來另一間店把同一支電話補登進客戶資料，
          // 變成「一號多店」。這種情況畫面要跟著換成選店畫面，不能只靠使用者
          // 手動重新整理頁面才看得到最新結果。只更新這一個欄位，避免打斷使用者
          // 正在填的新客戶表單或搜尋內容。
          setMatchedCustomers(prev => {
            const next = nextUnknown.matchedCustomers || []
            const changed =
              next.length !== prev.length ||
              next.some((c: { id: number }, idx: number) => c.id !== prev[idx]?.id)
            return changed ? next : prev
          })
        }
      } else {
        // 目前沒有任何「還沒被稍後」的待處理草稿/陌生來電，重設記錄，避免漏接下一筆新進來的同 ID 情況
        shownDraftId.current = null
        shownUnknownPhone.current = null
        shownUnknownId.current = null
        setVisible(false)
        setDraft(null)
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

  // 再次來電通知：跟建單彈窗的輪詢分開跑，因為即使今天已經有一張「已確認」的
  // 待送單（不再是 DRAFT），再次來電還是要讓使用者知道——不能只靠上面那個
  // 只抓 DRAFT/陌生來電佇列的 poll
  useEffect(() => {
    if (!token) return
    let cancelled = false
    async function pollRepeatCalls() {
      try {
        const res = await api.getRepeatCallEvents(repeatCallCursor.current)
        if (cancelled) return
        for (const ev of res.events || []) {
          showToast(`🔁 再次來電：${ev.customerName}（${ev.phone}）`, 'info', 6000)
        }
        if (typeof res.cursor === 'number') repeatCallCursor.current = res.cursor
      } catch {
        // 靜默失敗，下一輪再試
      }
    }
    pollRepeatCalls()
    const timer = setInterval(pollRepeatCalls, POLL_INTERVAL)
    return () => { cancelled = true; clearInterval(timer) }
  }, [token])

  // 這支訂單維持在資料庫的 DRAFT 狀態，不打任何 API——只是先把這筆記起來跳過，
  // 立刻改顯示佇列裡下一筆還沒處理過的來電；這筆被稍後的還是留在「訂單」頁的
  // 「來電草稿（待確認）」清單裡，之後可以自己回去點開處理
  function handleDefer() {
    if (!draft) return
    deferredIds.current.add(`draft-${draft.id}`)
    setVisible(false)
    setDraft(null)
    shownDraftId.current = null
    poll()
  }

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
      // 「記住這個單價」：品項單價都一樣時直接存那個數字；不一樣時用下拉選單選的那個品項的單價
      if (rememberPrice) {
        const uniquePrices = new Set(editItems.map(i => i.unitPrice))
        const chosen = uniquePrices.size === 1
          ? editItems[0]
          : (editItems[rememberPriceIndex] || editItems[0])
        if (chosen) {
          try { await api.updateCustomer(draft.customer.id, { price_override: chosen.unitPrice }) } catch { /* 訂單已經建好了，這步失敗不影響本次派單 */ }
        }
      }
      setVisible(false)
      setDraft(null)
      shownDraftId.current = null
      setRememberPrice(false)
      setRememberPriceIndex(0)
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

  // 一號多店：選了其中一間店，直接用 incoming-by-id 建草稿單（不能用 /bind，
  // 因為這支電話本來就已經同時登記在好幾筆客戶身上，/bind 的重複號碼檢查會擋下來）
  async function handleQuickPick(customerId: number) {
    if (!unknownPhone) return
    setLoading(true)
    try {
      await fetch('/api/caller/incoming-by-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ customerId, phone: unknownPhone })
      })
      shownUnknownPhone.current = null
      window.dispatchEvent(new Event('order-refresh'))
    } finally {
      setVisible(false)
      setUnknownPhone(null)
      setMatchedCustomers([])
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

  // 陌生來電的「稍後」：純前端跳過，不打任何 API——不會建立客戶、不會建單，
  // 這通來電還是留在佇列裡（PENDING），下次輪到它或重新整理頁面時還會再跳出來，
  // 適合「不確定是不是要叫瓦斯、要問過老闆再說」的狀況，不會像「新增並建單」那樣
  // 先把電話存進客戶名單，事後才發現不是真客戶還要跑去客戶管理刪除
  function handleDeferUnknown() {
    if (shownUnknownId.current == null) return
    deferredIds.current.add(`unknown-${shownUnknownId.current}`)
    setVisible(false)
    setUnknownPhone(null)
    setMatchedCustomers([])
    shownUnknownPhone.current = null
    shownUnknownId.current = null
    poll()
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
    setMatchedCustomers([])
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
              <div className="font-bold text-lg">{matchedCustomers.length > 0 ? '這通電話是哪一間？' : '陌生來電'}</div>
              <div className="text-gray-300 text-sm">{unknownPhone}</div>
            </div>
          </div>

          {matchedCustomers.length > 0 ? (
            <>
              <div className="px-5 py-4 space-y-2">
                <div className="text-gray-500 text-sm">這支電話對到不只一間店，點選要建單的那一間</div>
                {matchedCustomers.map(c => (
                  <button
                    key={c.id}
                    onClick={() => handleQuickPick(c.id)}
                    disabled={loading}
                    className="w-full text-left bg-gray-50 hover:bg-orange-50 rounded-xl px-3 py-2.5 transition"
                  >
                    <div className="font-medium text-gray-800 text-sm">{c.name}</div>
                    <div className="text-gray-500 text-xs">{c.address}</div>
                  </button>
                ))}
              </div>
              <div className="px-5 pb-5">
                <button onClick={handleDismiss} className="w-full py-3 rounded-xl bg-gray-100 text-gray-600 font-medium">
                  略過
                </button>
              </div>
            </>
          ) : !searchMode ? (
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

              <div className="px-5 pb-5 flex gap-2">
                <button onClick={handleDismiss} className="flex-1 py-3 rounded-xl bg-gray-100 text-gray-600 font-medium">
                  略過
                </button>
                <button
                  onClick={handleDeferUnknown}
                  disabled={loading}
                  title="不確定是不是要叫瓦斯？先擱著，不會建立客戶資料"
                  className="px-3 py-3 rounded-xl bg-gray-100 text-gray-500 font-medium text-base whitespace-nowrap"
                >
                  📤 稍後
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

              <div className="px-5 pb-5 flex gap-2">
                <button onClick={handleDismiss} className="flex-1 py-3 rounded-xl bg-gray-100 text-gray-600 font-medium">
                  略過
                </button>
                <button
                  onClick={handleDeferUnknown}
                  disabled={loading}
                  title="不確定是不是要叫瓦斯？先擱著，不會建立客戶資料"
                  className="px-3 py-3 rounded-xl bg-gray-100 text-gray-500 font-medium text-base whitespace-nowrap"
                >
                  📤 稍後
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
            {editItems.length > 0 && (
              <div className="text-sm text-gray-600 mt-2 space-y-1.5">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-orange-500"
                    checked={rememberPrice}
                    onChange={e => setRememberPrice(e.target.checked)}
                  />
                  🔒 記住這個單價（存成 {draft.customer.name} 的特殊單價，以後自動帶入）
                </label>
                {rememberPrice && new Set(editItems.map(i => i.unitPrice)).size > 1 && (
                  <div className="flex items-center gap-2 pl-6">
                    <span>這幾個品項單價不同，記住哪一個：</span>
                    <select
                      className="border border-gray-300 rounded-lg px-2 py-1 text-sm"
                      value={rememberPriceIndex}
                      onChange={e => setRememberPriceIndex(Number(e.target.value))}
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

        <div className="px-5 pb-5 flex gap-2">
          <button onClick={handleCancel} disabled={loading} className="flex-1 py-3 rounded-xl bg-gray-100 text-gray-600 font-medium">
            取消派單
          </button>
          <button
            onClick={handleDefer}
            disabled={loading}
            title="先擱著，之後到「訂單」頁的「來電草稿」清單再手動處理"
            className="px-3 py-3 rounded-xl bg-gray-100 text-gray-500 font-medium text-base whitespace-nowrap"
          >
            📤 稍後
          </button>
          <button onClick={handleConfirm} disabled={loading} className="flex-[2] py-3 rounded-xl bg-orange-500 text-white font-bold text-lg">
            ✅ 確認派單
          </button>
        </div>
      </div>
    </div>
  )
}
