import { Request, Response, NextFunction } from 'express'
import { db } from '../lib/db'
import { insertLineOrder, resolveDateChoice } from './lineController'
import { normalizePhone } from '../lib/phone'

// LIFF 網頁訂購：客人在 LINE 裡開網頁一次填完，不再一句一句跳選單。
// 身分驗證用 LINE 的 ID token（前端 liff.getIDToken()），後端向 LINE 驗證後取得 userId（sub），
// 不信任前端直接傳來的 userId。
// 需要的環境變數只有 LIFF_ID；LINE Login channel ID 就是 LIFF ID 的「-」前半段。
const LIFF_ID = process.env.LIFF_ID || ''
const LOGIN_CHANNEL_ID = LIFF_ID.split('-')[0]

const GAS_TYPES = ['BOTTLED_20KG', 'BOTTLED_16KG', 'BOTTLED_10KG', 'BOTTLED_4KG']
const SLOTS = ['上午', '中午', '傍晚', '都可以']
const DATE_CHOICES = ['today', 'tomorrow', 'dayafter']

type LiffReq = Request & { lineUserId?: string }

// GET /api/line/liff/config — 前端啟動時拿 LIFF ID（不用在 build 時寫死）
export function liffConfig(_req: Request, res: Response) {
  res.json({ liffId: LIFF_ID || null })
}

export async function liffAuth(req: LiffReq, res: Response, next: NextFunction) {
  const idToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!idToken || !LOGIN_CHANNEL_ID) return res.status(401).json({ error: '請從 LINE 開啟此頁面' })
  try {
    const r = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: LOGIN_CHANNEL_ID }).toString(),
    })
    const data = await r.json() as any
    if (!r.ok || !data.sub) return res.status(401).json({ error: '登入已過期，請關閉後重新開啟' })
    req.lineUserId = data.sub
    next()
  } catch (err) {
    console.error('[liff verify]', err)
    res.status(502).json({ error: '暫時無法驗證 LINE 身分，請稍後再試' })
  }
}

async function getBoundCustomerId(lineUserId: string): Promise<number | null> {
  const [rows] = await db.query(`SELECT customer_id FROM line_users WHERE line_user_id = ?`, [lineUserId]) as any
  return rows[0]?.customer_id ?? null
}

// GET /api/line/liff/me — 綁定狀態、客戶基本資料、上次叫的品項、進行中的訂單
export async function liffMe(req: LiffReq, res: Response) {
  const customerId = await getBoundCustomerId(req.lineUserId!)
  if (!customerId) return res.json({ bound: false })

  const [cRows] = await db.query(`SELECT id, name, address, phone, phone2 FROM customers WHERE id = ?`, [customerId]) as any
  const customer = cRows[0]
  if (!customer) return res.json({ bound: false })

  const [lastRows] = await db.query(
    `SELECT id FROM orders WHERE customer_id = ? AND status != 'CANCELLED' ORDER BY created_at DESC LIMIT 1`,
    [customerId]
  ) as any
  const lastItems = lastRows[0]
    ? ((await db.query(`SELECT gas_type, quantity FROM order_items WHERE order_id = ?`, [lastRows[0].id]) as any)[0])
        .map((i: any) => ({ gasType: i.gas_type, qty: Number(i.quantity) }))
    : []

  const [activeRows] = await db.query(
    `SELECT o.id, o.status, o.scheduled_date, o.created_at FROM orders o
     WHERE o.customer_id = ? AND o.status IN ('PENDING','ASSIGNED','DELIVERING')
     ORDER BY o.created_at DESC LIMIT 1`,
    [customerId]
  ) as any
  let activeOrder = null
  if (activeRows[0]) {
    const [ai] = await db.query(`SELECT gas_type, quantity FROM order_items WHERE order_id = ?`, [activeRows[0].id]) as any
    activeOrder = {
      id: activeRows[0].id,
      status: activeRows[0].status,
      items: ai.map((i: any) => ({ gasType: i.gas_type, qty: Number(i.quantity) })),
    }
  }

  const [extra] = await db.query(`SELECT phone FROM customer_phones WHERE customer_id = ? ORDER BY id`, [customerId]) as any
  const phones = [...new Set([customer.phone, customer.phone2, ...extra.map((r: any) => r.phone)].filter(Boolean))]

  const { history, typicalDays } = await getOrderHistory(customerId)

  res.json({ bound: true, customer: { name: customer.name, address: customer.address, phones }, lastItems, activeOrder, history, typicalDays })
}

