import { Request, Response } from 'express'
import { db } from '../lib/db'

// 取得客戶存氣記錄
export async function getCustomerReturns(req: Request, res: Response) {
  const customerId = Number(req.params.customerId)
  const [rows] = await db.query(
    `SELECT gr.*, o.created_at as order_date
     FROM gas_returns gr
     LEFT JOIN orders o ON o.id = gr.order_id
     WHERE gr.customer_id = ?
     ORDER BY gr.created_at DESC
     LIMIT 10`,
    [customerId]
  ) as any
  res.json({ returns: rows })
}

// 新增存氣記錄
export async function createReturn(req: Request, res: Response) {
  const { customerId, orderId, cylinderType, remainingKg, action, amount, note } = req.body
  if (!customerId || !remainingKg) {
    return res.status(400).json({ error: '缺少必要欄位' })
  }

  const [result] = await db.query(
    `INSERT INTO gas_returns (customer_id, order_id, cylinder_type, remaining_kg, action, amount, note, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [customerId, orderId || null, cylinderType || 'BOTTLED_20KG', remainingKg, action || 'RECORD', amount || 0, note || null, action === 'RECORD' ? 'DONE' : 'PENDING']
  ) as any

  res.status(201).json({ id: (result as any).insertId })
}

// 標記存氣已處理
export async function resolveReturn(req: Request, res: Response) {
  const id = Number(req.params.id)
  await db.query(`UPDATE gas_returns SET status = 'DONE' WHERE id = ?`, [id])
  res.json({ ok: true })
}

// 取得客戶待處理存氣（接單時顯示用）
// 顯示：PENDING 的，以及最近 30 天內的 RECORD
export async function getPendingReturns(req: Request, res: Response) {
  const customerId = Number(req.params.customerId)
  const [rows] = await db.query(
    `SELECT * FROM gas_returns
     WHERE customer_id = ?
       AND (status = 'PENDING' OR (action = 'RECORD' AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)))
     ORDER BY created_at DESC
     LIMIT 3`,
    [customerId]
  ) as any
  res.json({ returns: rows })
}
