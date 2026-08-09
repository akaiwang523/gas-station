import { useState, useEffect } from 'react'
import { api } from '../lib/api'

type Customer = {
  id: number
  name: string
  phone: string
  phone2: string | null
  address: string
  district: string | null
  gas_type: string
  customer_type: string | null
  price_override: number | null
  note: string | null
  status: string
  amount_owed: number
  cylinders_owed: number
  last_delivery: string | null
  delivery_cycle: string | null
  delivery_day: string | null
  default_order_quantity: number | null
  default_unit_price: number | null
}

const CUSTOMER_TYPE_LABEL: Record<string, string> = {
  COMMERCIAL: '🏪 營業用',
  RESIDENTIAL: '🏠 一般住家',
  UNKNOWN: '未分類',
}

const GAS_TYPE_LABEL: Record<string, string> = {
  BOTTLED_20KG: '20kg桶裝',
  BOTTLED_16KG: '16kg桶裝',
  BOTTLED_10KG: '10kg桶裝',
  BOTTLED_4KG: '4kg桶裝',
  PIPED: '管道瓦斯',
}

const WEEKDAY_LABEL: Record<number, string> = {
  1: '週一', 2: '週二', 3: '週三', 4: '週四', 5: '週五', 6: '週六', 7: '週日',
}

const DELIVERY_CYCLE_LABEL: Record<string, string> = {
  ON_CALL: '隨叫隨送',
  WEEKLY: '每週固定',
  MONTHLY_FIXED: '每月固定',
  FLOW_METER: '流量計',
}

const GAS_TYPE_OPTIONS = ['BOTTLED_20KG', 'BOTTLED_16KG', 'BOTTLED_10KG', 'BOTTLED_4KG'] as const

type FixedItem = { gasType: string; quantity: string }
const EMPTY_FIXED_ITEM: FixedItem = { gasType: 'BOTTLED_20KG', quantity: '' }

