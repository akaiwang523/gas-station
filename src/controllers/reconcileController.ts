import { Request, Response } from 'express'
import { db } from '../lib/db'

// 每日對帳：拿紙本出貨單逐張核對系統裡的訂單。
//
// 背景：來電會自動進單、訂單常被一次按完成，所以 DELIVERED 只代表「被按掉」，
// 不代表真的有送。紙本出貨單才是真正的依據——有出貨單的單標記 verified_at，
// 沒有出貨單的單直接作廢。之後報表／預測要判斷「真的訂單」，看 verified_at 就好。
//
// 歸屬日跟報表一致：有排定日用排定日，沒有就用建立時間（轉台北時區）
const ORDER_DATE_SQL = `DATE(COALESCE(o.scheduled_date, CONVERT_TZ(o.created_at, '+00:00', '+08:00')))`

function parseIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  return raw.map(Number).filter((n) => Number.isInteger(n) && n > 0)
}

// GET /api/reconcile?date=YYYY-MM-DD
export async function getReconcileDay(req: Request, res: Response) {
  const date = String(req.query.date || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '日期格式錯誤' })

  const [rows] = await db.query(
    `SELECT o.id, o.status, o.source, o.payment_type, o.total_amount, o.note, o.verified_at,
            o.created_at, o.scheduled_date,
            c.id AS customer_id, c.name AS customer_name, c.address AS customer_address, c.phone AS customer_phone,
            (SELECT COUNT(*) FROM payments p WHERE p.order_id = o.id) AS payment_count
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.status <> 'CANCELLED' AND ${ORDER_DATE_SQL} = ?
     ORDER BY o.created_at ASC`,
    [date]
  ) as any

  let itemsByOrder: Record<number, any[]> = {}
  if (rows.length > 0) {
    const ids = rows.map((r: any) => r.id)
    const [items] = await db.query(
      `SELECT id, order_id, gas_type, quantity, unit_price, subtotal FROM order_items
       WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
      ids
    ) as any
    for (const it of items) {
      (itemsByOrder[it.order_id] ||= []).push({
        id: it.id,
        gasType: it.gas_type,
        quantity: Number(it.quantity),
        unitPrice: Number(it.unit_price),
        subtotal: Number(it.subtotal),
      })
    }
  }

  const orders = rows.map((r: any) => ({
    id: r.id,
    status: r.status,
    source: r.source,
    paymentType: r.payment_type,
    totalAmount: Number(r.total_amount),
    note: r.note,
    verifiedAt: r.verified_at,
    createdAt: r.created_at,
    hasPayment: Number(r.payment_count) > 0,
    customer: {
      id: r.customer_id,
      name: r.customer_name,
      address: r.customer_address,
      phone: r.customer_phone,
    },
    items: itemsByOrder[r.id] || [],
  }))

  return res.json({ date, orders })
}

// POST /api/reconcile/verify   body: { ids: number[], verified: boolean }
// 打勾／取消打勾「有出貨單」
export async function setVerified(req: Request, res: Response) {
  const ids = parseIds(req.body?.ids)
  if (ids.length === 0) return res.status(400).json({ error: 'ids required' })
  const verified = req.body?.verified !== false

  const [result] = await db.query(
    verified
      ? `UPDATE orders SET verified_at = NOW() WHERE id IN (${ids.map(() => '?').join(',')}) AND verified_at IS NULL AND status <> 'CANCELLED'`
      : `UPDATE orders SET verified_at = NULL WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids
  ) as any

  return res.json({ ok: true, updated: result.affectedRows ?? 0 })
}

// POST /api/reconcile/void   body: { ids: number[] }
// 沒有出貨單的訂單作廢。跟一般「取消」不同：已完成（DELIVERED）的也可以作廢，
// 因為這裡的 DELIVERED 本來就不可信。欠帳單會把 ar_balances 扣回去（跟 cancelOrder 一樣）。
// 保護：已經對過帳、或已經有收款紀錄的單不作廢，回傳給前端提示
export async function voidUnverified(req: Request, res: Response) {
  const ids = parseIds(req.body?.ids)
  if (ids.length === 0) return res.status(400).json({ error: 'ids required' })

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })
  const voided: number[] = []
  const skipped: { id: number; reason: string }[] = []

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.query(
      `SELECT o.*, (SELECT COUNT(*) FROM payments p WHERE p.order_id = o.id) AS payment_count
       FROM orders o WHERE o.id IN (${ids.map(() => '?').join(',')}) FOR UPDATE`,
      ids
    ) as any

    for (const order of rows) {
      if (order.status === 'CANCELLED') continue
      if (order.verified_at) { skipped.push({ id: order.id, reason: '已對過帳' }); continue }
      if (Number(order.payment_count) > 0) { skipped.push({ id: order.id, reason: '有收款紀錄' }); continue }

      if (order.payment_type === 'AR') {
        await conn.query(
          `UPDATE ar_balances SET amount_owed = amount_owed - ?, cylinders_owed = cylinders_owed - ? WHERE customer_id = ?`,
          [order.total_amount, order.quantity, order.customer_id]
        )
      }
      await conn.query(
        `UPDATE orders SET status = 'CANCELLED', note = CONCAT(COALESCE(note, ''), ?) WHERE id = ?`,
        [`（${today} 對帳：無出貨單，作廢）`, order.id]
      )
      voided.push(order.id)
    }

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }

  return res.json({ ok: true, voided, skipped })
}
