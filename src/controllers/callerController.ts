import { Request, Response } from 'express'
import { db } from '../lib/db'

function normalizePhone(raw: string): string {
  let p = raw.replace(/[\s\-().]/g, '')
  if (p.startsWith('+886')) p = '0' + p.slice(4)
  if (p.startsWith('886') && p.length >= 10) p = '0' + p.slice(3)
  return p
}

// 暫存陌生來電號碼（記憶體，重啟清空）
let unknownCallerPhone: string | null = null
let unknownCallerTime: number = 0

export async function lookupCaller(req: Request, res: Response) {
  const { phone, apiKey } = req.body
  if (apiKey !== process.env.CALLER_API_KEY) return res.status(401).json({ error: 'Unauthorized' })
  if (!phone) return res.status(400).json({ error: 'phone required' })

  const normalized = normalizePhone(phone)
  const [rows] = await db.query(
    `SELECT c.*, a.amount_owed, a.cylinders_owed 
     FROM customers c 
     LEFT JOIN ar_balances a ON a.customer_id = c.id
     WHERE (c.phone = ? OR c.phone2 = ?) AND c.status != 'INACTIVE' LIMIT 1`,
    [normalized, normalized]
  ) as any

  if (!rows[0]) return res.json({ found: false, phone: normalized, message: '新號碼，尚未建檔' })

  const c = rows[0]
  return res.json({
    found: true,
    customer: {
      id: c.id, name: c.name, phone: c.phone,
      address: c.address, gasType: c.gas_type,
      cylindersHeld: c.cylinders_held, priceOverride: c.price_override,
      note: c.note, amountOwed: c.amount_owed ?? 0,
      cylindersOwed: c.cylinders_owed ?? 0, lastDelivery: c.last_delivery,
    },
  })
}

export async function createFromCall(req: Request, res: Response) {
  const { phone, name, address, apiKey } = req.body
  if (apiKey !== process.env.CALLER_API_KEY) return res.status(401).json({ error: 'Unauthorized' })
  if (!phone) return res.status(400).json({ error: 'phone required' })

  const normalized = normalizePhone(phone)
  const [existing] = await db.query('SELECT id FROM customers WHERE phone = ? OR phone2 = ? LIMIT 1', [normalized, normalized]) as any
  if (existing[0]) return res.status(409).json({ error: '號碼已存在', customerId: existing[0].id })

  const [result] = await db.query(
    'INSERT INTO customers (name, phone, address, status) VALUES (?, ?, ?, ?)',
    [name || `來電 ${normalized}`, normalized, address || '（待補）', 'ACTIVE']
  ) as any

  const customerId = result.insertId
  await db.query('INSERT INTO ar_balances (customer_id, amount_owed, cylinders_owed) VALUES (?, 0, 0)', [customerId])

  // 清掉陌生來電暫存
  unknownCallerPhone = null

  return res.status(201).json({ created: true, customer: { id: customerId, name: name || `來電 ${normalized}`, phone: normalized } })
}

export async function incomingCall(req: Request, res: Response) {
  const { phone, apiKey } = req.body
  if (apiKey !== process.env.CALLER_API_KEY) return res.status(401).json({ error: 'Unauthorized' })
  if (!phone) return res.status(400).json({ error: 'phone required' })

  const normalized = normalizePhone(phone)

  const [rows] = await db.query(
    `SELECT c.*, a.amount_owed, a.cylinders_owed 
     FROM customers c 
     LEFT JOIN ar_balances a ON a.customer_id = c.id
     WHERE (c.phone = ? OR c.phone2 = ?) AND c.status != 'INACTIVE' LIMIT 1`,
    [normalized, normalized]
  ) as any

  if (!rows[0]) {
    // 陌生號碼，暫存
    unknownCallerPhone = normalized
    unknownCallerTime = Date.now()
    return res.json({ found: false, phone: normalized, draft: null })
  }

  // 清掉陌生來電暫存
  unknownCallerPhone = null

  const c = rows[0]

  const [lastOrders] = await db.query(
    `SELECT o.*, oi.gas_type, oi.quantity, oi.unit_price
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     WHERE o.customer_id = ? AND o.status = 'DELIVERED'
     ORDER BY o.created_at DESC LIMIT 1`,
    [c.id]
  ) as any

  const lastOrder = lastOrders[0]

  const gasType = lastOrder?.gas_type || c.gas_type || '20kg'
  const quantity = lastOrder?.quantity || 1
  const unitPrice = c.price_override || lastOrder?.unit_price || 800
  const totalAmount = quantity * unitPrice

  const [result] = await db.query(
    `INSERT INTO orders (customer_id, quantity, unit_price, total_amount, status, payment_type, note)
     VALUES (?, ?, ?, ?, 'DRAFT', 'CASH', ?)`,
    [c.id, quantity, unitPrice, totalAmount, `來電自動草稿 ${normalized}`]
  ) as any

  const draftId = result.insertId

  await db.query(
    `INSERT INTO order_items (order_id, gas_type, quantity, unit_price, subtotal)
     VALUES (?, ?, ?, ?, ?)`,
    [draftId, gasType, quantity, unitPrice, totalAmount]
  )

  return res.json({
    found: true,
    draft: {
      id: draftId,
      customer: {
        id: c.id, name: c.name, phone: c.phone,
        address: c.address, note: c.note,
        amountOwed: c.amount_owed ?? 0,
      },
      items: [{ gasType, quantity, unitPrice, subtotal: totalAmount }],
      totalAmount,
      paymentType: 'CASH',
    },
  })
}

