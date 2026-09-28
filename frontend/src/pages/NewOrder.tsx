import { useState, useEffect, useRef, type ReactNode } from 'react'
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
  // 全站基準價（可在「基準價設定」調整），未設定特殊單價的客戶都以此為準
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
  const [rememberPriceIndex, setRememberPriceIndex] = useState(0)
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
    setRememberPriceIndex(0)
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
    setRememberPriceIndex(0)
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
      note, rememberPrice, rememberPriceIndex,
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

      // 「記住這個價格」：勾選的話，建單同時把單價存成客戶的特殊單價，之後就會自動帶入，不用再跑一趟客戶頁面改。
      // 品項單價都一樣時直接存那個數字；品項單價不一樣時，用使用者在下拉選單選的那個品項的單價
      if (snapshot.rememberPrice) {
        const uniquePrices = new Set(snapshot.items.map(i => i.unit_price))
        const chosen = uniquePrices.size === 1
          ? snapshot.items[0]
          : (snapshot.items[snapshot.rememberPriceIndex] || snapshot.items[0])
        if (chosen) {
          try { await api.updateCustomer(customerId, { price_override: chosen.unit_price }) } catch { /* 訂單已經建立成功，這步失敗就算了，不影響本次接單 */ }
        }
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

  const hasInput = !!(selected || isNew || search || stairFee || note || scheduledDate || callTime)
  const today = new Date().toLocaleDateString('en-CA')
  const moreSet = [scheduledDate && `配送 ${scheduledDate}`, callTime && '已設來電時間'].filter(Boolean).join('・')

  return (
    <div className="max-w-3xl mx-auto px-4 pt-3 pb-44 space-y-3 text-slate-800">
      {/* 頁首 */}
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-xl font-bold text-slate-800">
          <IconClipboard className="w-5 h-5 text-slate-500" />
          快速接單
        </h2>
        {hasInput && (
          <button onClick={reset} className="text-sm text-slate-500 hover:text-slate-800 px-2 py-1 -mr-2">清除</button>
        )}
      </div>

      {success && <div className="bg-green-50 border border-green-200 text-green-700 rounded-xl px-4 py-3 text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 border border-red-200 text-red-600 rounded-xl px-4 py-3 text-sm">{error}</div>}

      {/* 客戶 */}
      <section className={CARD}>
        <div className={LABEL}>客戶</div>
        {!selected && !isNew ? (
          <div className="relative">
            <IconSearch className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400 pointer-events-none" />
            <input
              className="w-full h-12 border border-slate-300 rounded-xl pl-11 pr-4 text-base focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-orange-400"
              placeholder="搜尋姓名或電話"
              value={search}
              onChange={e => { setSearch(e.target.value); setSelected(null); setIsNew(false); setLastOrderHint('') }}
            />
            {search.length > 0 && (
              <div className="absolute z-20 w-full bg-white border border-slate-200 rounded-xl shadow-lg mt-1 max-h-72 overflow-y-auto">
                {results.map(c => (
                  <div key={c.id} className="px-4 py-3 hover:bg-orange-50 active:bg-orange-50 cursor-pointer border-b border-slate-100" onClick={() => selectCustomer(c)}>
                    <div className="font-medium">{c.name}</div>
                    <div className="text-sm text-slate-500">{c.phone}　{c.address}</div>
                    {Number(c.amount_owed) > 0 && <div className="text-xs text-red-500 mt-0.5">欠款 ${Number(c.amount_owed).toLocaleString()}</div>}
                  </div>
                ))}
                <div className="px-4 py-3 hover:bg-slate-50 cursor-pointer text-slate-700 font-medium flex items-center gap-2" onClick={selectNew}>
                  <IconPlus className="w-4 h-4" /> 新客人「{search}」
                </div>
              </div>
            )}
          </div>
        ) : selected ? (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-lg font-bold leading-tight">{selected.name}</div>
              <div className="text-sm text-slate-500 mt-0.5">{selected.phone}　{selected.address}</div>
              {Number(selected.amount_owed) > 0 && <div className="text-sm text-red-500 mt-1">目前欠款 ${Number(selected.amount_owed).toLocaleString()}</div>}
              {lastOrderHint && <div className="text-xs text-slate-500 mt-1">{lastOrderHint}</div>}
            </div>
            <button onClick={reset} className="shrink-0 text-sm text-slate-500 border border-slate-300 rounded-lg px-3 py-1.5 hover:bg-slate-50">更換</button>
          </div>
        ) : (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-600">新客人資料</span>
              <button onClick={reset} className="text-sm text-slate-500 border border-slate-300 rounded-lg px-3 py-1.5 hover:bg-slate-50">取消</button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <input className={INPUT} placeholder="姓名（必填）" value={newName} onChange={e => setNewName(e.target.value)} />
              <input className={INPUT} placeholder="電話（必填）" inputMode="tel" value={newPhone} onChange={e => setNewPhone(e.target.value)} />
            </div>
            <input className={INPUT} placeholder="地址（必填）" value={newAddress} onChange={e => setNewAddress(e.target.value)} />
            <div>
              <div className="text-xs text-slate-500 mb-1.5">客戶類型（必選，影響預測補貨提醒）</div>
              <Segmented
                value={newCustomerType}
                onChange={setNewCustomerType}
                options={[{ value: 'COMMERCIAL', label: '營業用' }, { value: 'RESIDENTIAL', label: '一般住家' }]}
              />
            </div>
          </div>
        )}

        {pendingReturns.length > 0 && (
          <div className="mt-3 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 space-y-1">
            <div className="text-sm font-medium text-amber-700">有待處理存氣</div>
            {pendingReturns.map((r: any) => (
              <div key={r.id} className="flex justify-between items-center text-sm">
                <span className="text-amber-700">剩餘 {r.remaining_kg} kg · {r.action === 'REFUND' ? '待退費' : '待抵扣'} ${Number(r.amount).toLocaleString()}</span>
                <button onClick={async () => { await api.resolveReturn(r.id); setPendingReturns(prev => prev.filter(x => x.id !== r.id)) }} className="text-xs text-amber-700 underline px-1 py-1">標記完成</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 訂單品項 */}
      <section className={CARD}>
        <div className={LABEL}>訂單品項</div>
        <div className="space-y-2.5">
          {items.map((item, idx) => (
            <div key={idx} className="border border-slate-200 rounded-xl p-3 bg-slate-50/60">
              {/* 規格 */}
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <Segmented
                    value={item.gas_type}
                    onChange={v => updateItem(idx, 'gas_type', v)}
                    options={GAS_OPTIONS.map(o => ({ value: o.type, label: o.label }))}
                    compact
                  />
                </div>
                {items.length > 1 && (
                  <button onClick={() => removeItem(idx)} aria-label="刪除品項" className="w-10 h-10 shrink-0 flex items-center justify-center rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50">
                    <IconTrash className="w-5 h-5" />
                  </button>
                )}
              </div>

              {/* 數量 / 單價 / 小計 */}
              <div className="grid grid-cols-[auto_minmax(5.5rem,1fr)_auto] sm:grid-cols-[auto_12rem_1fr] gap-2 sm:gap-3 items-end mt-3">
                <div>
                  <div className="text-xs text-slate-500 mb-1">數量</div>
                  <div className="flex items-center h-11 border border-slate-300 rounded-xl bg-white overflow-hidden">
                    <button onClick={() => updateItem(idx, 'quantity', Math.max(1, item.quantity - 1))} aria-label="減少" className="w-10 h-full flex items-center justify-center text-slate-600 hover:bg-slate-100 disabled:text-slate-300" disabled={item.quantity <= 1}>
                      <IconMinus className="w-4 h-4" />
                    </button>
                    <span className="w-8 text-center text-lg font-bold tabular-nums">{item.quantity}</span>
                    <button onClick={() => updateItem(idx, 'quantity', item.quantity + 1)} aria-label="增加" className="w-10 h-full flex items-center justify-center text-slate-600 hover:bg-slate-100">
                      <IconPlus className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="text-xs text-slate-500 mb-1">單價</div>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">$</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      className="w-full h-11 border border-slate-300 rounded-xl pl-7 pr-2 text-base tabular-nums bg-white focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-orange-400"
                      value={item.unit_price || ''}
                      placeholder="0"
                      onChange={e => updateItem(idx, 'unit_price', Number(e.target.value) || 0)}
                    />
                  </div>
                </div>
                <div className="text-right min-w-[3.5rem]">
                  <div className="text-xs text-slate-500 mb-1">小計</div>
                  <div className="h-11 flex items-center justify-end text-lg font-bold tabular-nums">${(item.quantity * item.unit_price).toLocaleString()}</div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <button onClick={addItem} className="mt-2.5 w-full h-11 flex items-center justify-center gap-1.5 border border-slate-300 bg-white rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50">
          <IconPlus className="w-4 h-4" /> 新增品項
        </button>

        {!isNew && selected && (
          <div className="mt-3 text-sm text-slate-600 space-y-1.5">
            <label className="flex items-center gap-2 py-1">
              <input type="checkbox" className="w-4 h-4 accent-orange-500" checked={rememberPrice} onChange={e => setRememberPrice(e.target.checked)} />
              記住這個單價（存成 {selected.name} 的特殊單價，以後自動帶入）
            </label>
            {rememberPrice && new Set(items.map(i => i.unit_price)).size > 1 && (
              <div className="flex items-center gap-2 pl-6 flex-wrap">
                <span>單價不同，記住哪一個：</span>
                <select className="border border-slate-300 rounded-lg px-2 py-1 text-sm bg-white" value={rememberPriceIndex} onChange={e => setRememberPriceIndex(Number(e.target.value))}>
                  {items.map((it, idx) => (
                    <option key={idx} value={idx}>{GAS_LABELS[it.gas_type] || it.gas_type} — ${it.unit_price}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
      </section>

      {/* 樓梯費 + 付款方式（平板並排） */}
      <section className={`${CARD} grid grid-cols-1 sm:grid-cols-2 gap-4`}>
        <div>
          <div className={LABEL}>樓梯費</div>
          <div className="relative">
            <input
              type="number"
              inputMode="numeric"
              className={`${INPUT} pr-10 tabular-nums`}
              value={stairFee || ''}
              placeholder="0"
              onChange={e => setStairFee(Number(e.target.value) || 0)}
            />
            <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-sm text-slate-400 pointer-events-none">元</span>
          </div>
        </div>
        <div>
          <div className={LABEL}>付款方式</div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setPaymentType('CASH')}
              className={`h-11 rounded-xl text-base font-medium border transition ${paymentType === 'CASH' ? 'bg-green-600 border-green-600 text-white' : 'bg-white border-slate-300 text-slate-600'}`}
            >現金</button>
            <button
              onClick={() => setPaymentType('AR')}
              className={`h-11 rounded-xl text-base font-medium border transition ${paymentType === 'AR' ? 'bg-slate-800 border-slate-800 text-white' : 'bg-white border-slate-300 text-slate-600'}`}
            >記帳</button>
          </div>
        </div>
      </section>

      {/* 備註 + 其他設定 */}
      <section className={CARD}>
        <div className={LABEL}>備註</div>
        <input className={INPUT} placeholder="不急、指定時間…（選填）" value={note} onChange={e => setNote(e.target.value)} />

        <details className="mt-3 group" open={!!(scheduledDate || callTime)}>
          <summary className="list-none cursor-pointer flex items-center justify-between text-sm text-slate-600 py-1">
            <span>配送日期／來電時間{moreSet ? `（${moreSet}）` : '（預設今天、現在）'}</span>
            <IconChevron className="w-4 h-4 text-slate-400 transition group-open:rotate-180" />
          </summary>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
            <div>
              <div className="text-xs text-slate-500 mb-1">配送日期（留空＝今天）</div>
              <input type="date" className={INPUT} value={scheduledDate} onChange={e => setScheduledDate(e.target.value)} />
              {scheduledDate && scheduledDate > today && (
                <div className="text-orange-600 text-xs mt-1.5">此單排定於 {scheduledDate}，那天之前不會出現在待派送佇列</div>
              )}
              {scheduledDate && scheduledDate < today && (
                <div className="text-slate-500 text-xs mt-1.5">補登單，會立即出現在待送清單，報表歸入 {scheduledDate}</div>
              )}
            </div>
            <div>
              <div className="text-xs text-slate-500 mb-1">來電時間（留空＝現在）</div>
              <input type="datetime-local" className={INPUT} value={callTime} onChange={e => setCallTime(e.target.value)} />
            </div>
          </div>
        </details>
      </section>

      {/* 金額摘要 */}
      <section className={CARD}>
        <div className="space-y-1.5 text-sm text-slate-600">
          <div className="flex justify-between"><span>小計</span><span className="tabular-nums">${gasTotal.toLocaleString()}</span></div>
          <div className="flex justify-between"><span>樓梯費</span><span className="tabular-nums">${stairFee.toLocaleString()}</span></div>
        </div>
        <div className="flex justify-between items-end pt-3 mt-3 border-t border-slate-200">
          <span className="font-medium text-slate-700">應收總額{paymentType === 'AR' && <span className="ml-1.5 text-xs text-slate-500">記帳</span>}</span>
          <span className="text-3xl font-bold text-orange-600 tabular-nums leading-none">${total.toLocaleString()}</span>
        </div>
      </section>

      {/* 主要操作：固定在底部導覽列上方 */}
      <div className="fixed bottom-16 left-0 right-0 z-10 px-3 pb-2">
        <div className="max-w-3xl mx-auto bg-white/95 backdrop-blur border border-slate-200 rounded-2xl shadow-lg p-2 flex gap-2">
          <button
            onClick={handleDeferredSubmit}
            disabled={loading || (!selected && !isNew)}
            title="不用等回應，立刻回到訂單列表，建單在背景處理"
            className="px-4 h-14 rounded-xl text-sm font-medium text-slate-600 border border-slate-300 bg-white hover:bg-slate-50 disabled:text-slate-300 disabled:border-slate-200 whitespace-nowrap"
          >稍後建單</button>
          <button
            onClick={handleSubmit}
            disabled={loading || (!selected && !isNew)}
            className="flex-1 h-14 rounded-xl bg-orange-500 hover:bg-orange-600 active:bg-orange-700 disabled:bg-slate-300 text-white text-lg font-bold flex items-center justify-center gap-3"
          >
            {loading ? '建單中…' : <>確認接單<span className="font-medium opacity-90 tabular-nums">${total.toLocaleString()}</span></>}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─── 樣式常數 ─── */
const CARD = 'bg-white border border-slate-200 rounded-2xl shadow-sm p-4'
const LABEL = 'text-sm font-semibold text-slate-500 mb-2'
const INPUT = 'w-full h-11 border border-slate-300 rounded-xl px-3.5 text-base bg-white focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-orange-400'

/* ─── 分段按鈕 ─── */
function Segmented({ value, onChange, options, compact }: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  compact?: boolean
}) {
  return (
    <div className="flex bg-slate-100 rounded-xl p-1 gap-1">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`flex-1 ${compact ? 'h-9' : 'h-10'} rounded-lg text-sm font-medium transition ${value === o.value ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
        >{o.label}</button>
      ))}
    </div>
  )
}

/* ─── Icons（inline SVG） ─── */
type IP = { className?: string }
const svg = (className: string | undefined, d: ReactNode) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">{d}</svg>
)
const IconSearch = ({ className }: IP) => svg(className, <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>)
const IconPlus = ({ className }: IP) => svg(className, <path d="M12 5v14M5 12h14" />)
const IconMinus = ({ className }: IP) => svg(className, <path d="M5 12h14" />)
const IconTrash = ({ className }: IP) => svg(className, <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></>)
const IconChevron = ({ className }: IP) => svg(className, <path d="m6 9 6 6 6-6" />)
const IconClipboard = ({ className }: IP) => svg(className, <><rect x="6" y="4" width="12" height="17" rx="2" /><path d="M9 4h6v3H9z" /></>)
