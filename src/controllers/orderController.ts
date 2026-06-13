import { Request, Response } from 'express'
import { db } from '../lib/db'

// 取得訂單列表
export async function listOrders(req: Request, res: Response) {
  const { status, date, driverId, page = '1', limit = '50' } = req.query
  const conditions: string[] = []
  const params: any[] = []

  if (status) { conditions.push('o.status = ?'); params.push(status) }
  if (driverId) { conditions.push('o.driver_id = ?'); params.push(driverId) }
  if (date) {
    conditions.push('DATE(o.created_at) = ?')
    params.push(date)
  } else {
    conditions.push('DATE(o.created_at) = CURDATE()')
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const offset = (Number(page) - 1) * Number(limit)

  const [orders] = await db.query(
    `SELECT o.*, 
      c.name as customer_name, c.phone as customer_phone, 
      c.address as customer_address, c.district as customer_district,
      u.name as driver_name
     FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN users u ON u.id = o.driver_id
     ${where}
     ORDER BY o.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, Number(limit), offset]
  ) as any

  res.json({ orders })
}

// 建立訂單
export async function createOrder(req: Request, res: Response) {
  const { customerId, quantity, unitPrice, note, paymentType = 'CASH' } = req.body
  if (!customerId || !quantity || !unitPrice) {
    return res.status(400).json({ error: '缺少必要欄位' })
  }

  const totalAmount = Number(quantity) * Number(unitPrice)

  const [result] = await db.query(
    `INSERT INTO orders (customer_id, quantity, unit_price, total_amount, status, note, payment_type)
     VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`,
    [customerId, quantity, unitPrice, totalAmount, note || null, paymentType]
  ) as any

  const orderId = result.insertId

  // 如果是欠帳，更新 ar_balances
  if (paymentType === 'AR') {
    await db.query(
      `INSERT INTO ar_balances (customer_id, amount_owed, cylinders_owed)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         amount_owed = amount_owed + VALUES(amount_owed),
         cylinders_owed = cylinders_owed + VALUES(cylinders_owed),
         updated_at = NOW()`,
      [customerId, totalAmount, quantity]
    )
  }

  // 更新客戶最後配送時間
  await db.query('UPDATE customers SET last_delivery = NOW() WHERE id = ?', [customerId])

  res.status(201).json({ id: orderId, totalAmount })
}

// 更新訂單狀態
export async function updateOrderStatus(req: Request, res: Response) {
  const id = Number(req.params.id)
  const { status, driverId } = req.body

  const updates: string[] = ['status = ?']
  const params: any[] = [status]

  if (driverId !== undefined) { updates.push('driver_id = ?'); params.push(driverId) }
  if (status === 'DELIVERED') { updates.push('delivered_at = NOW()') }

  params.push(id)
  await db.query(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`, params)
  res.json({ ok: true })
}

// 訂單收款
export async function collectPayment(req: Request, res: Response) {
  const orderId = Number(req.params.id)
  const { amount, method = 'CASH', note } = req.body
  const collectedBy = (req as any).user.id

  const [orderRows] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]) as any
  const order = orderRows[0]
  if (!order) return res.status(404).json({ error: '訂單不存在' })

  await db.query(
    `INSERT INTO payments (order_id, collected_by, amount, method, note) VALUES (?, ?, ?, ?, ?)`,
    [orderId, collectedBy, amount, method, note || null]
  )

  // 如果是欠帳訂單收款，更新 ar_balances
  if (order.payment_type === 'AR') {
    await db.query(
      `UPDATE ar_balances SET amount_owed = amount_owed - ?, last_payment = NOW() WHERE customer_id = ?`,
      [amount, order.customer_id]
    )
  }

  await db.query(`UPDATE orders SET status = 'DELIVERED' WHERE id = ?`, [orderId])
  res.json({ ok: true })
}

// 取得今日統計
export async function getTodaySummary(_req: Request, res: Response) {
  const [rows] = await db.query(
    `SELECT 
      COUNT(*) as total_orders,
      SUM(quantity) as total_cylinders,
      SUM(CASE WHEN payment_type != 'AR' THEN total_amount ELSE 0 END) as cash_amount,
      SUM(CASE WHEN payment_type = 'AR' THEN total_amount ELSE 0 END) as ar_amount,
      SUM(total_amount) as total_amount,
      SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending_count,
      SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) as delivered_count
     FROM orders
     WHERE DATE(created_at) = CURDATE()`
  ) as any
  res.json(rows[0])
}