// 叫瓦斯紀錄：同一天多筆合併成一筆；日期用「送達日優先」（與預測功能一致），
// 以字串回傳避免前端時區換算差一天。typicalDays = 叫貨間隔中位數（≥3 個叫貨日才給）
async function getOrderHistory(customerId: number) {
  const EFFECTIVE = 'COALESCE(o.delivered_at, o.scheduled_date, o.created_at)'
  const [rows] = await db.query(
    `SELECT DATE_FORMAT(${EFFECTIVE}, '%Y-%m-%d') AS d, oi.gas_type, SUM(oi.quantity) AS qty
     FROM orders o JOIN order_items oi ON oi.order_id = o.id
     WHERE o.customer_id = ? AND o.status NOT IN ('CANCELLED','DRAFT')
       AND DATE(${EFFECTIVE}) >= (
         SELECT MIN(x.d) FROM (
           SELECT DISTINCT DATE(COALESCE(delivered_at, scheduled_date, created_at)) AS d
           FROM orders WHERE customer_id = ? AND status NOT IN ('CANCELLED','DRAFT')
           ORDER BY d DESC LIMIT 6
         ) x
       )
     GROUP BY d, oi.gas_type
     ORDER BY d DESC`,
    [customerId, customerId]
  ) as any

  const byDate = new Map<string, { gasType: string; qty: number }[]>()
  for (const r of rows) {
    if (!byDate.has(r.d)) byDate.set(r.d, [])
    byDate.get(r.d)!.push({ gasType: r.gas_type, qty: Number(r.qty) })
  }
  const all = [...byDate.entries()].map(([date, items]) => ({ date, items }))

  let typicalDays: number | null = null
  if (all.length >= 3) {
    const gaps: number[] = []
    for (let i = 0; i < all.length - 1; i++) {
      gaps.push(Math.round((Date.parse(all[i].date) - Date.parse(all[i + 1].date)) / 86400000))
    }
    gaps.sort((a, b) => a - b)
    const mid = Math.floor(gaps.length / 2)
    const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2
    if (median >= 1) typicalDays = Math.round(median)
  }
  return { history: all.slice(0, 5), typicalDays }
}

// POST /api/line/liff/bind { phone } → 找到既有客戶就綁定；找不到回 needProfile
// POST /api/line/liff/bind { phone, name, address } → 建新客戶並綁定
export async function liffBind(req: LiffReq, res: Response) {
  const phone = String(req.body?.phone || '').replace(/[^\d]/g, '')
  if (phone.length < 8) return res.status(400).json({ error: '請輸入正確的電話號碼' })
  const userId = req.lineUserId!

  // 主電話、副電話、customer_phones 三處都要比對（與聊天綁定流程一致）
  const [rows] = await db.query(
    `SELECT id, name FROM customers c WHERE (c.phone = ? OR c.phone2 = ? OR EXISTS (
      SELECT 1 FROM customer_phones cp WHERE cp.customer_id = c.id AND cp.phone = ?
    )) AND c.status = 'ACTIVE' LIMIT 1`,
    [phone, phone, phone]
  ) as any

  let customerId: number
  if (rows[0]) {
    customerId = rows[0].id
  } else {
    const name = String(req.body?.name || '').trim()
    const address = String(req.body?.address || '').trim()
    if (!name || !address) return res.json({ needProfile: true })
    const [result] = await db.query(
      `INSERT INTO customers (name, phone, address, gas_type, status, delivery_cycle)
       VALUES (?, ?, ?, 'BOTTLED_20KG', 'ACTIVE', 'ON_CALL')`,
      [name, phone, address]
    ) as any
    customerId = result.insertId
  }
  await db.query(
    `INSERT INTO line_users (line_user_id, customer_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE customer_id = ?`,
    [userId, customerId, customerId]
  )
  res.json({ ok: true })
}

