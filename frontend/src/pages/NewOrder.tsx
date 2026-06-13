import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api'

type Customer = {
  id: number
  name: string
  phone: string
  address: string
  district: string
  price_override: number | null
  amount_owed: number
  gas_type: string
}

const GAS_PRICES: Record<string, number> = {
  BOTTLED_20KG: 800,
  BOTTLED_16KG: 650,
  BOTTLED_4KG: 200,
}

export default function NewOrder({ onOrderCreated }: { onOrderCreated?: () => void }) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<Customer[]>([])
  const [selected, setSelected] = useState<Customer | null>(null)
  const [quantity, setQuantity] = useState(1)
  const [unitPrice, setUnitPrice] = useState(800)
  const [paymentType, setPaymentType] = useState<'CASH' | 'AR'>('CASH')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (search.length < 1) { setResults([]); return }
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await api.searchCustomers(search)
        setResults(res.customers)
      } catch { setResults([]) }
    }, 300)
  }, [search])

  function selectCustomer(c: Customer) {
    setSelected(c)
    setSearch(c.name)
    setResults([])
    setUnitPrice(c.price_override || GAS_PRICES[c.gas_type] || 800)
    if (Number(c.amount_owed) > 0) setPaymentType('AR')
    else setPaymentType('CASH')
  }

  function reset() {
    setSelected(null)
    setSearch('')
    setQuantity(1)
    setUnitPrice(800)
    setPaymentType('CASH')
    setNote('')
    setError('')
  }

  async function handleSubmit() {
    if (!selected) { setError('請先選擇客戶'); return }
    setLoading(true)
    setError('')
    try {
      await api.createOrder({
        customerId: selected.id,
        quantity,
        unitPrice,
        paymentType,
        note,
      })
      setSuccess(`✅ 已建單：${selected.name} × ${quantity} 桶`)
      onOrderCreated?.()
      reset()
      setTimeout(() => setSuccess(''), 3000)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const total = quantity * unitPrice

  return (
    <div className="max-w-lg mx-auto p-4 space-y-4">
      <h2 className="text-xl font-bold text-gray-800">📋 快速接單</h2>

      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 rounded-xl p-3 text-sm font-medium">
          {success}
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-600 rounded-xl p-3 text-sm">
          {error}
        </div>
      )}

      {/* 客戶搜尋 */}
      <div className="relative">
        <label className="block text-sm font-medium text-gray-700 mb-1">客戶（姓名或電話）</label>
        <input
          className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
          placeholder="輸入姓名或電話搜尋..."
          value={search}
          onChange={e => { setSearch(e.target.value); setSelected(null) }}
        />
        {results.length > 0 && (
          <div className="absolute z-10 w-full bg-white border border-gray-200 rounded-xl shadow-lg mt-1 max-h-60 overflow-y-auto">
            {results.map(c => (
              <div
                key={c.id}
                className="px-4 py-3 hover:bg-orange-50 cursor-pointer border-b last:border-b-0"
                onClick={() => selectCustomer(c)}
              >
                <div className="font-medium text-gray-800">{c.name}</div>
                <div className="text-sm text-gray-500">{c.phone}　{c.address}</div>
                {Number(c.amount_owed) > 0 && (
                  <div className="text-xs text-red-500 mt-0.5">欠款 ${Number(c.amount_owed).toLocaleString()}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 選中的客戶資訊 */}
      {selected && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-3">
          <div className="font-medium text-gray-800">{selected.name}</div>
          <div className="text-sm text-gray-600">{selected.phone}　{selected.address}</div>
          {Number(selected.amount_owed) > 0 && (
            <div className="text-sm text-red-500 mt-1">⚠️ 目前欠款 ${Number(selected.amount_owed).toLocaleString()}</div>
          )}
        </div>
      )}

      {/* 桶數 */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">桶數</label>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setQuantity(q => Math.max(1, q - 1))}
            className="w-12 h-12 rounded-full bg-gray-200 hover:bg-gray-300 text-xl font-bold transition"
          >−</button>
          <span className="text-3xl font-bold text-gray-800 w-12 text-center">{quantity}</span>
          <button
            onClick={() => setQuantity(q => q + 1)}
            className="w-12 h-12 rounded-full bg-orange-500 hover:bg-orange-600 text-white text-xl font-bold transition"
          >+</button>
        </div>
      </div>

      {/* 單價 */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">單價（元）</label>
        <input
          type="number"
          className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
          value={unitPrice}
          onChange={e => setUnitPrice(Number(e.target.value))}
        />
      </div>

      {/* 付款方式 */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">付款方式</label>
        <div className="flex gap-3">
          <button
            onClick={() => setPaymentType('CASH')}
            className={`flex-1 py-3 rounded-xl font-medium transition ${paymentType === 'CASH' ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >💵 現金</button>
          <button
            onClick={() => setPaymentType('AR')}
            className={`flex-1 py-3 rounded-xl font-medium transition ${paymentType === 'AR' ? 'bg-red-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >📒 欠帳</button>
        </div>
      </div>

      {/* 備註 */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">備註（選填）</label>
        <input
          className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
          placeholder="不急、指定時間..."
          value={note}
          onChange={e => setNote(e.target.value)}
        />
      </div>

      {/* 合計 */}
      <div className="bg-gray-50 rounded-xl p-4 flex justify-between items-center">
        <span className="text-gray-600 font-medium">合計金額</span>
        <span className="text-2xl font-bold text-orange-600">${total.toLocaleString()}</span>
      </div>

      {/* 送出 */}
      <button
        onClick={handleSubmit}
        disabled={loading || !selected}
        className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 text-white font-bold py-4 rounded-xl text-lg transition"
      >
        {loading ? '建單中...' : '✅ 建立訂單'}
      </button>
    </div>
  )
}
