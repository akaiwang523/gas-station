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
}

const METHOD_LABELS: Record<string, string> = {
  CASH: '現金', TRANSFER: '轉帳', LINE_PAY: 'LINE Pay',
}

function getMonthOptions() {
  const options = []
  const now = new Date()
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = `${d.getFullYear()}年${d.getMonth() + 1}月`
    options.push({ value, label })
  }
  return options
}

export default function ArPage() {
  const [balances, setBalances] = useState<Balance[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Balance | null>(null)
  const [detail, setDetail] = useState<any>(null)
  const [view, setView] = useState<'list' | 'detail' | 'statement'>('list')
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState('CASH')
  const [payNote, setPayNote] = useState('')
  const [payLoading, setPayLoading] = useState(false)
  const [statement, setStatement] = useState<any>(null)
  const [_stmtMonth, setStmtMonth] = useState('')
  const monthOptions = getMonthOptions()

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
    setView('detail')
  }

  async function openStatement(month?: string) {
    if (!selected) return
    const res = await api.getStatement(selected.customer_id, month)
    setStatement(res)
    setStmtMonth(month || '')
    setView('statement')
  }

  async function handlePay() {
    if (!selected || !payAmount) return
    setPayLoading(true)
    try {
      await api.receivePayment(selected.customer_id, { amount: Number(payAmount), method: payMethod, note: payNote })
      await load()
      setView('list')
      setSelected(null)
      setDetail(null)
    } finally {
      setPayLoading(false)
    }
  }

  function printStatement() {
    window.print()
  }

  const totalOwed = balances.reduce((s, b) => s + Number(b.amount_owed), 0)

  // 對帳單視圖
  if (view === 'statement' && statement) {
    const { customer, orders, payments, summary } = statement
    return (
      <div className="max-w-lg mx-auto p-4">
        <div className="print:hidden flex items-center gap-2 mb-4">
          <button onClick={() => setView('detail')} className="text-orange-500 text-sm">← 返回</button>
          <span className="text-gray-400">|</span>
          <button onClick={printStatement} className="text-sm bg-orange-500 text-white px-3 py-1.5 rounded-lg">🖨 列印 / 存PDF</button>
        </div>

        {/* 對帳單內容 */}
        <div id="statement-content" className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <div className="text-center border-b border-gray-200 pb-4">
            <h1 className="text-xl font-bold text-gray-800">榮泰行 瓦斯對帳單</h1>
            <p className="text-sm text-gray-500 mt-1">{summary.month ? monthOptions.find(m => m.value === summary.month)?.label || summary.month : '全部'}</p>
          </div>

          <div className="grid grid-cols-2 gap-2 text-sm">
            <div><span className="text-gray-500">客戶：</span><span className="font-medium">{customer.name}</span></div>
            <div><span className="text-gray-500">電話：</span><span>{customer.phone}</span></div>
            <div className="col-span-2"><span className="text-gray-500">地址：</span><span>{customer.address}</span></div>
            <div><span className="text-gray-500">列印日期：</span><span>{new Date().toLocaleDateString('zh-TW')}</span></div>
          </div>

          {/* 送貨明細 */}
          <div>
            <div className="text-sm font-medium text-gray-700 mb-2">送貨記錄</div>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-50">
                  <th className="text-left p-2 border border-gray-200">日期</th>
                  <th className="text-left p-2 border border-gray-200">品項</th>
                  <th className="text-right p-2 border border-gray-200">金額</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o: any, i: number) => (
                  <tr key={i}>
                    <td className="p-2 border border-gray-200">{new Date(o.created_at).toLocaleDateString('zh-TW')}</td>
                    <td className="p-2 border border-gray-200">
                      {o.items_str ? o.items_str.split(',').map((item: string) => {
                        const [typeQtyPrice] = item.split('@')
                        const [typeQty] = typeQtyPrice.split('x')
                        return typeQty
                      }).join('、') : `${o.quantity}桶`}
                      {o.note ? ` (${o.note})` : ''}
                    </td>
                    <td className="p-2 border border-gray-200 text-right">${Number(o.total_amount).toLocaleString()}</td>
                  </tr>
                ))}
                <tr className="font-medium bg-gray-50">
                  <td colSpan={2} className="p-2 border border-gray-200 text-right">小計</td>
                  <td className="p-2 border border-gray-200 text-right">${Number(summary.total_orders).toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* 收款記錄 */}
          {payments.length > 0 && (
            <div>
              <div className="text-sm font-medium text-gray-700 mb-2">收款記錄</div>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="text-left p-2 border border-gray-200">日期</th>
                    <th className="text-left p-2 border border-gray-200">方式</th>
                    <th className="text-right p-2 border border-gray-200">金額</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p: any, i: number) => (
                    <tr key={i}>
                      <td className="p-2 border border-gray-200">{new Date(p.paid_at).toLocaleDateString('zh-TW')}</td>
                      <td className="p-2 border border-gray-200">{METHOD_LABELS[p.method] || p.method}</td>
                      <td className="p-2 border border-gray-200 text-right">${Number(p.amount).toLocaleString()}</td>
                    </tr>
                  ))}
                  <tr className="font-medium bg-gray-50">
                    <td colSpan={2} className="p-2 border border-gray-200 text-right">已付合計</td>
                    <td className="p-2 border border-gray-200 text-right">${Number(summary.total_paid).toLocaleString()}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* 總計 */}
          <div className="border-t-2 border-gray-800 pt-3">
            <div className="flex justify-between text-lg font-bold">
              <span>尚欠金額</span>
              <span className="text-red-600">${Number(summary.balance).toLocaleString()}</span>
            </div>
          </div>

          <div className="text-center text-xs text-gray-400 pt-2 border-t border-gray-100">
            如有疑問請聯繫 榮泰行
          </div>
        </div>
      </div>
    )
  }

  // 客戶明細視圖
  if (view === 'detail' && selected && detail) {
    return (
      <div className="max-w-lg mx-auto p-4 space-y-4">
        <button onClick={() => { setView('list'); setSelected(null); setDetail(null) }} className="text-orange-500 text-sm">← 返回列表</button>

        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex justify-between items-start">
            <div>
              <div className="font-bold text-gray-800 text-lg">{selected.customer_name}</div>
              <div className="text-sm text-gray-500">{selected.customer_phone}</div>
              <div className="text-sm text-gray-500">{selected.customer_address}</div>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold text-red-600">${Number(selected.amount_owed).toLocaleString()}</div>
              <div className="text-xs text-gray-400">累計欠款</div>
            </div>
          </div>
        </div>

        {/* 收款區 */}
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 space-y-3">
          <div className="text-sm font-medium text-orange-700">收款</div>
          <input type="number" className="w-full border border-gray-300 rounded-xl px-4 py-3 text-xl font-bold focus:outline-none focus:ring-2 focus:ring-orange-400" value={payAmount} onChange={e => setPayAmount(e.target.value)} />
          <div className="flex gap-2">
            {['CASH','TRANSFER','LINE_PAY'].map(m => (
              <button key={m} onClick={() => setPayMethod(m)} className={`flex-1 py-2 rounded-xl text-sm font-medium transition ${payMethod === m ? 'bg-orange-500 text-white' : 'bg-white text-gray-600'}`}>
                {METHOD_LABELS[m]}
              </button>
            ))}
          </div>
          <input className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400" placeholder="備註（選填）" value={payNote} onChange={e => setPayNote(e.target.value)} />
          <button onClick={handlePay} disabled={payLoading || !payAmount} className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 text-white font-bold py-3 rounded-xl transition">
            {payLoading ? '處理中...' : '✅ 確認收款'}
          </button>
        </div>

        {/* 對帳單按鈕 */}
        <div className="space-y-2">
          <div className="text-sm font-medium text-gray-700">產生對帳單</div>
          <div className="flex gap-2 flex-wrap">
            {monthOptions.map(m => (
              <button key={m.value} onClick={() => openStatement(m.value)} className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 text-sm rounded-lg transition">
                {m.label}
              </button>
            ))}
            <button onClick={() => openStatement()} className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm rounded-lg transition">
              全部
            </button>
          </div>
        </div>

        {/* 月份明細 */}
        {detail.monthlyOrders?.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium text-gray-700">月份明細</div>
            {detail.monthlyOrders.map((m: any) => (
              <div key={m.month} className="bg-white border border-gray-200 rounded-xl p-3 flex justify-between items-center">
                <div>
                  <div className="font-medium text-gray-800">{m.month_label}</div>
                  <div className="text-xs text-gray-500">{m.order_count} 單 · {m.total_cylinders} 桶</div>
                </div>
                <div className="text-right">
                  <div className="font-bold text-gray-800">${Number(m.total_amount).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 收款記錄 */}
        {detail.payments?.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium text-gray-700">收款記錄</div>
            {detail.payments.map((p: any, i: number) => (
              <div key={i} className="bg-green-50 border border-green-100 rounded-xl p-3 flex justify-between">
                <div>
                  <div className="text-sm font-medium text-gray-700">{METHOD_LABELS[p.method]}</div>
                  <div className="text-xs text-gray-400">{new Date(p.paid_at).toLocaleDateString('zh-TW')}</div>
                </div>
                <div className="font-bold text-green-600">${Number(p.amount).toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // 列表視圖
  return (
    <div className="max-w-lg mx-auto p-4 space-y-4">
      <h2 className="text-xl font-bold text-gray-800">📒 欠帳管理</h2>

      <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex justify-between items-center">
        <span className="text-gray-600 font-medium">應收帳款總計</span>
        <span className="text-2xl font-bold text-red-600">${totalOwed.toLocaleString()}</span>
      </div>

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

      {!loading && balances.map(b => (
        <div key={b.id} className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm cursor-pointer hover:border-orange-300 transition" onClick={() => openDetail(b)}>
          <div className="flex justify-between items-start">
            <div>
              <div className="font-bold text-gray-800">{b.customer_name}</div>
              <div className="text-sm text-gray-500">{b.customer_phone}</div>
              <div className="text-sm text-gray-500">{b.customer_address}</div>
              {b.last_payment && (
                <div className="text-xs text-gray-400 mt-1">上次還款：{new Date(b.last_payment).toLocaleDateString('zh-TW')}</div>
              )}
            </div>
            <div className="text-right">
              <div className="text-xl font-bold text-red-600">${Number(b.amount_owed).toLocaleString()}</div>
              <div className="text-xs text-gray-400">{b.cylinders_owed} 桶</div>
            </div>
          </div>
        </div>
      ))}

      {!loading && balances.length === 0 && (
        <div className="text-center text-gray-400 py-12">目前沒有欠帳客戶 🎉</div>
      )}
    </div>
  )
}
