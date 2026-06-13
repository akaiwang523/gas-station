import { useState, useEffect } from 'react'
import { api } from '../lib/api'

type Balance = {
  id: number
  customer_id: number
  customer_name: string
  customer_phone: string
  customer_address: string
  amount_owed: number
  cylinders_owed: number
  last_payment: string | null
  updated_at: string
}

export default function ArPage() {
  const [balances, setBalances] = useState<Balance[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Balance | null>(null)
  const [detail, setDetail] = useState<any>(null)
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState('CASH')
  const [payLoading, setPayLoading] = useState(false)
  const [payNote, setPayNote] = useState('')

  async function load() {
    setLoading(true)
    try {
      const res = await api.getArBalances(search)
      setBalances(res.balances)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function openDetail(b: Balance) {
    setSelected(b)
    const res = await api.getCustomerAr(b.customer_id)
    setDetail(res)
    setPayAmount(String(Math.round(Number(b.amount_owed))))
  }

  async function handlePay() {
    if (!selected || !payAmount) return
    setPayLoading(true)
    try {
      await api.receivePayment(selected.customer_id, {
        amount: Number(payAmount),
        method: payMethod,
        note: payNote,
      })
      await load()
      setSelected(null)
      setDetail(null)
    } finally {
      setPayLoading(false)
    }
  }

  const totalOwed = balances.reduce((s, b) => s + Number(b.amount_owed), 0)

  return (
    <div className="max-w-lg mx-auto p-4 space-y-4">
      <h2 className="text-xl font-bold text-gray-800">📒 欠帳管理</h2>

      {/* 總計 */}
      <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex justify-between items-center">
        <span className="text-gray-600 font-medium">應收帳款總計</span>
        <span className="text-2xl font-bold text-red-600">${totalOwed.toLocaleString()}</span>
      </div>

      {/* 搜尋 */}
      <div className="flex gap-2">
        <input
          className="flex-1 border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
          placeholder="搜尋客戶..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && load()}
        />
        <button onClick={load} className="px-4 py-2.5 bg-orange-500 text-white rounded-xl font-medium">搜尋</button>
      </div>

      {loading && <div className="text-center text-gray-400 py-8">載入中...</div>}

      {/* 欠帳列表 */}
      {!loading && balances.map(b => (
        <div
          key={b.id}
          className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm cursor-pointer hover:border-orange-300 transition"
          onClick={() => openDetail(b)}
        >
          <div className="flex justify-between items-start">
            <div>
              <div className="font-bold text-gray-800">{b.customer_name}</div>
              <div className="text-sm text-gray-500">{b.customer_phone}</div>
              <div className="text-sm text-gray-500">{b.customer_address}</div>
            </div>
            <div className="text-right">
              <div className="text-xl font-bold text-red-600">${Number(b.amount_owed).toLocaleString()}</div>
              <div className="text-xs text-gray-400">{b.cylinders_owed} 桶</div>
            </div>
          </div>
          {b.last_payment && (
            <div className="text-xs text-gray-400 mt-2">
              上次還款：{new Date(b.last_payment).toLocaleDateString('zh-TW')}
            </div>
          )}
        </div>
      ))}

      {!loading && balances.length === 0 && (
        <div className="text-center text-gray-400 py-12">目前沒有欠帳客戶 🎉</div>
      )}

      {/* 收款 Modal */}
      {selected && (
        <div className="fixed inset-0 bg-black/50 flex items-end z-50" onClick={() => { setSelected(null); setDetail(null) }}>
          <div className="bg-white w-full max-w-lg mx-auto rounded-t-2xl p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-bold">{selected.customer_name} 收款</h3>
              <button onClick={() => { setSelected(null); setDetail(null) }} className="text-gray-400 text-2xl">×</button>
            </div>

            <div className="bg-red-50 rounded-xl p-3 flex justify-between">
              <span className="text-gray-600">目前欠款</span>
              <span className="font-bold text-red-600">${Number(selected.amount_owed).toLocaleString()}</span>
            </div>

            {/* 最近欠帳訂單 */}
            {detail?.orders?.length > 0 && (
              <div className="space-y-1 max-h-32 overflow-y-auto">
                <div className="text-xs text-gray-400 font-medium">欠帳訂單記錄</div>
                {detail.orders.slice(0, 5).map((o: any) => (
                  <div key={o.id} className="flex justify-between text-sm text-gray-600 bg-gray-50 rounded-lg px-3 py-1.5">
                    <span>{new Date(o.created_at).toLocaleDateString('zh-TW')} × {o.quantity} 桶</span>
                    <span>${Number(o.total_amount).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">收款金額</label>
              <input
                type="number"
                className="w-full border border-gray-300 rounded-xl px-4 py-3 text-xl font-bold focus:outline-none focus:ring-2 focus:ring-orange-400"
                value={payAmount}
                onChange={e => setPayAmount(e.target.value)}
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setPayMethod('CASH')}
                className={`flex-1 py-2.5 rounded-xl font-medium text-sm transition ${payMethod === 'CASH' ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-600'}`}
              >💵 現金</button>
              <button
                onClick={() => setPayMethod('TRANSFER')}
                className={`flex-1 py-2.5 rounded-xl font-medium text-sm transition ${payMethod === 'TRANSFER' ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600'}`}
              >🏦 轉帳</button>
              <button
                onClick={() => setPayMethod('LINE_PAY')}
                className={`flex-1 py-2.5 rounded-xl font-medium text-sm transition ${payMethod === 'LINE_PAY' ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-600'}`}
              >LINE Pay</button>
            </div>

            <input
              className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
              placeholder="備註（選填）"
              value={payNote}
              onChange={e => setPayNote(e.target.value)}
            />

            <button
              onClick={handlePay}
              disabled={payLoading || !payAmount}
              className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 text-white font-bold py-3 rounded-xl text-base transition"
            >
              {payLoading ? '處理中...' : '✅ 確認收款'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
