import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api'
import { showToast } from '../lib/toast'

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

type Item = {
  gas_type: string
  quantity: number
  unit_price: number
}

const GAS_OPTIONS = [
  { type: 'BOTTLED_20KG', label: '20kg', defaultPrice: 800 },
  { type: 'BOTTLED_16KG', label: '16kg', defaultPrice: 650 },
  { type: 'BOTTLED_10KG', label: '10kg', defaultPrice: 450 },
  { type: 'BOTTLED_4KG',  label: '4kg',  defaultPrice: 200 },
]

const GAS_LABELS: Record<string, string> = {
  BOTTLED_20KG: '20kg 桶',
  BOTTLED_16KG: '16kg 桶',
  BOTTLED_10KG: '10kg 桶',
  BOTTLED_4KG: '4kg 桶',
}

// 品項預設價的 fallback（僅在還沒抓到後端基準價之前使用）
const FALLBACK_PRICE: Record<string, number> = {
  BOTTLED_20KG: 800,
  BOTTLED_16KG: 650,
  BOTTLED_10KG: 450,
  BOTTLED_4KG: 200,
}

export default function NewOrder({ onOrderCreated }: { onOrderCreated?: () => void }) {
  // 全站基準價（可在「🔧 基準價設定」調整），未設定特殊單價的客戶都以此為準
  const [baselinePrices, setBaselinePrices] = useState<Record<string, number>>(FALLBACK_PRICE)
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<Customer[]>([])
  const [selected, setSelected] = useState<Customer | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [newAddress, setNewAddress] = useState('')
  const [newCustomerType, setNewCustomerType] = useState('')
  const [items, setItems] = useState<Item[]>([
    { gas_type: 'BOTTLED_20KG', quantity: 1, unit_price: FALLBACK_PRICE.BOTTLED_20KG }
  ])
  const [lastOrderHint, setLastOrderHint] = useState<string>('')
  const [pendingReturns, setPendingReturns] = useState<any[]>([])
  const [stairFee, setStairFee] = useState(0)
  const [paymentType, setPaymentType] = useState<'CASH' | 'AR'>('CASH')
  const [scheduledDate, setScheduledDate] = useState('')
  const [rememberPrice, setRememberPrice] = useState(false)
  const [callTime, setCallTime] = useState('')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    api.getBaselinePrices()
      .then(res => {
        const raw: Record<string, number> = res.prices || {}
        // 只用有效（> 0）的數字覆蓋 fallback，避免資料庫尚未設定時把預設價蓋成 0
        const valid: Record<string, number> = {}
        for (const key of Object.keys(raw)) {
          const v = Number(raw[key])
          if (v > 0) valid[key] = v
        }
        setBaselinePrices(prev => ({ ...prev, ...valid }))
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    // 只要還沒選到「某位已存在客戶的既定資料」，品項單價都要持續跟著最新基準價走——
    // 包含「新客人」這個狀態在內：如果基準價 API 剛好比使用者點「新客人」還晚回來，
    // 沒有這個同步就會讓新客人的單永遠卡在寫死的 fallback 800，追不上真正的基準價
    if (!selected) {
      setItems(prev => prev.map(item => ({ ...item, unit_price: baselinePrices[item.gas_type] ?? item.unit_price })))
    }
  }, [baselinePrices])

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

  async function selectCustomer(c: Customer) {
    setSelected(c)
    setIsNew(false)
    setSearch(c.name)
    setResults([])
    setRememberPrice(false)
    if (Number(c.amount_owed) > 0) setPaymentType('AR')
    else setPaymentType('CASH')

    // 查待處理存氣
    try {
      const pr = await api.getPendingReturns(c.id)
      setPendingReturns(pr.returns || [])
    } catch { setPendingReturns([]) }

    // 帶出上一單的品項/數量習慣（只認真的送達過的單，避免把取消/還沒處理完的單當成參考）
    // 價格一律用客戶「目前」該有的正確單價：有設定特殊單價就用特殊單價，否則用目前的基準價；
    // 不會用上一單當時成交的歷史單價，避免帶出過期價格。
    try {
      const res = await api.getOrders({ customerId: c.id, status: 'DELIVERED', limit: 1 })
      const last = res.orders?.[0]
      if (last && last.items && last.items.length > 0) {
        setItems(last.items.map((i: any) => ({
          gas_type: i.gas_type,
          quantity: i.quantity,
          unit_price: c.price_override || baselinePrices[i.gas_type] || i.unit_price,
        })))
        const hint = last.items.map((i: any) => `${GAS_LABELS[i.gas_type]} × ${i.quantity}`).join('、')
        setLastOrderHint(`上次：${hint}，共 $${Number(last.total_amount).toLocaleString()}`)
      } else {
        setItems([{ gas_type: c.gas_type || 'BOTTLED_20KG', quantity: 1, unit_price: c.price_override || baselinePrices[c.gas_type] || baselinePrices.BOTTLED_20KG }])
        setLastOrderHint('')
      }
    } catch {
      setItems([{ gas_type: 'BOTTLED_20KG', quantity: 1, unit_price: c.price_override || baselinePrices.BOTTLED_20KG }])
      setLastOrderHint('')
    }
  }

  function selectNew() {
    setSelected(null)
    setIsNew(true)
    setNewName(search)
    setResults([])
    setLastOrderHint('')
    setPendingReturns([])
  }

  function addItem() {
    setItems(prev => [...prev, { gas_type: 'BOTTLED_20KG', quantity: 1, unit_price: baselinePrices.BOTTLED_20KG }])
  }

  function removeItem(idx: number) {
    setItems(prev => prev.filter((_, i) => i !== idx))
  }

  function updateItem(idx: number, field: keyof Item, value: string | number) {
    setItems(prev => prev.map((item, i) => {
      if (i !== idx) return item
      const updated = { ...item, [field]: value }
      if (field === 'gas_type') {
        updated.unit_price = baselinePrices[value as string] || FALLBACK_PRICE[value as string] || 800
      }
      return updated
    }))
  }

  function reset() {
    setSelected(null)
    setIsNew(false)
    setSearch('')
    setNewName('')
    setNewPhone('')
    setNewAddress('')
    setNewCustomerType('')
    setItems([{ gas_type: 'BOTTLED_20KG', quantity: 1, unit_price: baselinePrices.BOTTLED_20KG }])
    setStairFee(0)
    setPaymentType('CASH')
    setNote('')
    setError('')
    setLastOrderHint('')
    setPendingReturns([])
    setScheduledDate('')
    setRememberPrice(false)
  }

  // deferred=true 對應「稍後建單」：不等 API 回應完成，立刻清空表單、回到訂單列表，
  // 讓建單請求在背景跑完，成功/失敗都改用全域 toast 通知——因為使用者這時多半已經
  // 切到別的分頁在看訂單列表了，這個頁面自己的 success/error local state 不會被看到
  async function performSubmit(deferred: boolean) {
    setError('')

    if (isNew) {
      if (!newName || !newPhone || !newAddress) {
        setError('請填寫新客戶的姓名、電話和地址')
        return
      }
      if (!newCustomerType) {
        setError('請選擇客戶類型（營業用／一般住家），這會影響之後的預測補貨提醒')
        return
      }
    } else if (!selected) {
      setError('請選擇客戶或填寫新客戶資料')
      return
    }

    // 先把這次送出當下的表單內容存成快照——deferred 模式會在 API 回應前就呼叫 reset()，
    // 之後背景執行的 doCreate() 不能再去讀當下（可能已經被清空/被下一筆訂單覆蓋）的 state
    const snapshot = {
      isNew, newName, newPhone, newAddress, newCustomerType,
      selectedId: selected?.id, selectedName: selected?.name,
      items: items.map(i => ({ ...i })), stairFee, paymentType, scheduledDate, callTime,
      note, rememberPrice,
    }
    const totalNote = [snapshot.note, snapshot.stairFee > 0 ? `樓梯費$${snapshot.stairFee}` : ''].filter(Boolean).join('、')
    const totalQty = snapshot.items.reduce((s, i) => s + i.quantity, 0)
    const name = snapshot.isNew ? snapshot.newName : snapshot.selectedName!

    async function doCreate() {
      let customerId: number
      if (snapshot.isNew) {
        const res = await api.createCustomer({
          name: snapshot.newName, phone: snapshot.newPhone, address: snapshot.newAddress, gasType: 'BOTTLED_20KG',
          customerType: snapshot.newCustomerType,
        })
        customerId = res.id
      } else {
        customerId = snapshot.selectedId!
      }
      await api.createOrder({ customerId, items: snapshot.items, stairFee: snapshot.stairFee, paymentType: snapshot.paymentType, note: totalNote, scheduledDate: snapshot.scheduledDate, callTime: snapshot.callTime })

      // 「記住這個價格」：只在單一規格時才會出現這個選項（避免多規格客戶被單一數字誤蓋掉），
      // 勾選的話，建單同時把這次的單價存成客戶的特殊單價，之後就會自動帶入，不用再跑一趟客戶頁面改
      if (snapshot.rememberPrice && snapshot.items.length === 1) {
        try { await api.updateCustomer(customerId, { price_override: snapshot.items[0].unit_price }) } catch { /* 訂單已經建立成功，這步失敗就算了，不影響本次接單 */ }
      }
    }

    if (deferred) {
      reset()
      onOrderCreated?.()
      doCreate()
        .then(() => {
          showToast(`✅ 已建單：${name} × ${totalQty} 桶`, 'success')
          window.dispatchEvent(new Event('order-refresh'))
        })
        .catch((e: any) => {
          showToast(`❌ 建單失敗（${name}）：${e.message || '請重新確認後手動補建'}`, 'error')
        })
      return
    }

    setLoading(true)
    try {
      await doCreate()
      setSuccess(`✅ 已建單：${name} × ${totalQty} 桶`)
      onOrderCreated?.()
      reset()
      setTimeout(() => setSuccess(''), 3000)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = () => performSubmit(false)
  const handleDeferredSubmit = () => performSubmit(true)

  const gasTotal = items.reduce((s, i) => s + i.quantity * i.unit_price, 0)
  const total = gasTotal + stairFee

  return (
    <div className="max-w-lg mx-auto p-4 space-y-4">
      <h2 className="text-xl font-bold text-gray-800">📋 快速接單</h2>

      {success && <div className="bg-green-50 border border-green-200 text-green-700 rounded-xl p-3 text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 border border-red-200 text-red-600 rounded-xl p-3 text-sm">{error}</div>}

      {/* 客戶搜尋 */}
      <div className="relative">
        <label className="block text-sm font-medium text-gray-700 mb-1">客戶（姓名或電話）</label>
        <input
          className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
          placeholder="輸入姓名或電話搜尋..."
          value={search}
          onChange={e => { setSearch(e.target.value); setSelected(null); setIsNew(false); setLastOrderHint('') }}
        />
        {(results.length > 0 || (search.length > 0 && !selected && !isNew)) && (
          <div className="absolute z-10 w-full bg-white border border-gray-200 rounded-xl shadow-lg mt-1 max-h-60 overflow-y-auto">
            {results.map(c => (
              <div key={c.id} className="px-4 py-3 hover:bg-orange-50 cursor-pointer border-b" onClick={() => selectCustomer(c)}>
                <div className="font-medium text-gray-800">{c.name}</div>
                <div className="text-sm text-gray-500">{c.phone}　{c.address}</div>
                {Number(c.amount_owed) > 0 && <div className="text-xs text-red-500 mt-0.5">欠款 ${Number(c.amount_owed).toLocaleString()}</div>}
              </div>
            ))}
            {search.length > 0 && (
              <div className="px-4 py-3 hover:bg-blue-50 cursor-pointer text-blue-600 font-medium flex items-center gap-2" onClick={selectNew}>
                <span>➕</span> 新客人「{search}」
              </div>
            )}
          </div>
        )}
      </div>

      {/* 選中客戶 */}
      {selected && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 flex justify-between items-start">
          <div>
            <div className="font-medium text-gray-800">{selected.name}</div>
            <div className="text-sm text-gray-600">{selected.phone}　{selected.address}</div>
            {Number(selected.amount_owed) > 0 && <div className="text-sm text-red-500 mt-1">⚠️ 目前欠款 ${Number(selected.amount_owed).toLocaleString()}</div>}
            {lastOrderHint && <div className="text-xs text-orange-600 mt-1">🕐 {lastOrderHint}</div>}
          </div>
          <button onClick={reset} className="text-gray-400 text-xl">×</button>
        </div>
      )}

      {/* 新客人資料 */}
      {isNew && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-sm font-medium text-blue-700">新客人資料</span>
            <button onClick={reset} className="text-gray-400 text-xl">×</button>
          </div>
          <input className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-blue-400" placeholder="姓名 *" value={newName} onChange={e => setNewName(e.target.value)} />
          <input className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-blue-400" placeholder="電話 *" value={newPhone} onChange={e => setNewPhone(e.target.value)} />
          <input className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-blue-400" placeholder="地址 *" value={newAddress} onChange={e => setNewAddress(e.target.value)} />
          <select
            className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-blue-400"
            value={newCustomerType}
            onChange={e => setNewCustomerType(e.target.value)}
          >
            <option value="">客戶類型 *（會影響之後的預測補貨提醒）</option>
            <option value="COMMERCIAL">🏪 營業用</option>
            <option value="RESIDENTIAL">🏠 一般住家</option>
          </select>
        </div>
      )}

      {/* 品項 */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">品項</label>
        <div className="space-y-3">
          {items.map((item, idx) => (
            <div key={idx} className="bg-gray-50 rounded-xl p-3 space-y-3">
              {/* 規格快選 */}
              <div className="flex justify-between items-center">
                <div className="flex gap-2 flex-wrap">
                  {GAS_OPTIONS.map(opt => (
                    <button
                      key={opt.type}
                      onClick={() => updateItem(idx, 'gas_type', opt.type)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${item.gas_type === opt.type ? 'bg-orange-500 text-white' : 'bg-white border border-gray-300 text-gray-600 hover:border-orange-400'}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {items.length > 1 && (
                  <button onClick={() => removeItem(idx)} className="text-red-400 hover:text-red-600 text-lg font-bold ml-2">×</button>
                )}
              </div>

              {/* 桶數 + 單價 */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <button onClick={() => updateItem(idx, 'quantity', Math.max(1, item.quantity - 1))} className="w-9 h-9 rounded-full bg-gray-200 hover:bg-gray-300 text-lg font-bold transition">−</button>
                  <span className="text-xl font-bold text-gray-800 w-8 text-center">{item.quantity}</span>
                  <button onClick={() => updateItem(idx, 'quantity', item.quantity + 1)} className="w-9 h-9 rounded-full bg-orange-500 hover:bg-orange-600 text-white text-lg font-bold transition">+</button>
                </div>
                <span className="text-gray-400 text-sm">×</span>
                {/* 單價快選 */}
                <div className="flex-1">
                  <div className="flex gap-1.5 flex-wrap mb-1.5">
                    {[item.unit_price - 50, item.unit_price, item.unit_price + 50].map(p => (
                      <button key={p} onClick={() => updateItem(idx, 'unit_price', p)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition ${item.unit_price === p ? 'bg-gray-700 text-white' : 'bg-white border border-gray-200 text-gray-500 hover:border-gray-400'}`}>
                        ${p}
                      </button>
                    ))}
                  </div>
                  <input
                    type="number"
                    className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
                    value={item.unit_price}
                    onChange={e => updateItem(idx, 'unit_price', Number(e.target.value))}
                  />
                </div>
                <div className="text-base font-bold text-orange-600 w-20 text-right">${(item.quantity * item.unit_price).toLocaleString()}</div>
              </div>
            </div>
          ))}
        </div>
        <button onClick={addItem} className="mt-2 w-full border-2 border-dashed border-gray-300 hover:border-orange-400 text-gray-500 hover:text-orange-500 rounded-xl py-2.5 text-sm font-medium transition">
          + 新增品項
        </button>
      </div>

      {!isNew && selected && items.length === 1 && (
        <label className="flex items-center gap-2 text-sm text-gray-600 -mt-2">
          <input
            type="checkbox"
            className="w-4 h-4 accent-orange-500"
            checked={rememberPrice}
            onChange={e => setRememberPrice(e.target.checked)}
          />
          🔒 記住這個單價（存成 {selected.name} 的特殊單價，以後自動帶入）
        </label>
      )}

      {/* 樓梯費 */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-gray-700 whitespace-nowrap">樓梯費</label>
        <input type="number" className="flex-1 border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-orange-400" value={stairFee || ''} placeholder="0" onChange={e => setStairFee(Number(e.target.value) || 0)} />
        <span className="text-sm text-gray-500">元</span>
      </div>

      {/* 付款方式 */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">付款方式</label>
        <div className="flex gap-3">
          <button onClick={() => setPaymentType('CASH')} className={`flex-1 py-3 rounded-xl font-medium transition ${paymentType === 'CASH' ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-600'}`}>💵 現金</button>
          <button onClick={() => setPaymentType('AR')} className={`flex-1 py-3 rounded-xl font-medium transition ${paymentType === 'AR' ? 'bg-red-500 text-white' : 'bg-gray-100 text-gray-600'}`}>📒 欠帳</button>
        </div>
      </div>

      {/* 配送日期（留空＝今天；選未來日期＝排定；選過去日期＝補登漏單） */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">配送日期（選填，留空＝今天）</label>
        <input
          type="date"
          className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
          value={scheduledDate}
          onChange={e => setScheduledDate(e.target.value)}
        />
        {scheduledDate && scheduledDate > new Date().toLocaleDateString('en-CA') && (
          <div className="text-orange-500 text-xs mt-1.5">⚠️ 此單將排定於 {scheduledDate}，在那天之前不會出現在待派送佇列</div>
        )}
        {scheduledDate && scheduledDate < new Date().toLocaleDateString('en-CA') && (
          <div className="text-blue-500 text-xs mt-1.5">📅 補登單，會立即出現在待送清單，報表歸入 {scheduledDate}</div>
        )}
      </div>

      {/* 來電時間（留空＝現在，補紙本單/事後轉述時可以手動調整成實際來電時間） */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">來電時間（選填，留空＝現在）</label>
        <input
          type="datetime-local"
          className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
          value={callTime}
          onChange={e => setCallTime(e.target.value)}
        />
        {callTime && (
          <div className="text-gray-400 text-xs mt-1.5">補紙本單或事後轉述時，可以調整成客人實際來電的時間</div>
        )}
      </div>

      {/* 待處理存氣提醒 */}
      {pendingReturns.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-300 rounded-xl p-3 space-y-1">
          <div className="text-sm font-medium text-yellow-700">⚠️ 有待處理存氣</div>
          {pendingReturns.map((r: any) => (
            <div key={r.id} className="flex justify-between items-center text-sm">
              <span className="text-yellow-700">剩餘 {r.remaining_kg} kg · {r.action === 'REFUND' ? '待退費' : '待抵扣'} ${Number(r.amount).toLocaleString()}</span>
              <button onClick={async () => { await api.resolveReturn(r.id); setPendingReturns(prev => prev.filter(x => x.id !== r.id)) }} className="text-xs text-yellow-600 underline">標記完成</button>
            </div>
          ))}
        </div>
      )}

      {/* 備註 */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">備註（選填）</label>
        <input className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-orange-400" placeholder="不急、指定時間..." value={note} onChange={e => setNote(e.target.value)} />
      </div>

      {/* 合計 */}
      <div className="bg-gray-50 rounded-xl p-4 space-y-1">
        {items.map((item, idx) => (
          <div key={idx} className="flex justify-between text-sm text-gray-500">
            <span>{GAS_LABELS[item.gas_type]} × {item.quantity}</span>
            <span>${(item.quantity * item.unit_price).toLocaleString()}</span>
          </div>
        ))}
        {stairFee > 0 && <div className="flex justify-between text-sm text-gray-500"><span>樓梯費</span><span>${stairFee.toLocaleString()}</span></div>}
        <div className="flex justify-between items-center pt-2 border-t border-gray-200">
          <span className="text-gray-600 font-medium">合計金額</span>
          <span className="text-2xl font-bold text-orange-600">${total.toLocaleString()}</span>
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={handleSubmit} disabled={loading || (!selected && !isNew)} className="flex-1 bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 text-white font-bold py-4 rounded-xl text-lg transition">
          {loading ? '建單中...' : '✅ 建立訂單'}
        </button>
        <button
          onClick={handleDeferredSubmit}
          disabled={loading || (!selected && !isNew)}
          title="不用等回應，立刻回到訂單列表，建單在背景處理"
          className="px-4 bg-gray-100 hover:bg-gray-200 disabled:bg-gray-100 disabled:text-gray-300 text-gray-600 font-medium py-4 rounded-xl text-sm transition whitespace-nowrap"
        >
          📤 稍後建單
        </button>
      </div>
    </div>
  )
}