export default function CustomerPage({ openEditId, onOpenEditConsumed, quickEditOnly, onQuickEditClose }: { openEditId?: number | null; onOpenEditConsumed?: () => void; quickEditOnly?: boolean; onQuickEditClose?: () => void } = {}) {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [form, setForm] = useState({
    name: '', phone: '', phone2: '', address: '', district: '',
    gas_type: 'BOTTLED_20KG', customer_type: 'UNKNOWN', price_override: '', note: '',
    delivery_cycle: 'ON_CALL', default_order_quantity: '', default_unit_price: ''
  })
  const [deliveryDays, setDeliveryDays] = useState<number[]>([])
  const [showFixedDelivery, setShowFixedDelivery] = useState(false)
  // 固定配送品項：一位客戶可以設好幾種瓦斯類型各自的配送數量（例如 20kg 兩桶＋16kg 一桶）
  const [fixedItems, setFixedItems] = useState<FixedItem[]>([{ ...EMPTY_FIXED_ITEM }])
  const [saving, setSaving] = useState(false)
  // 合併客戶功能：選兩筆客戶 -> 預覽兩邊資料 -> 選要保留哪一筆 -> 確認合併
  const [mergeMode, setMergeMode] = useState(false)
  const [selectedForMerge, setSelectedForMerge] = useState<number[]>([])
  const [mergePreviewData, setMergePreviewData] = useState<{ customerA: any; customerB: any } | null>(null)
  const [mergeKeepId, setMergeKeepId] = useState<number | null>(null)
  const [mergePreviewLoading, setMergePreviewLoading] = useState(false)
  const [mergeLoading, setMergeLoading] = useState(false)

  function toggleDeliveryDay(day: number) {
    setDeliveryDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day].sort())
  }

  function updateFixedItem(idx: number, field: keyof FixedItem, value: string) {
    setFixedItems(prev => prev.map((it, i) => i === idx ? { ...it, [field]: value } : it))
  }
  function addFixedItem() {
    setFixedItems(prev => [...prev, { ...EMPTY_FIXED_ITEM }])
  }
  function removeFixedItem(idx: number) {
    setFixedItems(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev)
  }

  function closeForm() {
    setShowForm(false)
    if (quickEditOnly) onQuickEditClose?.()
  }

  async function load() {
    setLoading(true)
    try {
      const res = await api.searchCustomers(search)
      setCustomers(res.customers)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (!quickEditOnly) load() }, [])

  // 從訂單頁點「編輯客戶」跳轉過來時，直接抓該客戶資料並打開編輯視窗
  useEffect(() => {
    if (!openEditId) return
    (async () => {
      try {
        const c = await api.getCustomer(openEditId)
        await openEdit(c)
      } catch {
        alert('找不到這筆客戶資料')
      } finally {
        onOpenEditConsumed?.()
      }
    })()
  }, [openEditId])

  function openAdd() {
    setForm({
      name: '', phone: '', phone2: '', address: '', district: '',
      gas_type: 'BOTTLED_20KG', customer_type: 'UNKNOWN', price_override: '', note: '',
      delivery_cycle: 'ON_CALL', default_order_quantity: '', default_unit_price: ''
    })
    setDeliveryDays([])
    setShowFixedDelivery(false)
    setFixedItems([{ ...EMPTY_FIXED_ITEM }])
    setEditId(null)
    setShowForm(true)
  }

  // 客戶清單那邊傳進來的 c 沒有 fixedItems（列表 API 沒 join 這張表），
  // 這裡一律重新打一次 getCustomer 抓最新、完整的資料（含固定配送品項）
  async function openEdit(c: Customer) {
    let full: any = c
    try {
      full = await api.getCustomer(c.id)
    } catch {
      // 抓不到就退回用列表上現有的資料，至少基本欄位還能編輯
    }
    setForm({
      name: full.name, phone: full.phone, phone2: full.phone2 || '',
      address: full.address, district: full.district || '',
      gas_type: full.gas_type, customer_type: full.customer_type || 'UNKNOWN', price_override: full.price_override ? String(full.price_override) : '',
      note: full.note || '',
      delivery_cycle: full.delivery_cycle || 'ON_CALL',
      default_order_quantity: full.default_order_quantity ? String(full.default_order_quantity) : '',
      default_unit_price: full.default_unit_price ? String(full.default_unit_price) : '',
    })
    setDeliveryDays(
      full.delivery_day
        ? full.delivery_day.split(',').map((s: string) => Number(s.trim())).filter((n: number) => n >= 1 && n <= 7)
        : []
    )
    setShowFixedDelivery(full.delivery_cycle === 'WEEKLY' || full.delivery_cycle === 'MONTHLY_FIXED')
    setFixedItems(
      full.fixedItems && full.fixedItems.length > 0
        ? full.fixedItems.map((it: any) => ({ gasType: it.gasType, quantity: String(it.quantity) }))
        : [{ ...EMPTY_FIXED_ITEM }]
    )
    setEditId(c.id)
    setShowForm(true)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const data: any = {
        ...form,
        customer_type: form.customer_type || 'UNKNOWN',
        customerType: form.customer_type || 'UNKNOWN',
        priceOverride: form.price_override ? Number(form.price_override) : null,
        gasType: form.gas_type,
      }
      if (showFixedDelivery) {
        const validItems = fixedItems
          .map(it => ({ gasType: it.gasType, quantity: Number(it.quantity) }))
          .filter(it => it.quantity > 0)
        if (deliveryDays.length === 0 || validItems.length === 0) {
          alert('啟用固定配送時，至少選擇一個配送星期，且至少要有一個品項填數量')
          setSaving(false)
          return
        }
        data.delivery_cycle = (form.delivery_cycle === 'WEEKLY' || form.delivery_cycle === 'MONTHLY_FIXED') ? form.delivery_cycle : 'WEEKLY'
        data.delivery_day = deliveryDays.join(',')
        data.fixedItems = validItems
        // default_order_quantity 保留寫入總桶數，只是給客戶列表那頁快速顯示用，
        // 實際自動建單的品項/數量以 customer_fixed_items（fixedItems）為準
        data.default_order_quantity = validItems.reduce((s, it) => s + it.quantity, 0)
        data.default_unit_price = null
      } else {
        // 沒有啟用固定配送，強制清空相關欄位，避免殘留舊設定被排程誤判
        data.delivery_cycle = 'ON_CALL'
        data.delivery_day = null
        data.default_order_quantity = null
        data.default_unit_price = null
        data.fixedItems = []
      }
      if (editId) {
        await api.updateCustomer(editId, data)
      } else {
        await api.createCustomer(data)
      }
      closeForm()
      if (!quickEditOnly) await load()
    } finally {
      setSaving(false)
    }
  }

  function toggleMergeMode() {
    setMergeMode(m => !m)
    setSelectedForMerge([])
  }
  function toggleSelectForMerge(id: number) {
    setSelectedForMerge(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id)
      if (prev.length >= 2) return [prev[1], id] // 一次只比較最近選的兩筆
      return [...prev, id]
    })
  }
  async function openMergePreview() {
    if (selectedForMerge.length !== 2) return
    setMergePreviewLoading(true)
    try {
      const res = await api.mergePreview(selectedForMerge[0], selectedForMerge[1])
      setMergePreviewData(res)
      // 預設保留訂單數較多的那筆（比較可能是「主要」那筆客戶資料）
      setMergeKeepId(res.customerA.orderCount >= res.customerB.orderCount ? res.customerA.id : res.customerB.id)
    } catch (e: any) {
      alert(e.message)
    } finally {
      setMergePreviewLoading(false)
    }
  }
  function closeMergePreview() {
    setMergePreviewData(null)
    setMergeKeepId(null)
  }
  async function confirmMerge() {
    if (!mergePreviewData || !mergeKeepId) return
    const other = mergePreviewData.customerA.id === mergeKeepId ? mergePreviewData.customerB.id : mergePreviewData.customerA.id
    setMergeLoading(true)
    try {
      await api.mergeCustomers(mergeKeepId, other)
      closeMergePreview()
      setMergeMode(false)
      setSelectedForMerge([])
      await load()
    } catch (e: any) {
      alert(e.message)
    } finally {
      setMergeLoading(false)
    }
  }

  return (
    <div className="max-w-lg mx-auto p-4 space-y-4">
      {!quickEditOnly && (
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold text-gray-800">👥 客戶管理</h2>
        <div className="flex gap-2">
          <button onClick={toggleMergeMode} className={`px-3 py-2 rounded-xl text-sm font-medium transition ${mergeMode ? 'bg-gray-700 text-white' : 'bg-gray-100 text-gray-600'}`}>
            🔗 {mergeMode ? '取消合併' : '合併客戶'}
          </button>
          <button onClick={openAdd} className="bg-orange-500 text-white px-4 py-2 rounded-xl text-sm font-medium">+ 新增</button>
        </div>
      </div>
      )}

      {!quickEditOnly && mergeMode && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 flex items-center justify-between gap-2">
          <div className="text-sm text-orange-700">
            已選 {selectedForMerge.length}/2 筆{selectedForMerge.length < 2 ? '，點選要合併的兩筆客戶卡片' : '，可以預覽合併了'}
          </div>
          <button
            onClick={openMergePreview}
            disabled={selectedForMerge.length !== 2 || mergePreviewLoading}
            className="flex-shrink-0 bg-orange-500 disabled:bg-gray-300 text-white text-sm font-medium px-4 py-2 rounded-lg transition"
          >
            {mergePreviewLoading ? '載入中...' : '預覽合併 →'}
          </button>
        </div>
      )}

      {!quickEditOnly && (
      <div className="flex gap-2">
        <input
          className="flex-1 border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
          placeholder="搜尋姓名、電話、地址..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && load()}
        />
        <button onClick={load} className="px-4 py-2.5 bg-orange-500 text-white rounded-xl font-medium">搜尋</button>
      </div>
      )}

      {!quickEditOnly && loading && <div className="text-center text-gray-400 py-8">載入中...</div>}

      {!quickEditOnly && !loading && customers.map(c => (
        <div
          key={c.id}
          onClick={() => mergeMode && toggleSelectForMerge(c.id)}
          className={`bg-white border rounded-xl p-4 shadow-sm transition ${mergeMode ? 'cursor-pointer' : ''} ${mergeMode && selectedForMerge.includes(c.id) ? 'border-orange-500 ring-2 ring-orange-200' : 'border-gray-200'}`}
        >
          <div className="flex justify-between items-start">
            <div className="flex-1">
              <div className="font-bold text-gray-800">{c.name}
                {c.status === 'INACTIVE' && <span className="ml-2 text-xs text-gray-400">（停用）</span>}
              </div>
              <div className="text-sm text-gray-600">{c.phone}{c.phone2 ? ` / ${c.phone2}` : ''}</div>
              <div className="text-sm text-gray-500">{c.address}</div>
              <div className="flex gap-2 mt-1 text-xs text-gray-400">
                <span>{GAS_TYPE_LABEL[c.gas_type]}</span>
                {c.customer_type && <span>{CUSTOMER_TYPE_LABEL[c.customer_type]}</span>}
                {c.price_override && <span>特殊單價 ${c.price_override}</span>}
                {c.district && <span>{c.district}</span>}
              </div>
              {(c.delivery_cycle === 'WEEKLY' || c.delivery_cycle === 'MONTHLY_FIXED') && c.delivery_day && (
                <div className="text-xs text-blue-600 mt-1">
                  📅 {DELIVERY_CYCLE_LABEL[c.delivery_cycle]}・
                  {c.delivery_day.split(',').map(d => WEEKDAY_LABEL[Number(d)]).filter(Boolean).join('、')}
                  {c.default_order_quantity ? `・每次${c.default_order_quantity}桶` : ''}
                </div>
              )}
              {Number(c.amount_owed) > 0 && (
                <div className="text-sm text-red-500 mt-1">欠款 ${Number(c.amount_owed).toLocaleString()}</div>
              )}
              {c.note && <div className="text-xs text-orange-600 mt-1">📝 {c.note}</div>}
            </div>
            {mergeMode ? (
              <div className={`ml-2 flex-shrink-0 w-6 h-6 rounded-full border-2 flex items-center justify-center text-xs font-bold transition ${selectedForMerge.includes(c.id) ? 'bg-orange-500 border-orange-500 text-white' : 'border-gray-300 text-transparent'}`}>
                ✓
              </div>
            ) : (
              <div className="flex flex-col gap-1 ml-2 items-end">
                  <button onClick={() => openEdit(c)} className="text-orange-500 text-sm">編輯</button>
                  {c.status === 'ACTIVE' ? (
                    <button onClick={async (e) => { e.stopPropagation(); if(window.confirm('確定停用此客戶？')) { await api.deactivateCustomer(c.id); load() } }} className="text-yellow-500 hover:text-yellow-700 text-xs">停用</button>
                  ) : (
                    <button onClick={async (e) => { e.stopPropagation(); if(window.confirm('確定啟用此客戶？')) { await api.updateCustomer(c.id, { status: 'ACTIVE' }); load() } }} className="text-green-500 hover:text-green-700 text-xs">啟用</button>
                  )}
                  <button onClick={async (e) => { e.stopPropagation(); if(window.confirm('確定刪除此客戶？有訂單記錄的客戶無法刪除。')) { try { await api.hardDeleteCustomer(c.id); load() } catch(err: any) { alert(err.message) } } }} className="text-red-400 hover:text-red-600 text-xs">刪除</button>
                </div>
            )}
          </div>
        </div>
      ))}

      {!quickEditOnly && !loading && customers.length === 0 && (
        <div className="text-center text-gray-400 py-12">找不到客戶</div>
      )}

      {/* 新增/編輯 Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-end z-50" onClick={closeForm}>
          <div className="bg-white w-full max-w-lg mx-auto rounded-t-2xl p-6 space-y-3 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-lg font-bold">{editId ? '編輯客戶' : '新增客戶'}</h3>
              <button onClick={closeForm} className="text-gray-400 text-2xl">×</button>
            </div>

            {[
              { label: '姓名 *', key: 'name', placeholder: '客戶姓名或店名' },
              { label: '電話 *', key: 'phone', placeholder: '0912345678' },
              { label: '電話2', key: 'phone2', placeholder: '備用電話（選填）' },
              { label: '地址 *', key: 'address', placeholder: '完整地址' },
              { label: '區域', key: 'district', placeholder: '例：中西區、東區' },
              { label: '特殊單價', key: 'price_override', placeholder: '留空使用預設價格' },
              { label: '備註', key: 'note', placeholder: '特殊需求、注意事項' },
            ].map(f => (
              <div key={f.key}>
                <label className="block text-sm font-medium text-gray-700 mb-1">{f.label}</label>
                <input
                  className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
                  placeholder={f.placeholder}
                  value={(form as any)[f.key]}
                  onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                />
              </div>
            ))}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">瓦斯類型</label>
              <select
                className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
                value={form.gas_type}
                onChange={e => setForm(prev => ({ ...prev, gas_type: e.target.value }))}
              >
                <option value="BOTTLED_20KG">20kg桶裝</option>
                <option value="BOTTLED_16KG">16kg桶裝</option>
                <option value="BOTTLED_4KG">4kg桶裝</option>
                <option value="PIPED">管道瓦斯</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">客戶類型（用於預測補貨，沒有歷史訂單時的預設值）</label>
              <select
                className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
                value={form.customer_type}
                onChange={e => setForm(prev => ({ ...prev, customer_type: e.target.value }))}
              >
                <option value="UNKNOWN">未分類</option>
                <option value="COMMERCIAL">🏪 營業用</option>
                <option value="RESIDENTIAL">🏠 一般住家</option>
              </select>
            </div>

            <div className="border border-gray-200 rounded-xl p-3">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showFixedDelivery}
                  onChange={e => {
                    const checked = e.target.checked
                    setShowFixedDelivery(checked)
                    // 下拉選單只有「每週固定」「每月固定」兩個選項，沒有 ON_CALL；
                    // 勾選當下如果 delivery_cycle 還是 ON_CALL，瀏覽器畫面會誤顯示成第一個選項「每週固定」，
                    // 但實際存的值仍是 ON_CALL，導致存檔時沒真的切換成固定配送。這裡把值同步成畫面看到的樣子。
                    if (checked && form.delivery_cycle !== 'WEEKLY' && form.delivery_cycle !== 'MONTHLY_FIXED') {
                      setForm(prev => ({ ...prev, delivery_cycle: 'WEEKLY' }))
                    }
                  }}
                  className="w-4 h-4 accent-orange-500"
                />
                <span className="text-sm font-medium text-gray-700">📅 固定配送客戶（自動排程建單）</span>
              </label>

              {showFixedDelivery && (
                <div className="mt-3 space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">配送頻率</label>
                    <select
                      className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
                      value={form.delivery_cycle}
                      onChange={e => setForm(prev => ({ ...prev, delivery_cycle: e.target.value }))}
                    >
                      <option value="WEEKLY">每週固定</option>
                      <option value="MONTHLY_FIXED">每月固定（當月第一次出現該星期）</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">配送星期 *（可複選）</label>
                    <div className="grid grid-cols-7 gap-1">
                      {Object.entries(WEEKDAY_LABEL).map(([num, label]) => {
                        const day = Number(num)
                        const active = deliveryDays.includes(day)
                        return (
                          <button
                            key={num}
                            type="button"
                            onClick={() => toggleDeliveryDay(day)}
                            className={`py-2 rounded-lg text-sm font-medium transition ${active ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-600'}`}
                          >
                            {label.replace('週', '')}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">配送品項 *（可加多種瓦斯類型，例如 20kg 兩桶＋16kg 一桶）</label>
                    <div className="space-y-2">
                      {fixedItems.map((item, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <select
                            className="flex-1 border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                            value={item.gasType}
                            onChange={e => updateFixedItem(idx, 'gasType', e.target.value)}
                          >
                            {GAS_TYPE_OPTIONS.map(g => (
                              <option key={g} value={g}>{GAS_TYPE_LABEL[g] || g}</option>
                            ))}
                          </select>
                          <input
                            type="number"
                            min="1"
                            placeholder="桶數"
                            className="w-20 border border-gray-300 rounded-xl px-3 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-orange-400"
                            value={item.quantity}
                            onChange={e => updateFixedItem(idx, 'quantity', e.target.value)}
                          />
                          {fixedItems.length > 1 && (
                            <button type="button" onClick={() => removeFixedItem(idx)} className="text-red-400 text-lg font-bold px-1">×</button>
                          )}
                        </div>
                      ))}
                    </div>
                    <button type="button" onClick={addFixedItem} className="mt-2 w-full border-2 border-dashed border-gray-300 text-gray-500 rounded-xl py-1.5 text-sm font-medium">
                      + 新增品項
                    </button>
                  </div>
                  <p className="text-xs text-gray-400">系統每天會自動檢查，到了配送日會自動建立草稿訂單（待出貨），出貨前仍可調整數量。每個品項的單價會優先用客戶的特殊單價，沒設定就用該類型目前的基準價。</p>
                </div>
              )}
            </div>

            <button
              onClick={handleSave}
              disabled={saving || !form.name || !form.phone || !form.address}
              className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 text-white font-bold py-3 rounded-xl text-base transition mt-2"
            >
              {saving ? '儲存中...' : '✅ 儲存'}
            </button>
          </div>
        </div>
      )}

      {/* 合併客戶：預覽並選擇要保留哪一筆 */}
      {mergePreviewData && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={closeMergePreview}>
          <div className="bg-white w-full max-w-md rounded-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-bold">確認合併客戶</h3>
              <button onClick={closeMergePreview} className="text-gray-400 text-2xl">×</button>
            </div>
            <p className="text-sm text-gray-500">
              選擇要保留的那一筆。另一筆的訂單、欠款、退桶記錄會全部併入保留的客戶，並標記停用（不會刪除，之後仍可查證）。
            </p>

            {[mergePreviewData.customerA, mergePreviewData.customerB].map((c: any) => (
              <button
                key={c.id}
                onClick={() => setMergeKeepId(c.id)}
                className={`w-full text-left border-2 rounded-xl p-3 space-y-1 transition ${mergeKeepId === c.id ? 'border-orange-500 bg-orange-50' : 'border-gray-200'}`}
              >
                <div className="flex justify-between items-center">
                  <div className="font-bold text-gray-800">{c.name}</div>
                  {mergeKeepId === c.id && <span className="text-xs bg-orange-500 text-white px-2 py-0.5 rounded-full flex-shrink-0">保留這筆</span>}
                </div>
                <div className="text-sm text-gray-600">{c.phone}{c.phone2 ? ` / ${c.phone2}` : ''}</div>
                <div className="text-sm text-gray-500">{c.address}</div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-400 pt-1">
                  <span>{c.orderCount} 筆訂單</span>
                  <span>{c.returnCount} 筆退桶</span>
                  {Number(c.amount_owed) > 0 && <span className="text-red-400">欠款 ${Number(c.amount_owed).toLocaleString()}</span>}
                  {Number(c.cylinders_owed) > 0 && <span className="text-red-400">欠桶 {c.cylinders_owed}</span>}
                  {c.lineBound && <span className="text-green-500">已綁 LINE</span>}
                </div>
                {c.recentOrders?.length > 0 && (
                  <div className="text-xs text-gray-400 pt-1 border-t border-gray-100 mt-1">
                    最近訂單：{c.recentOrders.map((o: any) => new Date(o.created_at).toLocaleDateString('zh-TW')).join('、')}
                  </div>
                )}
                {c.note && <div className="text-xs text-orange-600">📝 {c.note}</div>}
              </button>
            ))}

            <button
              onClick={confirmMerge}
              disabled={mergeLoading || !mergeKeepId}
              className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 text-white font-bold py-3 rounded-xl text-base transition"
            >
              {mergeLoading ? '合併中...' : '✅ 確認合併'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
