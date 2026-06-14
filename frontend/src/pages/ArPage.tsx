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

function getOverdueLevel(lastPayment: string | null): 'normal' | 'warning' | 'danger' {
  if (!lastPayment) return 'warning'
  const days = Math.floor((Date.now() - new Date(lastPayment).getTime()) / (1000 * 60 * 60 * 24))
  if (days >= 45) return 'danger'
  if (days >= 30) return 'warning'
  return 'normal'
}

function getOverdueBadge(lastPayment: string | null): string | null {
  if (!lastPayment) return '從未收款'
  const days = Math.floor((Date.now() - new Date(lastPayment).getTime()) / (1000 * 60 * 60 * 24))
  if (days >= 30) return `${days}天未收款`
  return null
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
  const [tab, setTab] = useState<'unpaid' | 'paid'>('unpaid')
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
  const [monthFilter, setMonthFilter] = useState('')
  const [monthData, setMonthData] = useState<any[]>([])
  const [monthLoading, setMonthLoading] = useState(false)
  const monthOptions = getMonthOptions()

  async function load() {
    setLoading(true)
    try {
      const res = await api.getArBalances(search, undefined, tab)
      setBalances(res.balances)
    } finally {
      setLoading(false)
    }
  }

  async function loadMonth(month: string) {
    setMonthLoading(true)
    try {
      const res = await api.getArBalances(undefined, month, tab)
      setMonthData(res.monthBalances || [])
    } finally {
      setMonthLoading(false)
    }
  }

  useEffect(() => { load() }, [tab])

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
      if (monthFilter) loadMonth(monthFilter)
    } finally {
      setPayLoading(false)
    }
  }

  // 月份篩選後的顯示列表
  const displayBalances = monthFilter
    ? balances.filter(b => monthData.some(m => m.customer_id === b.customer_id))
    : balances

  // 總計：有月份篩選時顯示該月應收，否則顯示全部欠款
  const monthTotal = monthData.reduce((s, b) => s + Number(b.month_amount), 0)
  const totalOwed = monthFilter
    ? monthTotal
    : balances.reduce((s, b) => s + Number(b.amount_owed), 0)

  // 對帳單視圖
  if (view === 'statement' && statement) {
    const { customer, orders, payments, summary } = statement
    return (
      <div className="max-w-lg mx-auto p-4">
        <div className="print:hidden flex items-center gap-2 mb-4">
          <button onClick={() => setView('detail')} className="text-orange-500 text-sm">← 返回</button>
          <span className="text-gray-400">|</span>
          <button onClick={() => window.print()} className="text-sm bg-orange-500 text-white px-3 py-1.5 rounded-lg">🖨 列印 / 存PDF</button>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <div className="text-center border-b border-gray-200 pb-4">
            <h1 className="text-xl font-bold text-gray-800">榮泰行 瓦斯對帳單</h1>
            <p className="text-sm text-gray-500 mt-1">{summary.month ? monthOptions.find(m => m.value === summary.month)?.label : '全部'}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div><span className="text-gray-500">客戶：</span><span className="font-medium">{customer.name}</span></div>
            <div><span className="text-gray-500">電話：</span><span>{customer.phone}</span></div>
            <div className="col-span-2"><span className="text-gray-500">地址：</span><span>{customer.address}</span></div>
            <div><span className="text-gray-500">列印日期：</span><span>{new Date().toLocaleDateString('zh-TW')}</span></div>
          </div>
          <div>
            <div className="text-sm font-medium text-gray-700 mb-2">送貨記錄</div>
            <table className="w-full text-sm border-collapse">
              <thead><tr className="bg-gray-50">
                <th className="text-left p-2 border border-gray-200">日期</th>
                <th className="text-left p-2 border border-gray-200">品項</th>
                <th className="text-right p-2 border border-gray-200">金額</th>
              </tr></thead>
              <tbody>
                {orders.map((o: any, i: number) => (
                  <tr key={i}>
                    <td className="p-2 border border-gray-200">{new Date(o.created_at).toLocaleDateString('zh-TW')}</td>
                    <td className="p-2 border border-gray-200">{o.quantity}桶{o.note ? ` (${o.note})` : ''}</td>
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
          {payments.length > 0 && (
            <div>
              <div className="text-sm font-medium text-gray-700 mb-2">收款記錄</div>
              <table className="w-full text-sm border-collapse">
                <thead><tr className="bg-gray-50">
                  <th className="text-left p-2 border border-gray-200">日期</th>
                  <th className="text-left p-2 border border-gray-200">方式</th>
                  <th className="text-right p-2 border border-gray-200">金額</th>
                </tr></thead>
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
          <div className="border-t-2 border-gray-800 pt-3">
            <div className="flex justify-between text-lg font-bold">
              <span>尚欠金額</span>
              <span className="text-red-600">${Number(summary.balance).toLocaleString()}</span>
            </div>
          </div>
          <div className="text-center text-xs text-gray-400 pt-2 border-t border-gray-100">如有疑問請聯繫 榮泰行</div>
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
          <input className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none" placeholder="備註（選填）" value={payNote} onChange={e => setPayNote(e.target.value)} />
          <button onClick={handlePay} disabled={payLoading || !payAmount} className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 text-white font-bold py-3 rounded-xl transition">
            {payLoading ? '處理中...' : '✅ 確認收款'}
          </button>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium text-gray-700">產生對帳單</div>
          <div className="flex gap-2 flex-wrap">
            {monthOptions.map(m => (
              <button key={m.value} onClick={() => openStatement(m.value)} className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 text-sm rounded-lg transition">{m.label}</button>
            ))}
            <button onClick={() => openStatement()} className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm rounded-lg transition">全部</button>
          </div>
        </div>

        {detail.monthlyOrders?.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium text-gray-700">月份明細</div>
            {detail.monthlyOrders.map((m: any) => (
              <div key={m.month} className="bg-white border border-gray-200 rounded-xl p-3 flex justify-between items-center">
                <div>
                  <div className="font-medium text-gray-800">{m.month_label}</div>
                  <div className="text-xs text-gray-500">{m.order_count} 單 · {m.total_cylinders} 桶</div>
                </div>
                <div className="font-bold text-gray-800">${Number(m.total_amount).toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}

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

      {/* Tab */}
      <div className="flex bg-gray-100 rounded-xl p-1">
        <button onClick={() => { setTab('unpaid'); setMonthFilter(''); setMonthData([]) }} className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${tab === 'unpaid' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>
          未結清
        </button>
        <button onClick={() => { setTab('paid'); setMonthFilter(''); setMonthData([]) }} className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${tab === 'paid' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>
          已結清
        </button>
      </div>

      {/* 應收總計 */}
      <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex justify-between items-center">
        <span className="text-gray-600 font-medium">
          {monthFilter ? `${monthOptions.find(m => m.value === monthFilter)?.label} 應收` : '應收帳款總計'}
        </span>
        <span className="text-2xl font-bold text-red-600">${totalOwed.toLocaleString()}</span>
      </div>

      {/* 月份查詢 */}
      {tab === 'unpaid' && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
          <div className="text-sm font-medium text-gray-700">📅 按月篩選</div>
          <div className="flex gap-2 flex-wrap">
            {monthOptions.map(m => (
              <button key={m.value} onClick={() => {
                const newMonth = monthFilter === m.value ? '' : m.value
                setMonthFilter(newMonth)
                if (newMonth) loadMonth(newMonth)
                else setMonthData([])
              }} className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${monthFilter === m.value ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {m.label}
              </button>
            ))}
          </div>
          {monthFilter && monthLoading && <div className="text-center text-gray-400 text-sm py-2">載入中...</div>}
        </div>
      )}

      {/* 搜尋 */}
      <div className="flex gap-2">
        <input className="flex-1 border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-orange-400" placeholder="搜尋客戶..." value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && load()} />
        <button onClick={load} className="px-4 py-2.5 bg-orange-500 text-white rounded-xl font-medium">搜尋</button>
      </div>

      {loading && <div className="text-center text-gray-400 py-8">載入中...</div>}

      {/* 客戶列表 */}
      {!loading && displayBalances.map(b => {
        const level = getOverdueLevel(b.last_payment)
        const badge = getOverdueBadge(b.last_payment)
        const borderClass = level === 'danger' ? 'border-red-400 bg-red-50' : level === 'warning' ? 'border-orange-300 bg-orange-50' : 'border-gray-200 bg-white'
        const monthInfo = monthData.find(m => m.customer_id === b.customer_id)
        return (
          <div key={b.id} className={`border rounded-xl p-4 shadow-sm cursor-pointer transition hover:opacity-90 ${borderClass}`} onClick={() => openDetail(b)}>
            <div className="flex justify-between items-start">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-gray-800">{b.customer_name}</span>
                  {badge && tab === 'unpaid' && (
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${level === 'danger' ? 'bg-red-500 text-white' : 'bg-orange-400 text-white'}`}>⚠️ {badge}</span>
                  )}
                </div>
                <div className="text-sm text-gray-500">{b.customer_phone}</div>
                <div className="text-sm text-gray-500">{b.customer_address}</div>
                <div className="text-xs text-gray-400 mt-1">
                  {b.last_payment ? `上次收款：${new Date(b.last_payment).toLocaleDateString('zh-TW')}` : '尚未收款'}
                </div>
                {monthInfo && (
                  <div className="text-xs text-orange-600 mt-1">本月送貨：{monthInfo.month_cylinders} 桶</div>
                )}
              </div>
              <div className="text-right">
                <div className={`text-xl font-bold ${level === 'danger' ? 'text-red-600' : 'text-red-500'}`}>
                  ${Number(monthFilter && monthInfo ? monthInfo.month_amount : b.amount_owed).toLocaleString()}
                </div>
                <div className="text-xs text-gray-400">{monthFilter && monthInfo ? '本月' : '累計'}</div>
              </div>
            </div>
          </div>
        )
      })}

      {!loading && displayBalances.length === 0 && (
        <div className="text-center text-gray-400 py-12">
          {tab === 'paid' ? '目前沒有已結清客戶' : monthFilter ? '該月無欠帳記錄' : '目前沒有欠帳客戶 🎉'}
        </div>
      )}
    </div>
  )
}