// POST /api/line/liff/order { items:[{gasType,qty}], date, slot, note }
export async function liffOrder(req: LiffReq, res: Response) {
  const customerId = await getBoundCustomerId(req.lineUserId!)
  if (!customerId) return res.status(400).json({ error: '尚未綁定，請重新開啟頁面' })

  const rawItems: any[] = Array.isArray(req.body?.items) ? req.body.items : []
  const items = rawItems
    .map(i => ({ gasType: String(i.gasType), qty: Math.floor(Number(i.qty)) }))
    .filter(i => GAS_TYPES.includes(i.gasType) && i.qty > 0 && i.qty <= 50)
  if (items.length === 0) return res.status(400).json({ error: '請至少選擇一桶' })

  const date = DATE_CHOICES.includes(req.body?.date) ? req.body.date : 'today'
  const slot = SLOTS.includes(req.body?.slot) ? req.body.slot : '都可以'
  const note = String(req.body?.note || '').trim().slice(0, 100)

  const { scheduledDate, label } = resolveDateChoice(date)
  const dateLabel = slot === '都可以' ? label : `${label} ${slot}`
  try {
    const r = await insertLineOrder(customerId, items, scheduledDate, dateLabel, note)
    res.json({ ok: true, orderId: r.orderId, summary: r.itemsSummary, dateLabel })
  } catch (err) {
    console.error('[liff order]', err)
    res.status(500).json({ error: '訂單建立失敗，請稍後再試或直接來電' })
  }
}

// POST /api/line/liff/profile { name, address } — 客人自行修改姓名／地址。
// 電話另外用 /liff/phone 只能「新增」，不能改掉舊號碼（舊號碼是來電辨識依據）。每次修改都在客戶備註留一行紀錄，讓後台看得到改了什麼。
export async function liffProfile(req: LiffReq, res: Response) {
  const customerId = await getBoundCustomerId(req.lineUserId!)
  if (!customerId) return res.status(400).json({ error: '尚未綁定，請重新開啟頁面' })

  const name = String(req.body?.name || '').trim().slice(0, 50)
  const address = String(req.body?.address || '').trim().slice(0, 200)
  if (!name || !address) return res.status(400).json({ error: '姓名和地址都要填寫' })

  const [rows] = await db.query(`SELECT name, address FROM customers WHERE id = ?`, [customerId]) as any
  const old = rows[0]
  if (!old) return res.status(404).json({ error: '找不到客戶資料' })

  const changes: string[] = []
  if (old.name !== name) changes.push(`姓名 ${old.name || '（空）'} → ${name}`)
  if (old.address !== address) changes.push(`地址 ${old.address || '（空）'} → ${address}`)
  if (changes.length === 0) return res.json({ ok: true, changed: false })

  const t = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }))
  const log = `\n[${t.getMonth() + 1}/${t.getDate()} LINE 自行修改：${changes.join('；')}]`
  await db.query(
    `UPDATE customers SET name = ?, address = ?, note = CONCAT(COALESCE(note, ''), ?) WHERE id = ?`,
    [name, address, log, customerId]
  )
  res.json({ ok: true, changed: true })
}

// POST /api/line/liff/phone { phone } — 客人自行「新增」一支電話（加到 customer_phones，舊號碼保留）。
// 已經屬於其他客戶的號碼一律擋下，避免同一支電話對到兩個人、來電比對或綁定對錯人。
export async function liffAddPhone(req: LiffReq, res: Response) {
  const customerId = await getBoundCustomerId(req.lineUserId!)
  if (!customerId) return res.status(400).json({ error: '尚未綁定，請重新開啟頁面' })

  const phone = normalizePhone(String(req.body?.phone || ''))
  if (!/^0\d{8,9}$/.test(phone)) return res.status(400).json({ error: '請輸入正確的電話號碼（市話請加區碼）' })

  const [owners] = await db.query(
    `SELECT c.id FROM customers c WHERE (c.phone = ? OR c.phone2 = ? OR EXISTS (
      SELECT 1 FROM customer_phones cp WHERE cp.customer_id = c.id AND cp.phone = ?
    ))`,
    [phone, phone, phone]
  ) as any
  if (owners.some((o: any) => o.id === customerId)) return res.json({ ok: true, changed: false })
  if (owners.length > 0) return res.status(409).json({ error: '這支電話已登記在其他帳號，請來電由我們協助處理' })

  const t = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }))
  const log = `\n[${t.getMonth() + 1}/${t.getDate()} LINE 自行新增電話：${phone}]`
  await db.query(`INSERT IGNORE INTO customer_phones (customer_id, phone) VALUES (?, ?)`, [customerId, phone])
  await db.query(`UPDATE customers SET note = CONCAT(COALESCE(note, ''), ?) WHERE id = ?`, [log, customerId])
  res.json({ ok: true, changed: true })
}
