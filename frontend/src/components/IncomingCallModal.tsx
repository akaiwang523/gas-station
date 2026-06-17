import { useEffect, useState, useRef } from 'react'

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
  const [loading, setLoading] = useState(false)
  const [newName, setNewName] = useState('')
  const [newAddress, setNewAddress] = useState('')

  const shownDraftId = useRef<number | null>(null)
  const shownUnknownPhone = useRef<string | null>(null)
  const token = localStorage.getItem('token')

  useEffect(() => {
    if (!token) return

    const poll = async () => {
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
        }
      } catch {
        // 靜默失敗
      }
    }

    poll() // 立即執行一次
    const timer = setInterval(poll, POLL_INTERVAL)
    return () => clearInterval(timer)
  }, [token])

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
        body: JSON.stringify({ paymentType })
      })
      setVisible(false)
      setDraft(null)
      window.dispatchEvent(new Event('order-refresh'))
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
      setLoading(false)
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
      await res.json()
      shownUnknownPhone.current = null
      window.dispatchEvent(new Event('order-refresh'))
    } finally {
      setVisible(false)
      setUnknownPhone(null)
      setLoading(false)
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
            <div className="text-gray-500 text-xs mb-2">預填品項（上次訂單）</div>
            {draft.items.map((item, i) => (
              <div key={i} className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="font-medium">{item.gasType} × {item.quantity}</span>
                <span className="text-gray-600">${item.unitPrice} / 桶</span>
              </div>
            ))}
            <div className="flex justify-between items-center pt-2 font-bold text-orange-500 text-lg">
              <span>合計</span>
              <span>${draft.totalAmount}</span>
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
