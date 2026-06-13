import { Request, Response } from 'express'
import { db } from '../lib/db'

// 取得欠帳客戶列表
export async function listArBalances(req: Request, res: Response) {
  const { search } = req.query
  const conditions = ['a.amount_owed > 0']
  const params: any[] = []

  if (search) {
    conditions.push('(c.name LIKE ? OR c.phone LIKE ?)')
    params.push(`%${search}%`, `%${search}%`)
  }

  const [rows] = await db.query(
    `SELECT a.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address
     FROM ar_balances a
     JOIN customers c ON c.id = a.customer_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.amount_owed DESC`,
    params
  ) as any
  res.json({ balances: rows })
}

// 取得單一客戶欠帳明細
export async function getCustomerAr(req: Request, res: Response) {
  const customerId = Number(req.params.customerId)

  const [balanceRows] = await db.query(
    `SELECT a.*, c.name as customer_name, c.phone as customer_phone
     FROM ar_balances a JOIN customers c ON c.id = a.customer_id
     WHERE a.customer_id = ?`,
    [customerId]
  ) as any

  const [orders] = await db.query(
    `SELECT o.*, 
      (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.order_id = o.id) as paid_amount
     FROM orders o
     WHERE o.customer_id = ? AND o.payment_type = 'AR'
     ORDER BY o.created_at DESC
     LIMIT 30`,
    [customerId]
  ) as any

  const [payments] = await db.query(
    `SELECT p.*, u.name as collector_name
     FROM payments p
     JOIN orders o ON o.id = p.order_id
     JOIN users u ON u.id = p.collected_by
     WHERE o.customer_id = ?
     ORDER BY p.paid_at DESC
     LIMIT 20`,
    [customerId]
  ) as any

  res.json({ balance: balanceRows[0] || null, orders, payments })
}

// 收款（針對客戶整體欠款，不綁定單筆訂單）
export async function receivePayment(req: Request, res: Response) {
  const customerId = Number(req.params.customerId)
  const { amount, method = 'CASH', note } = req.body
  const collectedBy = (req as any).user.id

  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: '金額有誤' })
  }

  // 找最舊未結清的 AR 訂單來掛收款
  const [orderRows] = await db.query(
    `SELECT id FROM orders WHERE customer_id = ? AND payment_type = 'AR' AND status != 'DELIVERED'
     ORDER BY created_at ASC LIMIT 1`,
    [customerId]
  ) as any

  let orderId = orderRows[0]?.id

  // 如果沒有未結清訂單，就掛在最新的 AR 訂單
  if (!orderId) {
    const [latestRows] = await db.query(
      `SELECT id FROM orders WHERE customer_id = ? AND payment_type = 'AR'
       ORDER BY created_at DESC LIMIT 1`,
      [customerId]
    ) as any
    orderId = latestRows[0]?.id
  }

  if (!orderId) return res.status(400).json({ error: '找不到欠帳訂單' })

  await db.query(
    `INSERT INTO payments (order_id, collected_by, amount, method, note) VALUES (?, ?, ?, ?, ?)`,
    [orderId, collectedBy, amount, method, note || null]
  )

  await db.query(
    `UPDATE ar_balances SET amount_owed = amount_owed - ?, last_payment = NOW() WHERE customer_id = ?`,
    [amount, customerId]
  )

  res.json({ ok: true })
}
