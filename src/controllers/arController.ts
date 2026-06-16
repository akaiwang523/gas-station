import { Request, Response } from 'express'
import { db } from '../lib/db'

// 欠帳客戶列表（支援月份篩選）
export async function listArBalances(req: Request, res: Response) {
  const { search, month, tab } = req.query
  const conditions = tab === 'paid' ? ['a.amount_owed <= 0'] : ['a.amount_owed > 0']
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

  // 如果有月份篩選，額外查該月有欠帳的客戶
  if (month) {
    const [monthRows] = await db.query(
      `SELECT DISTINCT o.customer_id, c.name as customer_name, c.phone as customer_phone, c.address as customer_address,
        SUM(o.total_amount) as month_amount,
        SUM(o.quantity) as month_cylinders
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       JOIN ar_balances a ON a.customer_id = o.customer_id
       WHERE o.payment_type = 'AR'
         AND DATE_FORMAT(o.created_at, '%Y-%m') = ?
         AND a.amount_owed > 0
       GROUP BY o.customer_id, c.name, c.phone, c.address
       ORDER BY month_amount DESC`,
      [month]
    ) as any
    return res.json({ balances: rows, monthBalances: monthRows, month })
  }

  res.json({ balances: rows })
}

// 月份收款摘要
export async function getMonthSummary(req: Request, res: Response) {
  const { month } = req.query
  const targetMonth = month || new Date().toISOString().slice(0, 7)

  // 該月有送貨的欠帳客戶
  const [total] = await db.query(
    `SELECT COUNT(DISTINCT o.customer_id) as total
     FROM orders o
     WHERE o.payment_type = 'AR' AND DATE_FORMAT(o.created_at, '%Y-%m') = ? AND o.status != 'CANCELLED'`,
    [targetMonth]
  ) as any

  // 該月有送貨且已收款（本月有收款記錄）的客戶
  const [paid] = await db.query(
    `SELECT COUNT(DISTINCT o.customer_id) as paid
     FROM orders o
     JOIN payments p ON p.order_id = o.id
     WHERE o.payment_type = 'AR' AND DATE_FORMAT(o.created_at, '%Y-%m') = ? AND o.status != 'CANCELLED'`,
    [targetMonth]
  ) as any

  // 該月欠帳總額
  const [amount] = await db.query(
    `SELECT SUM(o.total_amount) as total_amount
     FROM orders o
     WHERE o.payment_type = 'AR' AND DATE_FORMAT(o.created_at, '%Y-%m') = ? AND o.status != 'CANCELLED'`,
    [targetMonth]
  ) as any

  res.json({
    month: targetMonth,
    total_customers: Number(total[0].total || 0),
    paid_customers: Number(paid[0].paid || 0),
    pending_customers: Number(total[0].total || 0) - Number(paid[0].paid || 0),
    total_amount: Number(amount[0].total_amount || 0),
  })
}

// 客戶欠帳明細（含月份分組）
export async function getCustomerAr(req: Request, res: Response) {
  const customerId = Number(req.params.customerId)

  const [balanceRows] = await db.query(
    `SELECT a.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address
     FROM ar_balances a JOIN customers c ON c.id = a.customer_id
     WHERE a.customer_id = ?`,
    [customerId]
  ) as any

  // 按月份分組的欠帳訂單
  const [monthlyOrders] = await db.query(
    `SELECT 
      DATE_FORMAT(created_at, '%Y-%m') as month,
      DATE_FORMAT(created_at, '%Y年%m月') as month_label,
      COUNT(*) as order_count,
      SUM(quantity) as total_cylinders,
      SUM(total_amount) as total_amount,
      SUM(CASE WHEN status = 'DELIVERED' THEN 0 ELSE total_amount END) as unpaid_amount
     FROM orders
     WHERE customer_id = ? AND payment_type = 'AR'
     GROUP BY DATE_FORMAT(created_at, '%Y-%m'), DATE_FORMAT(created_at, '%Y年%m月')
     ORDER BY month DESC`,
    [customerId]
  ) as any

  // 所有訂單明細
  const [orders] = await db.query(
    `SELECT o.*, oi.gas_type, oi.quantity as item_qty, oi.unit_price as item_price, oi.subtotal
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.customer_id = ? AND o.payment_type = 'AR'
     ORDER BY o.created_at DESC
     LIMIT 100`,
    [customerId]
  ) as any

  // 收款記錄
  const [payments] = await db.query(
    `SELECT p.*, u.name as collector_name
     FROM payments p
     JOIN orders o ON o.id = p.order_id
     JOIN users u ON u.id = p.collected_by
     WHERE o.customer_id = ?
     ORDER BY p.paid_at DESC
     LIMIT 30`,
    [customerId]
  ) as any

  res.json({ balance: balanceRows[0] || null, monthlyOrders, orders, payments })
}

