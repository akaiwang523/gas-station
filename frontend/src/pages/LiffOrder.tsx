import { useEffect, useState, type ReactNode } from 'react'
import type { Liff } from '@line/liff'

// LINE 內開啟的客人訂購頁（LIFF）。不走後台登入，用 LINE ID token 向後端證明身分。
// 流程：初始化 LIFF →（未綁定）輸入電話綁定／新客建檔 → 一頁選品項、日期、時段 → 送出 → 完成畫面

const GAS = [
  { type: 'BOTTLED_20KG', label: '20kg' },
  { type: 'BOTTLED_16KG', label: '16kg' },
  { type: 'BOTTLED_10KG', label: '10kg' },
  { type: 'BOTTLED_4KG', label: '4kg' },
]
const DATES = [
  { value: 'today', label: '今天', offset: 0 },
  { value: 'tomorrow', label: '明天', offset: 1 },
  { value: 'dayafter', label: '後天', offset: 2 },
]
const SLOTS = ['都可以', '上午', '中午', '傍晚']
const STATUS_LABEL: Record<string, string> = { PENDING: '待派送', ASSIGNED: '已安排', DELIVERING: '配送中' }
const PHONE = '06-2231668'

type Item = { gasType: string; qty: number }
type Me =
  | { bound: false }
  | { bound: true; customer: { name: string; address: string; phones: string[] }; lastItems: Item[]; activeOrder: { id: number; status: string; items: Item[] } | null; history?: { date: string; items: Item[] }[]; typicalDays?: number | null }

function taipeiNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }))
}
function dateText(offset: number) {
  const d = taipeiNow(); d.setDate(d.getDate() + offset)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
const gasLabel = (t: string) => GAS.find(g => g.type === t)?.label || t
const itemsText = (items: Item[]) => items.map(i => `${gasLabel(i.gasType)} × ${i.qty}`).join('、')
// 'YYYY-MM-DD' → 距今天（台北）幾天
function daysAgo(ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number)
  const t = taipeiNow()
  return Math.round((Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) - Date.UTC(y, m - 1, d)) / 86400000)
}
const ymdText = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); return y === taipeiNow().getFullYear() ? `${m}/${d}` : `${y}/${m}/${d}` }
const agoText = (n: number) => n <= 0 ? '今天' : n === 1 ? '昨天' : n < 60 ? `${n} 天前` : n < 365 ? `約 ${Math.round(n / 30)} 個月前` : `超過 ${Math.floor(n / 365)} 年`

// 本機開發測試用：localhost 加上 ?liffMock 就跳過 LINE 登入
const MOCK = typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && location.search.includes('liffMock')

