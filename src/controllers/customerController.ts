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
  const {
    name, phone, address, district, note, deposit = 0, priceOverride,
    deliveryCycle = 'ON_CALL', deliveryDay, gasType = 'BOTTLED_20KG', cylindersHeld = 0,
    default_order_quantity, default_unit_price,
  } = req.body
  const [result] = await db.query(
    `INSERT INTO customers
      (name, phone, address, district, note, deposit, price_override, delivery_cycle, delivery_day,
       gas_type, cylinders_held, status, default_order_quantity, default_unit_price)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name, phone, address, district, note, deposit, priceOverride, deliveryCycle, deliveryDay,
      gasType, cylindersHeld, 'ACTIVE', default_order_quantity ?? null, default_unit_price ?? null,
    ]
  ) as any
  const customerId = result.insertId
  await db.query('INSERT INTO ar_balances (customer_id, amount_owed, cylinders_owed) VALUES (?, 0, 0)', [customerId])
  res.status(201).json({ id: customerId, name, phone })
}

export async function updateCustomer(req: Request, res: Response) {
  const id = Number(req.params.id)
  const fields = ['name', 'phone', 'phone2', 'address', 'district', 'note', 'deposit', 'price_override', 'delivery_cycle', 'delivery_day', 'gas_type', 'cylinders_held', 'status', 'default_order_quantity', 'default_unit_price']
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
  await db.query('DELETE FROM gas_returns WHERE customer_id = ?', [id])
  await db.query('DELETE FROM customers WHERE id = ?', [id])
  res.json({ ok: true })
}

// 合併客戶：預覽兩筆客戶的資料，讓使用者確認是不是同一人、資料合不合理，再決定要不要真的合併
export async function mergePreview(req: Request, res: Response) {
  const idA = Number(req.query.idA)
  const idB = Number(req.query.idB)
  if (!idA || !idB || idA === idB) return res.status(400).json({ error: '請提供兩個不同的客戶 id' })

  async function loadOne(id: number) {
    const [rows] = await db.query(
      'SELECT c.*, a.amount_owed, a.cylinders_owed FROM customers c LEFT JOIN ar_balances a ON a.customer_id = c.id WHERE c.id = ?',
      [id]
    ) as any
    if (!rows[0]) return null
    const [[orderCount]] = await db.query('SELECT COUNT(*) as cnt FROM orders WHERE customer_id = ?', [id]) as any
    const [[returnCount]] = await db.query('SELECT COUNT(*) as cnt FROM gas_returns WHERE customer_id = ?', [id]) as any
    const [[lineBound]] = await db.query('SELECT COUNT(*) as cnt FROM line_users WHERE customer_id = ?', [id]) as any
    const [lastOrders] = await db.query(
      'SELECT id, created_at, total_amount, status FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 3',
      [id]
    ) as any
    return {
      ...rows[0],
      orderCount: orderCount.cnt,
      returnCount: returnCount.cnt,
      lineBound: lineBound.cnt > 0,
      recentOrders: lastOrders,
    }
  }

  const [customerA, customerB] = await Promise.all([loadOne(idA), loadOne(idB)])
  if (!customerA || !customerB) return res.status(404).json({ error: '找不到其中一筆客戶' })

  res.json({ customerA, customerB })
}

// 合併客戶：把 mergeId 的訂單/退桶/欠款/LINE 綁定全部轉到 keepId，mergeId 標記停用
export async function mergeCustomers(req: Request, res: Response) {
  const { keepId, mergeId } = req.body
  const keep = Number(keepId)
  const merge = Number(mergeId)
  if (!keep || !merge || keep === merge) {
    return res.status(400).json({ error: 'keepId / mergeId 不可為空或相同' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.query('SELECT * FROM customers WHERE id IN (?, ?) FOR UPDATE', [keep, merge]) as any
    const keepCustomer = rows.find((r: any) => r.id === keep)
    const mergeCustomer = rows.find((r: any) => r.id === merge)
    if (!keepCustomer || !mergeCustomer) {
      await conn.rollback()
      return res.status(404).json({ error: '找不到其中一筆客戶' })
    }
    if (mergeCustomer.status === 'INACTIVE') {
      await conn.rollback()
      return res.status(400).json({ error: '這筆客戶已經是停用狀態，可能已經被合併過了' })
    }

    // 電話：被合併那筆的電話，補進保留客戶的空欄位（phone 優先，其次 phone2）
    if (mergeCustomer.phone && mergeCustomer.phone !== keepCustomer.phone && mergeCustomer.phone !== keepCustomer.phone2) {
      if (!keepCustomer.phone) {
        await conn.query('UPDATE customers SET phone = ? WHERE id = ?', [mergeCustomer.phone, keep])
      } else if (!keepCustomer.phone2) {
        await conn.query('UPDATE customers SET phone2 = ? WHERE id = ?', [mergeCustomer.phone, keep])
      }
    }
    // 地址：保留客戶是空的或是「（待補）」，就用被合併那筆補上
    if ((!keepCustomer.address || keepCustomer.address === '（待補）') && mergeCustomer.address) {
      await conn.query('UPDATE customers SET address = ? WHERE id = ?', [mergeCustomer.address, keep])
    }
    // 備註：兩邊都有備註且不一樣才合併寫入，避免蓋掉
    if (mergeCustomer.note && mergeCustomer.note !== keepCustomer.note) {
      const combinedNote = keepCustomer.note ? `${keepCustomer.note} / ${mergeCustomer.note}` : mergeCustomer.note
      await conn.query('UPDATE customers SET note = ? WHERE id = ?', [combinedNote, keep])
    }

    // 訂單、退桶、LINE 綁定全部轉到保留客戶
    await conn.query('UPDATE orders SET customer_id = ? WHERE customer_id = ?', [keep, merge])
    await conn.query('UPDATE gas_returns SET customer_id = ? WHERE customer_id = ?', [keep, merge])
    await conn.query('UPDATE line_users SET customer_id = ? WHERE customer_id = ?', [keep, merge])

    // 欠款/欠桶：兩邊金額加總到保留客戶，被合併那筆的 ar_balances 刪除
    const [[mergeAr]] = await conn.query('SELECT amount_owed, cylinders_owed FROM ar_balances WHERE customer_id = ?', [merge]) as any
    if (mergeAr) {
      await conn.query(
        'UPDATE ar_balances SET amount_owed = amount_owed + ?, cylinders_owed = cylinders_owed + ? WHERE customer_id = ?',
        [mergeAr.amount_owed, mergeAr.cylinders_owed, keep]
      )
      await conn.query('DELETE FROM ar_balances WHERE customer_id = ?', [merge])
    }

    // 被合併的客戶標記停用，備註留下稽核紀錄，不做實體刪除（可回頭查證/還原）
    await conn.query(
      `UPDATE customers SET status = 'INACTIVE', note = CONCAT(COALESCE(note, ''), ?) WHERE id = ?`,
      [`\n[已於 ${new Date().toISOString().slice(0, 10)} 合併至客戶 #${keep}]`, merge]
    )

    await conn.commit()
    res.json({ ok: true, keepId: keep, mergeId: merge })
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
}
