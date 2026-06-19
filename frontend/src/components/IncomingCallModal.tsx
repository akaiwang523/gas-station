import { useEffect, useState, useRef, useCallback } from 'react'

const POLL_INTERVAL = 4000

interface DraftItem {
  gasType: string
  quantity: number
  unitPrice: number
  subtotal: number
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

export default function IncomingCallModal() {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [unknownPhone, setUnknownPhone] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [paymentType, setPaymentType] = useState<'CASH' | 'AR'>('CASH')
  const [editQty, setEditQty] = useState(1)
  const [editPrice, setEditPrice] = useState(800)
  const [editGasType, setEditGasType] = useState('20kg')
  const [loading, setLoading] = useState(false)
  const [newName, setNewName] = useState('')
  const [newAddress, setNewAddress] = useState('')

  const shownDraftId = useRef<number | null>(null)
  const shownUnknownPhone = useRef<string | null>(null)
  const token = localStorage.getItem('token')

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
          setEditQty(data.draft.items?.[0]?.quantity || 1)
          setEditPrice(data.draft.items?.[0]?.unitPrice || 800)
          setEditGasType(data.draft.items?.[0]?.gasType || '20kg')
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
  }, [token])

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
        body: JSON.stringify({ paymentType, quantity: editQty, unitPrice: editPrice, gasType: editGasType })
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
          body: JSON.stringify({ customerId: data.customer.id })
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

  function handleDismiss() {
    setVisible(false)
    setDraft(null)
    setUnknownPhone(null)
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

          <div className="px-5 py-4 space-y-3">
            <div className="text-gray-500 text-sm">尚未建檔，要新增客戶並建單嗎？</div>
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
            <div className="text-gray-500 text-xs mb-2">品項（可修改）</div>
            {/* 品項選擇 */}
            <div className="flex gap-2 mb-3">
              {['20kg','16kg','10kg','4kg'].map(type => (
                <button
                  key={type}
                  onClick={() => setEditGasType(type)}
                  className={`flex-1 py-1.5 rounded-lg text-sm font-medium transition ${editGasType === type ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-600'}`}
                >
                  {type}
                </button>
              ))}
            </div>
            {/* 數量和價格 */}
            <div className="flex items-center gap-2 py-2 border-b border-gray-100">
              <div className="flex items-center gap-2 flex-1">
                <button onClick={() => setEditQty(q => Math.max(1, q-1))} className="w-8 h-8 rounded-full bg-gray-200 font-bold text-lg">-</button>
                <span className="w-6 text-center font-medium">{editQty}</span>
                <button onClick={() => setEditQty(q => q+1)} className="w-8 h-8 rounded-full bg-orange-400 text-white font-bold text-lg">+</button>
                <span className="text-gray-500 text-sm ml-1">桶</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-gray-500 text-sm">$</span>
                <input
                  type="number"
                  value={editPrice}
                  onChange={e => setEditPrice(Number(e.target.value))}
                  className="w-20 border border-gray-200 rounded-lg px-2 py-1 text-sm text-right"
                />
              </div>
            </div>
            <div className="flex justify-between items-center pt-2 font-bold text-orange-500 text-lg">
              <span>合計</span>
              <span>${editQty * editPrice}</span>
            </div>
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
