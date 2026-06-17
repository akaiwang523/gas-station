import { useState, useEffect } from 'react'
import { api } from '../lib/api'

const GAS_LABELS: Record<string, string> = {
  BOTTLED_20KG: '20kg 桶裝',
  BOTTLED_16KG: '16kg 桶裝',
  BOTTLED_4KG: '4kg 桶裝',
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

export default function ReportPage() {
  const [activeTab, setActiveTab] = useState<'report' | 'orders'>('report')
  const [searchOrders, setSearchOrders] = useState<any[]>([])
  const [searchDate, setSearchDate] = useState('')
  const [searchCustomer, setSearchCustomer] = useState('')
  const [searchLoading, setSearchLoading] = useState(false)
  const [today, setToday] = useState<any>(null)
  const [monthData, setMonthData] = useState<any>(null)
  const [selectedMonth, setSelectedMonth] = useState(getMonthOptions()[0].value)
  const [loading, setLoading] = useState(false)
  const monthOptions = getMonthOptions()

  async function searchOrderHistory() {
    setSearchLoading(true)
    try {
      const params: any = { all: true, limit: 200 }
      if (searchDate) params.date = searchDate
      const res = await api.getOrders(params)
      const filtered = searchCustomer
        ? res.orders.filter((o: any) => o.customer_name?.includes(searchCustomer) || o.customer_phone?.includes(searchCustomer))
        : res.orders
      setSearchOrders(filtered)
    } finally {
      setSearchLoading(false)
    }
  }

  useEffect(() => {
    loadToday()
    loadMonth(selectedMonth)
  }, [])

  async function loadToday() {
    try {
      const res = await api.getTodayReport()
      setToday(res)
    } catch {}
  }

  async function loadMonth(month: string) {
    setLoading(true)
    try {
      const res = await api.getMonthReport(month)
      setMonthData(res)
    } finally {
      setLoading(false)
    }
  }

  function handleMonthChange(month: string) {
    setSelectedMonth(month)
    loadMonth(month)
  }

  function exportCsv() {
    const token = localStorage.getItem('token')
    window.open(`/api/reports/export?month=${selectedMonth}&token=${token}`)
  }

  const maxDaily = monthData?.daily?.reduce((max: number, d: any) => Math.max(max, Number(d.amount)), 0) || 1

  return (
    <div className="max-w-lg mx-auto p-4 space-y-4">
      <h2 className="text-xl font-bold text-gray-800">📊 報表</h2>

      {/* Tab 切換 */}
      <div className="flex bg-gray-100 rounded-xl p-1">
        <button onClick={() => setActiveTab('report')} className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${activeTab === 'report' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>
          統計報表
        </button>
        <button onClick={() => setActiveTab('orders')} className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${activeTab === 'orders' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>
          訂單查詢
        </button>
      </div>

      {activeTab === 'report' && <>
      {/* 今日快覽 */}
      {today && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
          <div className="text-sm font-medium text-gray-700">今日快覽</div>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-green-50 rounded-xl p-3">
              <div className="text-xs text-gray-500 mb-1">現金收入</div>
              <div className="text-xl font-bold text-green-600">${Number(today.cash_amount || 0).toLocaleString()}</div>
            </div>
            <div className="bg-red-50 rounded-xl p-3">
              <div className="text-xs text-gray-500 mb-1">欠帳金額</div>
              <div className="text-xl font-bold text-red-500">${Number(today.ar_amount || 0).toLocaleString()}</div>
            </div>
            <div className="bg-blue-50 rounded-xl p-3">
              <div className="text-xs text-gray-500 mb-1">總桶數</div>
              <div className="text-xl font-bold text-blue-600">{today.total_cylinders || 0} 桶</div>
            </div>
            <div className="bg-orange-50 rounded-xl p-3">
              <div className="text-xs text-gray-500 mb-1">待送訂單</div>
              <div className="text-xl font-bold text-orange-600">{today.pending_count || 0} 單</div>
            </div>
          </div>
          <div className="bg-gray-50 rounded-xl p-3 flex justify-between">
            <span className="text-sm text-gray-500">今日總營業額</span>
            <span className="font-bold text-gray-800">${Number(today.total_amount || 0).toLocaleString()}</span>
          </div>
        </div>
      )}

      {/* 月份選擇 */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {monthOptions.map(m => (
          <button key={m.value} onClick={() => handleMonthChange(m.value)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition ${selectedMonth === m.value ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-600'}`}>
            {m.label}
          </button>
        ))}
      </div>

      {loading && <div className="text-center text-gray-400 py-8">載入中...</div>}

      {!loading && monthData && (
        <>
          {/* 月份總計 */}
          <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
            <div className="text-sm font-medium text-gray-700">
              {monthOptions.find(m => m.value === selectedMonth)?.label} 總計
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-gray-50 rounded-xl p-3">
                <div className="text-xs text-gray-500 mb-1">總營業額</div>
                <div className="text-lg font-bold text-gray-800">${Number(monthData.summary?.total_amount || 0).toLocaleString()}</div>
              </div>
              <div className="bg-green-50 rounded-xl p-3">
                <div className="text-xs text-gray-500 mb-1">現金收入</div>
                <div className="text-lg font-bold text-green-600">${Number(monthData.summary?.cash_amount || 0).toLocaleString()}</div>
              </div>
              <div className="bg-red-50 rounded-xl p-3">
                <div className="text-xs text-gray-500 mb-1">欠帳金額</div>
                <div className="text-lg font-bold text-red-500">${Number(monthData.summary?.ar_amount || 0).toLocaleString()}</div>
              </div>
              <div className="bg-blue-50 rounded-xl p-3">
                <div className="text-xs text-gray-500 mb-1">總訂單數</div>
                <div className="text-lg font-bold text-blue-600">{monthData.summary?.total_orders || 0} 單</div>
              </div>
            </div>
          </div>

          {/* 品項統計 */}
          {monthData.cylinders?.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <div className="text-sm font-medium text-gray-700 mb-3">品項統計</div>
              <div className="space-y-2">
                {monthData.cylinders.map((c: any) => (
                  <div key={c.gas_type} className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">{GAS_LABELS[c.gas_type] || c.gas_type}</span>
                    <div className="text-right">
                      <span className="font-medium text-gray-800">{c.qty} 桶</span>
                      <span className="text-sm text-gray-400 ml-2">${Number(c.amount).toLocaleString()}</span>
                    </div>
                  </div>
                ))}
                <div className="flex justify-between items-center pt-2 border-t border-gray-100">
                  <span className="text-sm font-medium text-gray-700">合計</span>
                  <span className="font-bold text-gray-800">{monthData.summary?.total_cylinders || 0} 桶</span>
                </div>
              </div>
            </div>
          )}

          {/* 每日趨勢 */}
          {monthData.daily?.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <div className="text-sm font-medium text-gray-700 mb-3">每日營業額</div>
              <div className="flex items-end gap-1 h-24">
                {monthData.daily.map((d: any) => (
                  <div key={d.day} className="flex-1 flex flex-col items-center gap-1">
                    <div className="w-full bg-orange-400 rounded-sm" style={{ height: `${Math.max(4, (Number(d.amount) / maxDaily) * 80)}px` }}></div>
                    <span className="text-xs text-gray-400">{d.day}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 前五名客戶 */}
          {monthData.topCustomers?.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <div className="text-sm font-medium text-gray-700 mb-3">本月消費前五名</div>
              <div className="space-y-2">
                {monthData.topCustomers.map((c: any, i: number) => (
                  <div key={i} className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <span className={`w-5 h-5 rounded-full text-xs flex items-center justify-center font-bold ${i === 0 ? 'bg-yellow-400 text-white' : i === 1 ? 'bg-gray-300 text-white' : i === 2 ? 'bg-orange-300 text-white' : 'bg-gray-100 text-gray-500'}`}>{i + 1}</span>
                      <div>
                        <div className="text-sm font-medium text-gray-800">{c.name}</div>
                        <div className="text-xs text-gray-400">{c.order_count} 單 · {c.cylinders} 桶</div>
                      </div>
                    </div>
                    <span className="font-bold text-gray-800">${Number(c.amount).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 匯出 */}
          <button onClick={exportCsv} className="w-full bg-gray-800 hover:bg-gray-900 text-white font-medium py-3 rounded-xl transition flex items-center justify-center gap-2">
            <span>📥</span> 匯出 {monthOptions.find(m => m.value === selectedMonth)?.label} 訂單 CSV
          </button>
        </>
      )}
      </>}

      {/* 訂單查詢 */}
      {activeTab === 'orders' && (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                type="date"
                className="flex-1 border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
                value={searchDate}
                onChange={e => setSearchDate(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <input
                className="flex-1 border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
                placeholder="客戶姓名或電話..."
                value={searchCustomer}
                onChange={e => setSearchCustomer(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && searchOrderHistory()}
              />
              <button onClick={searchOrderHistory} className="px-4 py-2.5 bg-orange-500 text-white rounded-xl font-medium">搜尋</button>
            </div>
          </div>

          {searchLoading && <div className="text-center text-gray-400 py-8">載入中...</div>}

          {!searchLoading && searchOrders.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm text-gray-500">{searchDate ? `${searchDate} ` : ''}共 {searchOrders.length} 筆</div>
              {searchOrders.map((o: any) => (
                <div key={o.id} className="bg-white border border-gray-200 rounded-xl p-3">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-medium text-gray-800">{o.customer_name}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{new Date(o.created_at).toLocaleDateString('zh-TW')} · {o.customer_address}</div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {o.items?.length > 0
                          ? o.items.map((i: any) => `${i.gas_type.replace('BOTTLED_','').replace('KG','kg')}×${i.quantity}`).join(' + ')
                          : `${o.quantity}桶`}
                      </div>
                      {o.note && <div className="text-xs text-orange-500 mt-0.5">📝 {o.note}</div>}
                    </div>
                    <div className="text-right">
                      <div className="font-bold text-gray-800">${Number(o.total_amount).toLocaleString()}</div>
                      <div className={`text-xs mt-0.5 ${o.payment_type === 'AR' ? 'text-red-500' : 'text-green-600'}`}>
                        {o.payment_type === 'AR' ? '欠帳' : '現金'}
                      </div>
                      <div className={`text-xs mt-0.5 ${o.status === 'DELIVERED' ? 'text-green-500' : o.status === 'CANCELLED' ? 'text-gray-400' : 'text-orange-500'}`}>
                        {o.status === 'DELIVERED' ? '已完成' : o.status === 'CANCELLED' ? '已取消' : '待送'}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!searchLoading && searchOrders.length === 0 && searchDate && (
            <div className="text-center text-gray-400 py-8">查無訂單</div>
          )}

          {!searchLoading && searchOrders.length === 0 && !searchDate && (
            <div className="text-center text-gray-400 py-8">請選擇日期或輸入客戶搜尋</div>
          )}
        </div>
      )}
    </div>
  )
}
