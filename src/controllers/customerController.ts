import { Request, Response } from 'express'
import { db } from '../lib/db'

export async function listCustomers(req: Request, res: Response) {
  const { status, district, search, page = '1', limit = '20' } = req.query
  const conditions: string[] = []
  const params: any[] = []

  if (status) { conditions.push('c.status = ?'); params.push(status) }
  if (district) { conditions.push('c.district = ?'); params.push(district) }
  if (search) {
    conditions.push('(c.name LIKE ? OR c.phone LIKE ? OR c.address LIKE ?)')
    params.push(`%${search}%`, `%${search}%`, `%${search}%`)
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const offset = (Number(page) - 1) * Number(limit)

  const [customers] = await db.query(
    `SELECT c.*, a.amount_owed, a.cylinders_owed FROM customers c LEFT JOIN ar_balances a ON a.customer_id = c.id ${where} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
    [...params, Number(limit), offset]
  ) as any

  const [countRows] = await db.query(`SELECT COUNT(*) as total FROM customers c ${where}`, params) as any
  res.json({ customers, total: countRows[0].total, page: Number(page), limit: Number(limit) })
}

export async function getCustomer(req: Request, res: Response) {
  const id = Number(req.params.id)
  const [rows] = await db.query(
    'SELECT c.*, a.amount_owed, a.cylinders_owed FROM customers c LEFT JOIN ar_balances a ON a.customer_id = c.id WHERE c.id = ?',
    [id]
  ) as any
  if (!rows[0]) return res.status(404).json({ error: '客戶不存在' })
  const [orders] = await db.query('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10', [id]) as any
  res.json({ ...rows[0], orders })
}

export async function createCustomer(req: Request, res: Response) {
  const { name, phone, address, district, note, deposit = 0, priceOverride, deliveryCycle = 'ON_CALL', deliveryDay, gasType = 'BOTTLED_20KG', cylindersHeld = 0 } = req.body
  const [result] = await db.query(
    'INSERT INTO customers (name, phone, address, district, note, deposit, price_override, delivery_cycle, delivery_day, gas_type, cylinders_held, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [name, phone, address, district, note, deposit, priceOverride, deliveryCycle, deliveryDay, gasType, cylindersHeld, 'ACTIVE']
  ) as any
  const customerId = result.insertId
  await db.query('INSERT INTO ar_balances (customer_id, amount_owed, cylinders_owed) VALUES (?, 0, 0)', [customerId])
  res.status(201).json({ id: customerId, name, phone })
}

export async function updateCustomer(req: Request, res: Response) {
  const id = Number(req.params.id)
  const fields = ['name', 'phone', 'phone2', 'address', 'district', 'note', 'deposit', 'price_override', 'delivery_cycle', 'delivery_day', 'gas_type', 'cylinders_held', 'status']
  const updates: string[] = []
  const params: any[] = []
  const body: any = req.body
  for (const f of fields) {
    const key = f.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    if (body[key] !== undefined) { updates.push(`${f} = ?`); params.push(body[key]) }
    else if (body[f] !== undefined) { updates.push(`${f} = ?`); params.push(body[f]) }
  }
  if (!updates.length) return res.status(400).json({ error: '沒有要更新的欄位' })
  params.push(id)
  await db.query(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`, params)
  res.json({ ok: true })
}

export async function deleteCustomer(req: Request, res: Response) {
  await db.query('UPDATE customers SET status = ? WHERE id = ?', ['INACTIVE', Number(req.params.id)])
  res.json({ ok: true })
}
export async function deactivateCustomer(req: Request, res: Response) {
  await db.query('UPDATE customers SET status = ? WHERE id = ?', ['INACTIVE', Number(req.params.id)])
  res.json({ ok: true })
}

export async function hardDeleteCustomer(req: Request, res: Response) {
  const id = Number(req.params.id)
  const [orders] = await db.query('SELECT COUNT(*) as cnt FROM orders WHERE customer_id = ?', [id]) as any
  if (orders[0].cnt > 0) {
    return res.status(400).json({ error: `此客戶有 ${orders[0].cnt} 筆訂單記錄，無法刪除。請改用停用。` })
  }
  await db.query('DELETE FROM ar_balances WHERE customer_id = ?', [id])
  await db.query('DELETE FROM customers WHERE id = ?', [id])
  res.json({ ok: true })
}