export async function getDraft(_req: Request, res: Response) {
  // 先查資料庫有沒有 DRAFT 訂單
  const [rows] = await db.query(
    `SELECT o.*, 
      c.name as customer_name, c.phone as customer_phone,
      c.address as customer_address, c.note as customer_note
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.status = 'DRAFT'
     ORDER BY o.created_at DESC LIMIT 1`
  ) as any

  if (rows[0]) {
    const order = rows[0]
    const [items] = await db.query(
      'SELECT * FROM order_items WHERE order_id = ?',
      [order.id]
    ) as any

    return res.json({
      draft: {
        id: order.id,
        customer: {
          id: order.customer_id,
          name: order.customer_name,
          phone: order.customer_phone,
          address: order.customer_address,
          note: order.customer_note,
          amountOwed: order.amount_owed ?? 0,
        },
        items: items.map((i: any) => ({
          gasType: i.gas_type,
          quantity: i.quantity,
          unitPrice: i.unit_price,
          subtotal: i.subtotal,
        })),
        totalAmount: order.total_amount,
        paymentType: order.payment_type,
        createdAt: order.created_at,
      },
      unknownPhone: null,
    })
  }

  // 沒有草稿單，看有沒有陌生來電（5分鐘內有效）
  const fiveMin = 5 * 60 * 1000
  if (unknownCallerPhone && Date.now() - unknownCallerTime < fiveMin) {
    return res.json({ draft: null, unknownPhone: unknownCallerPhone })
  }

  return res.json({ draft: null, unknownPhone: null })
}

export async function confirmDraft(req: Request, res: Response) {
  const id = Number(req.params.id)
  const { paymentType, note, quantity, unitPrice } = req.body

  const [rows] = await db.query(`SELECT * FROM orders WHERE id = ? AND status = 'DRAFT'`, [id]) as any
  if (!rows[0]) return res.status(404).json({ error: '草稿不存在' })

  const order = rows[0]
  const finalQty = quantity || order.quantity
  const finalPrice = unitPrice || order.unit_price
  const finalTotal = finalQty * finalPrice

  await db.query(
    `UPDATE orders SET status = 'PENDING', payment_type = ?, note = ?, quantity = ?, unit_price = ?, total_amount = ? WHERE id = ?`,
    [paymentType || order.payment_type, note || order.note, finalQty, finalPrice, finalTotal, id]
  )

  await db.query(
    `UPDATE order_items SET quantity = ?, unit_price = ?, subtotal = ? WHERE order_id = ?`,
    [finalQty, finalPrice, finalTotal, id]
  )

  if ((paymentType || order.payment_type) === 'AR') {
    await db.query(
      `UPDATE ar_balances SET amount_owed = amount_owed + ?, cylinders_owed = cylinders_owed + ? WHERE customer_id = ?`,
      [finalTotal, finalQty, order.customer_id]
    )
  }

  return res.json({ ok: true })
}

export async function cancelDraft(req: Request, res: Response) {
  const id = Number(req.params.id)
  const [rows] = await db.query(`SELECT id FROM orders WHERE id = ? AND status = 'DRAFT'`, [id]) as any
  if (!rows[0]) return res.status(404).json({ error: '草稿不存在' })

  await db.query('DELETE FROM order_items WHERE order_id = ?', [id])
  await db.query('DELETE FROM orders WHERE id = ?', [id])

  return res.json({ ok: true })
}

export async function incomingCallById(req: Request, res: Response) {
  const { customerId } = req.body
  if (!customerId) return res.status(400).json({ error: 'customerId required' })

  const [rows] = await db.query(
    `SELECT c.*, a.amount_owed FROM customers c 
     LEFT JOIN ar_balances a ON a.customer_id = c.id
     WHERE c.id = ? AND c.status != 'INACTIVE' LIMIT 1`,
    [customerId]
  ) as any

  if (!rows[0]) return res.status(404).json({ error: '客戶不存在' })

  const c = rows[0]

  const gasType = c.gas_type || '20kg'
  const quantity = 1
  const unitPrice = c.price_override || 800
  const totalAmount = quantity * unitPrice

  const [result] = await db.query(
    `INSERT INTO orders (customer_id, quantity, unit_price, total_amount, status, payment_type, note)
     VALUES (?, ?, ?, ?, 'DRAFT', 'CASH', '陌生來電草稿')`,
    [c.id, quantity, unitPrice, totalAmount]
  ) as any

  const orderId = result.insertId

  await db.query(
    `INSERT INTO order_items (order_id, gas_type, quantity, unit_price, subtotal)
     VALUES (?, ?, ?, ?, ?)`,
    [orderId, gasType, quantity, unitPrice, totalAmount]
  )

  return res.json({ ok: true, orderId })
}
