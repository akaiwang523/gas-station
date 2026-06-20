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
  price_override: number | null
  note: string | null
  status: string
  amount_owed: number
  cylinders_owed: number
  last_delivery: string | null
  delivery_cycle: string | null
  delivery_day: number | null
  default_order_quantity: number | null
  default_unit_price: number | null
}

const GAS_TYPE_LABEL: Record<string, string> = {
  BOTTLED_20KG: '20kg桶裝',
  BOTTLED_16KG: '16kg桶裝',
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

export default function CustomerPage() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [form, setForm] = useState({
    name: '', phone: '', phone2: '', address: '', district: '',
    gas_type: 'BOTTLED_20KG', price_override: '', note: '',
    delivery_cycle: 'ON_CALL', delivery_day: '', default_order_quantity: '', default_unit_price: ''
  })
  const [showFixedDelivery, setShowFixedDelivery] = useState(false)
  const [saving, setSaving] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = await api.searchCustomers(search)
      setCustomers(res.customers)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  function openAdd() {
    setForm({
      name: '', phone: '', phone2: '', address: '', district: '',
      gas_type: 'BOTTLED_20KG', price_override: '', note: '',
      delivery_cycle: 'ON_CALL', delivery_day: '', default_order_quantity: '', default_unit_price: ''
    })
    setShowFixedDelivery(false)
    setEditId(null)
    setShowForm(true)
  }

  function openEdit(c: Customer) {
    setForm({
      name: c.name, phone: c.phone, phone2: c.phone2 || '',
      address: c.address, district: c.district || '',
      gas_type: c.gas_type, price_override: c.price_override ? String(c.price_override) : '',
      note: c.note || '',
      delivery_cycle: c.delivery_cycle || 'ON_CALL',
      delivery_day: c.delivery_day ? String(c.delivery_day) : '',
      default_order_quantity: c.default_order_quantity ? String(c.default_order_quantity) : '',
      default_unit_price: c.default_unit_price ? String(c.default_unit_price) : '',
    })
    setShowFixedDelivery(c.delivery_cycle === 'WEEKLY' || c.delivery_cycle === 'MONTHLY_FIXED')
    setEditId(c.id)
    setShowForm(true)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const data: any = {
        ...form,
        priceOverride: form.price_override ? Number(form.price_override) : null,
        gasType: form.gas_type,
      }
      if (showFixedDelivery) {
        if (!form.delivery_day || !form.default_order_quantity || !form.default_unit_price) {
          alert('啟用固定配送時，配送日、數量、單價皆為必填')
          setSaving(false)
          return
        }
        data.delivery_cycle = form.delivery_cycle
        data.delivery_day = Number(form.delivery_day)
        data.default_order_quantity = Number(form.default_order_quantity)
        data.default_unit_price = Number(form.default_unit_price)
      } else {
        // 沒有啟用固定配送，強制清空相關欄位，避免殘留舊設定被排程誤判
        data.delivery_cycle = 'ON_CALL'
        data.delivery_day = null
        data.default_order_quantity = null
        data.default_unit_price = null
      }
      if (editId) {
        await api.updateCustomer(editId, data)
      } else {
        await api.createCustomer(data)
      }
      setShowForm(false)
      await load()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-lg mx-auto p-4 space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold text-gray-800">👥 客戶管理</h2>
        <button onClick={openAdd} className="bg-orange-500 text-white px-4 py-2 rounded-xl text-sm font-medium">+ 新增</button>
      </div>

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

      {loading && <div className="text-center text-gray-400 py-8">載入中...</div>}

      {!loading && customers.map(c => (
        <div key={c.id} className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
          <div className="flex justify-between items-start">
            <div className="flex-1">
              <div className="font-bold text-gray-800">{c.name}
                {c.status === 'INACTIVE' && <span className="ml-2 text-xs text-gray-400">（停用）</span>}
              </div>
              <div className="text-sm text-gray-600">{c.phone}{c.phone2 ? ` / ${c.phone2}` : ''}</div>
              <div className="text-sm text-gray-500">{c.address}</div>
              <div className="flex gap-2 mt-1 text-xs text-gray-400">
                <span>{GAS_TYPE_LABEL[c.gas_type]}</span>
                {c.price_override && <span>特殊單價 ${c.price_override}</span>}
                {c.district && <span>{c.district}</span>}
              </div>
              {(c.delivery_cycle === 'WEEKLY' || c.delivery_cycle === 'MONTHLY_FIXED') && c.delivery_day && (
                <div className="text-xs text-blue-600 mt-1">
                  📅 {DELIVERY_CYCLE_LABEL[c.delivery_cycle]}・{WEEKDAY_LABEL[c.delivery_day]}
                  {c.default_order_quantity ? `・每次${c.default_order_quantity}桶` : ''}
                </div>
              )}
              {Number(c.amount_owed) > 0 && (
                <div className="text-sm text-red-500 mt-1">欠款 ${Number(c.amount_owed).toLocaleString()}</div>
              )}
              {c.note && <div className="text-xs text-orange-600 mt-1">📝 {c.note}</div>}
            </div>
            <div className="flex flex-col gap-1 ml-2 items-end">
                <button onClick={() => openEdit(c)} className="text-orange-500 text-sm">編輯</button>
                {c.status === 'ACTIVE' ? (
                  <button onClick={async (e) => { e.stopPropagation(); if(window.confirm('確定停用此客戶？')) { await api.deactivateCustomer(c.id); load() } }} className="text-yellow-500 hover:text-yellow-700 text-xs">停用</button>
                ) : (
                  <button onClick={async (e) => { e.stopPropagation(); if(window.confirm('確定啟用此客戶？')) { await api.updateCustomer(c.id, { status: 'ACTIVE' }); load() } }} className="text-green-500 hover:text-green-700 text-xs">啟用</button>
                )}
                <button onClick={async (e) => { e.stopPropagation(); if(window.confirm('確定刪除此客戶？有訂單記錄的客戶無法刪除。')) { try { await api.hardDeleteCustomer(c.id); load() } catch(err: any) { alert(err.message) } } }} className="text-red-400 hover:text-red-600 text-xs">刪除</button>
              </div>
          </div>
        </div>
      ))}

      {!loading && customers.length === 0 && (
        <div className="text-center text-gray-400 py-12">找不到客戶</div>
      )}

      {/* 新增/編輯 Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-end z-50" onClick={() => setShowForm(false)}>
          <div className="bg-white w-full max-w-lg mx-auto rounded-t-2xl p-6 space-y-3 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-lg font-bold">{editId ? '編輯客戶' : '新增客戶'}</h3>
              <button onClick={() => setShowForm(false)} className="text-gray-400 text-2xl">×</button>
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

            <div className="border border-gray-200 rounded-xl p-3">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showFixedDelivery}
                  onChange={e => setShowFixedDelivery(e.target.checked)}
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
                    <label className="block text-sm font-medium text-gray-700 mb-1">配送星期 *</label>
                    <select
                      className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
                      value={form.delivery_day}
                      onChange={e => setForm(prev => ({ ...prev, delivery_day: e.target.value }))}
                    >
                      <option value="">請選擇</option>
                      {Object.entries(WEEKDAY_LABEL).map(([num, label]) => (
                        <option key={num} value={num}>{label}</option>
                      ))}
                    </select>
                  </div>

                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="block text-sm font-medium text-gray-700 mb-1">每次配送桶數 *</label>
                      <input
                        type="number"
                        min="1"
                        className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
                        placeholder="例：2"
                        value={form.default_order_quantity}
                        onChange={e => setForm(prev => ({ ...prev, default_order_quantity: e.target.value }))}
                      />
                    </div>
                    <div className="flex-1">
                      <label className="block text-sm font-medium text-gray-700 mb-1">每桶單價 *</label>
                      <input
                        type="number"
                        min="0"
                        className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
                        placeholder="例：850"
                        value={form.default_unit_price}
                        onChange={e => setForm(prev => ({ ...prev, default_unit_price: e.target.value }))}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-gray-400">系統每天會自動檢查，到了配送日會自動建立草稿訂單（待出貨），出貨前仍可調整數量。</p>
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
    </div>
  )
}