export default function LiffOrder() {
  const [liff, setLiff] = useState<Liff | null>(null)
  const [token, setToken] = useState('')
  const [phase, setPhase] = useState<'loading' | 'error' | 'bind' | 'order' | 'profile' | 'done'>('loading')
  const [fatal, setFatal] = useState('')
  const [me, setMe] = useState<Me | null>(null)
  const [done, setDone] = useState<{ summary: string; dateLabel: string } | null>(null)

  async function api(path: string, body?: any, tk = token) {
    const res = await fetch(`/api/line/liff${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || '發生錯誤，請稍後再試')
    return data
  }

  async function loadMe(tk = token) {
    const data: Me = await api('/me', undefined, tk)
    setMe(data)
    setPhase(data.bound ? 'order' : 'bind')
  }

  useEffect(() => {
    document.title = '叫瓦斯'
    ;(async () => {
      try {
        if (MOCK) { setToken('mock'); await loadMe('mock'); return }
        const cfg = await fetch('/api/line/liff/config').then(r => r.json())
        if (!cfg.liffId) throw new Error('訂購頁尚未設定完成，請直接來電')
        const { default: sdk } = await import('@line/liff')
        await sdk.init({ liffId: cfg.liffId })
        if (!sdk.isLoggedIn()) { sdk.login({ redirectUri: location.href }); return }
        const tk = sdk.getIDToken()
        if (!tk) throw new Error('無法取得 LINE 身分，請關閉後重新開啟')
        setLiff(sdk); setToken(tk)
        await loadMe(tk)
      } catch (e: any) {
        setFatal(e.message || '載入失敗'); setPhase('error')
      }
    })()
  }, [])

  function close() {
    if (liff?.isInClient()) liff.closeWindow()
    else window.close()
  }

  return (
    <div className="min-h-screen bg-stone-50 text-slate-800">
      <div className="max-w-md mx-auto px-4 pt-5 pb-32">
        {phase === 'loading' && <Center><Spinner /><div className="text-slate-500 mt-3">載入中…</div></Center>}

        {phase === 'error' && (
          <Center>
            <div className="text-lg font-bold">無法開啟訂購頁</div>
            <div className="text-slate-500 mt-2 text-sm">{fatal}</div>
            <a href={`tel:${PHONE}`} className="mt-6 inline-block px-6 h-12 leading-[3rem] rounded-xl bg-orange-500 text-white font-bold">來電訂購 {PHONE}</a>
          </Center>
        )}

        {phase === 'bind' && <BindForm api={api} onBound={() => loadMe()} />}

        {phase === 'order' && me?.bound && (
          <OrderForm me={me} api={api} onDone={r => { setDone(r); setPhase('done') }} onEditProfile={() => setPhase('profile')} />
        )}

        {phase === 'profile' && me?.bound && (
          <ProfileForm me={me} api={api} onBack={() => setPhase('order')} onSaved={() => loadMe()}
            onPhoneAdded={() => api('/me').then(setMe).catch(() => {})} />
        )}

        {phase === 'done' && done && (
          <Center>
            <div className="w-16 h-16 rounded-full bg-green-100 text-green-600 flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-9 h-9" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>
            </div>
            <div className="text-xl font-bold mt-4">訂單已送出</div>
            <div className="mt-4 bg-white border border-slate-200 rounded-2xl p-4 w-full text-left space-y-1.5">
              <Row k="品項" v={done.summary} />
              <Row k="配送" v={done.dateLabel} />
            </div>
            <div className="text-sm text-slate-500 mt-3">我們會盡快為您送達，如需更改請來電 {PHONE}</div>
            <button onClick={close} className="mt-6 w-full h-12 rounded-xl border border-slate-300 bg-white font-medium">關閉</button>
          </Center>
        )}
      </div>
    </div>
  )
}

/* ─── 上次叫瓦斯 ─── */
function HistoryCard({ history }: { history: { date: string; items: Item[] }[]; typicalDays?: number | null }) {
  if (history.length === 0) return null
  const last = history[0]
  return (
    <section className={`${CARD} mt-4`}>
      <div className="text-sm text-slate-500">上次叫瓦斯</div>
      <div className="mt-0.5 flex items-baseline justify-between gap-3">
        <div className="text-lg font-bold">
          {ymdText(last.date)}<span className="ml-2 text-base font-medium text-slate-500">（{agoText(daysAgo(last.date))}）</span>
        </div>
        <div className="text-base text-slate-700 text-right">{itemsText(last.items)}</div>
      </div>
    </section>
  )
}

/* ─── 綁定／新客建檔 ─── */
function BindForm({ api, onBound }: { api: (p: string, b?: any) => Promise<any>; onBound: () => void }) {
  const [phone, setPhone] = useState('')
  const [needProfile, setNeedProfile] = useState(false)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit() {
    setErr(''); setBusy(true)
    try {
      const r = await api('/bind', needProfile ? { phone, name, address } : { phone })
      if (r.needProfile) setNeedProfile(true)
      else onBound()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const canSubmit = phone.replace(/\D/g, '').length >= 8 && (!needProfile || (name.trim() && address.trim()))

  return (
    <>
      <h1 className="text-2xl font-bold">歡迎使用線上叫瓦斯</h1>
      <p className="text-slate-500 mt-1 text-sm">第一次使用請先輸入電話，之後開啟就能直接下單。</p>
      <section className={`${CARD} mt-5 space-y-3`}>
        <Field label="電話">
          <input className={INPUT} inputMode="tel" placeholder="例如 0912345678" value={phone} disabled={needProfile}
            onChange={e => setPhone(e.target.value)} />
        </Field>
        {needProfile && (
          <>
            <div className="text-sm text-slate-600 bg-slate-50 rounded-xl px-3 py-2">查不到這支電話，請填寫資料建立新帳號</div>
            <Field label="姓名／店名"><input className={INPUT} value={name} onChange={e => setName(e.target.value)} /></Field>
            <Field label="配送地址"><input className={INPUT} placeholder="含樓層" value={address} onChange={e => setAddress(e.target.value)} /></Field>
            <button onClick={() => setNeedProfile(false)} className="text-sm text-slate-500 underline">改用其他電話</button>
          </>
        )}
        {err && <div className="text-sm text-red-600">{err}</div>}
      </section>
      <BottomBar>
        <button onClick={submit} disabled={!canSubmit || busy} className={PRIMARY}>{busy ? '處理中…' : needProfile ? '建立帳號' : '下一步'}</button>
      </BottomBar>
    </>
  )
}

/* ─── 訂購表單 ─── */
function OrderForm({ me, api, onDone, onEditProfile }: {
  me: Extract<Me, { bound: true }>
  api: (p: string, b?: any) => Promise<any>
  onDone: (r: { summary: string; dateLabel: string }) => void
  onEditProfile: () => void
}) {
  const initQty: Record<string, number> = {}
  for (const it of me.lastItems) initQty[it.gasType] = (initQty[it.gasType] || 0) + it.qty
  if (me.lastItems.length === 0) initQty.BOTTLED_20KG = 1
  const [qty, setQty] = useState<Record<string, number>>(initQty)
  const [date, setDate] = useState(taipeiNow().getHours() >= 18 ? 'tomorrow' : 'today')
  const [slot, setSlot] = useState('都可以')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const total = Object.values(qty).reduce((s, n) => s + n, 0)
  const set = (t: string, n: number) => setQty(q => ({ ...q, [t]: Math.max(0, Math.min(50, n)) }))

  async function submit() {
    setErr(''); setBusy(true)
    try {
      const items = GAS.filter(g => qty[g.type] > 0).map(g => ({ gasType: g.type, qty: qty[g.type] }))
      const r = await api('/order', { items, date, slot, note })
      onDone({ summary: r.summary, dateLabel: r.dateLabel })
    } catch (e: any) { setErr(e.message); setBusy(false) }
  }

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">叫瓦斯</h1>
          <div className="mt-1 text-sm text-slate-500">
            {me.customer.name}　{me.customer.address || '（地址未登記）'}
          </div>
        </div>
        <button onClick={onEditProfile} className="shrink-0 mt-1 text-sm text-slate-600 border border-slate-300 bg-white rounded-lg px-3 h-9">修改資料</button>
      </div>

      {me.activeOrder && (
        <div className="mt-4 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-sm text-amber-800">
          您目前有一筆{STATUS_LABEL[me.activeOrder.status] || '進行中'}的訂單（{itemsText(me.activeOrder.items)}）。
          若是要再加訂，請繼續填寫；若只是想確認，不用重複下單。
        </div>
      )}

      <HistoryCard history={me.history || []} typicalDays={me.typicalDays ?? null} />

      <section className={`${CARD} mt-4`}>
        <div className={LABEL}>品項與數量{me.lastItems.length > 0 && <span className="ml-2 font-normal text-slate-400">已帶入上次訂購</span>}</div>
        <div className="divide-y divide-slate-100">
          {GAS.map(g => {
            const n = qty[g.type] || 0
            return (
              <div key={g.type} className="flex items-center justify-between py-2.5">
                <div className={`text-lg font-bold ${n ? '' : 'text-slate-400'}`}>{g.label} 桶裝</div>
                <div className="flex items-center h-11 border border-slate-300 rounded-xl bg-white overflow-hidden">
                  <button aria-label="減少" onClick={() => set(g.type, n - 1)} disabled={n === 0} className="w-11 h-full flex items-center justify-center text-slate-600 disabled:text-slate-300 active:bg-slate-100">
                    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><path d="M5 12h14" /></svg>
                  </button>
                  <span className="w-9 text-center text-lg font-bold tabular-nums">{n}</span>
                  <button aria-label="增加" onClick={() => set(g.type, n + 1)} className="w-11 h-full flex items-center justify-center text-slate-600 active:bg-slate-100">
                    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className={`${CARD} mt-3 space-y-4`}>
        <div>
          <div className={LABEL}>配送日期</div>
          <Segmented value={date} onChange={setDate} options={DATES.map(d => ({ value: d.value, label: d.label, sub: dateText(d.offset) }))} />
        </div>
        <div>
          <div className={LABEL}>希望時段</div>
          <Segmented value={slot} onChange={setSlot} options={SLOTS.map(s => ({ value: s, label: s }))} />
        </div>
        <div>
          <div className={LABEL}>備註（選填）</div>
          <input className={INPUT} maxLength={100} placeholder="例如：放門口、到了先打電話" value={note} onChange={e => setNote(e.target.value)} />
        </div>
      </section>

      <div className="text-xs text-slate-400 mt-3 px-1">金額依實際配送為準，貨到付款。</div>
      {err && <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{err}</div>}

      <BottomBar>
        <button onClick={submit} disabled={total === 0 || busy} className={PRIMARY}>
          {busy ? '送出中…' : total === 0 ? '請選擇數量' : `送出訂單（共 ${total} 桶）`}
        </button>
      </BottomBar>
    </>
  )
}

/* ─── 修改資料 ─── */
function ProfileForm({ me, api, onBack, onSaved, onPhoneAdded }: {
  me: Extract<Me, { bound: true }>
  api: (p: string, b?: any) => Promise<any>
  onBack: () => void
  onSaved: () => void
  onPhoneAdded: () => void
}) {
  const [name, setName] = useState(me.customer.name || '')
  const [address, setAddress] = useState(me.customer.address === '（待補）' ? '' : (me.customer.address || ''))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [addingPhone, setAddingPhone] = useState(false)
  const [newPhone, setNewPhone] = useState('')
  const [phoneBusy, setPhoneBusy] = useState(false)
  const [phoneErr, setPhoneErr] = useState('')
  const [phoneMsg, setPhoneMsg] = useState('')

  async function addPhone() {
    setPhoneErr(''); setPhoneMsg(''); setPhoneBusy(true)
    try {
      const r = await api('/phone', { phone: newPhone })
      setPhoneMsg(r.changed ? '已新增電話' : '這支電話已經登記過了')
      setAddingPhone(false); setNewPhone('')
      if (r.changed) onPhoneAdded()
    } catch (e: any) { setPhoneErr(e.message) } finally { setPhoneBusy(false) }
  }

  async function save() {
    setErr(''); setBusy(true)
    try { await api('/profile', { name, address }); onSaved() }
    catch (e: any) { setErr(e.message); setBusy(false) }
  }

  return (
    <>
      <button onClick={onBack} className="text-sm text-slate-500 -ml-1 px-1 py-1">‹ 返回訂購</button>
      <h1 className="text-2xl font-bold mt-1">修改資料</h1>
      <section className={`${CARD} mt-4 space-y-3`}>
        <Field label="姓名／店名"><input className={INPUT} value={name} onChange={e => setName(e.target.value)} /></Field>
        <Field label="配送地址"><input className={INPUT} placeholder="含樓層" value={address} onChange={e => setAddress(e.target.value)} /></Field>
        {err && <div className="text-sm text-red-600">{err}</div>}
      </section>

      <section className={`${CARD} mt-3`}>
        <div className={LABEL}>電話</div>
        <div className="space-y-1.5">
          {me.customer.phones.length === 0 && <div className="text-sm text-slate-400">尚未登記</div>}
          {me.customer.phones.map(p => (
            <div key={p} className="h-11 px-3.5 flex items-center rounded-xl bg-slate-50 border border-slate-200 text-slate-600 tabular-nums">{p}</div>
          ))}
        </div>
        {addingPhone ? (
          <div className="mt-3 space-y-2">
            <input className={INPUT} inputMode="tel" placeholder="新電話號碼（市話請加區碼）" value={newPhone} onChange={e => setNewPhone(e.target.value)} />
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => { setAddingPhone(false); setNewPhone(''); setPhoneErr('') }} className="h-11 rounded-xl border border-slate-300 bg-white text-slate-600">取消</button>
              <button onClick={addPhone} disabled={phoneBusy || newPhone.replace(/\D/g, '').length < 9} className="h-11 rounded-xl bg-slate-800 text-white font-medium disabled:bg-slate-300">{phoneBusy ? '新增中…' : '新增'}</button>
            </div>
            {phoneErr && <div className="text-sm text-red-600">{phoneErr}</div>}
          </div>
        ) : (
          <button onClick={() => setAddingPhone(true)} className="mt-3 w-full h-11 rounded-xl border border-slate-300 bg-white text-sm font-medium text-slate-700">＋ 新增電話</button>
        )}
        {phoneMsg && <div className="mt-2 text-sm text-green-700">{phoneMsg}</div>}
        <div className="text-xs text-slate-400 mt-3">原有號碼會保留，打哪一支來我們都認得。需要刪除舊號碼請來電 {PHONE}</div>
      </section>
      <BottomBar>
        <button onClick={save} disabled={busy || !name.trim() || !address.trim()} className={PRIMARY}>{busy ? '儲存中…' : '儲存'}</button>
      </BottomBar>
    </>
  )
}

/* ─── 小元件 ─── */
const CARD = 'bg-white border border-slate-200 rounded-2xl shadow-sm p-4'
const LABEL = 'text-sm font-semibold text-slate-500 mb-2'
const INPUT = 'w-full h-12 border border-slate-300 rounded-xl px-3.5 text-base bg-white focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-orange-400 disabled:bg-slate-100 disabled:text-slate-500'
const PRIMARY = 'w-full h-14 rounded-xl bg-orange-500 active:bg-orange-600 disabled:bg-slate-300 text-white text-lg font-bold'

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string; sub?: string }[] }) {
  return (
    <div className="flex bg-slate-100 rounded-xl p-1 gap-1">
      {options.map(o => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={`flex-1 min-h-[2.75rem] py-1 rounded-lg text-base font-medium leading-tight transition ${value === o.value ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-500'}`}>
          {o.label}{o.sub && <div className="text-xs font-normal text-slate-400">{o.sub}</div>}
        </button>
      ))}
    </div>
  )
}
function BottomBar({ children }: { children: ReactNode }) {
  return (
    <div className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur border-t border-slate-200 px-4 pt-3" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
      <div className="max-w-md mx-auto">{children}</div>
    </div>
  )
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><div className="text-sm text-slate-500 mb-1">{label}</div>{children}</label>
}
function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex gap-3"><span className="text-slate-500 w-10 shrink-0">{k}</span><span className="font-medium">{v}</span></div>
}
function Center({ children }: { children: ReactNode }) {
  return <div className="min-h-[70vh] flex flex-col items-center justify-center text-center">{children}</div>
}
function Spinner() {
  return <div className="w-8 h-8 border-[3px] border-slate-200 border-t-orange-500 rounded-full animate-spin" />
}