// 產生對帳單
export async function getStatement(req: Request, res: Response) {
  const customerId = Number(req.params.customerId)
  const { month } = req.query

  const [customerRows] = await db.query(
    `SELECT c.*, a.amount_owed, a.cylinders_owed
     FROM customers c
     LEFT JOIN ar_balances a ON a.customer_id = c.id
     WHERE c.id = ?`,
    [customerId]
  ) as any
  const customer = customerRows[0]
  if (!customer) return res.status(404).json({ error: '客戶不存在' })

  let orderWhere = 'o.customer_id = ? AND o.payment_type = "AR"'
  const params: any[] = [customerId]
  if (month) {
    orderWhere += ' AND DATE_FORMAT(o.created_at, "%Y-%m") = ?'
    params.push(month)
  }

  const [orders] = await db.query(
    `SELECT o.created_at, o.quantity, o.total_amount, o.status, o.note,
      GROUP_CONCAT(CONCAT(oi.gas_type,'x',oi.quantity,'@',oi.unit_price) SEPARATOR ',') as items_str
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE ${orderWhere}
     GROUP BY o.id
     ORDER BY o.created_at ASC`,
    params
  ) as any

  const [payments] = await db.query(
    `SELECT p.paid_at, p.amount, p.method, p.note
     FROM payments p
     JOIN orders o ON o.id = p.order_id
     WHERE o.customer_id = ?
     ${month ? 'AND DATE_FORMAT(p.paid_at, "%Y-%m") = ?' : ''}
     ORDER BY p.paid_at ASC`,
    month ? [customerId, month] : [customerId]
  ) as any

  const totalOrders = orders.reduce((s: number, o: any) => s + Number(o.total_amount), 0)
  const totalPaid = payments.reduce((s: number, p: any) => s + Number(p.amount), 0)

  res.json({
    customer,
    orders,
    payments,
    summary: {
      total_orders: totalOrders,
      total_paid: totalPaid,
      balance: Number(customer.amount_owed),
      month: month || null,
    }
  })
}

// 收款
export async function receivePayment(req: Request, res: Response) {
  const customerId = Number(req.params.customerId)
  const { amount, method = 'CASH', note } = req.body
  const collectedBy = (req as any).user.id

  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: '金額有誤' })
  }

  // 找最舊的 AR 訂單來掛收款記錄
  const [orderRows] = await db.query(
    `SELECT id FROM orders WHERE customer_id = ? AND payment_type = 'AR'
     ORDER BY created_at ASC LIMIT 1`,
    [customerId]
  ) as any

  const orderId = orderRows[0]?.id

  if (orderId) {
    // 有訂單就掛收款記錄
    await db.query(
      `INSERT INTO payments (order_id, collected_by, amount, method, note) VALUES (?, ?, ?, ?, ?)`,
      [orderId, collectedBy, amount, method, note || null]
    )
  }

  // 直接更新 ar_balances（不管有沒有訂單都執行）
  await db.query(
    `UPDATE ar_balances SET amount_owed = amount_owed - ?, last_payment = NOW() WHERE customer_id = ?`,
    [amount, customerId]
  )

  res.json({ ok: true })
}
