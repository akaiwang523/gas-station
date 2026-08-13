import { Request, Response } from 'express'
import { db } from '../lib/db'
import { normalizePhone, PHONE_MATCH_SQL, phoneMatchParams } from '../lib/phone'

// 查這支電話目前是不是已經登記在別的（非停用）客戶身上——
// 手動新增/編輯客戶時要用這個擋下「同一支電話重複建檔」，理由跟來電比對一樣：
// 「白妞文賢」跟孤兒客戶「來電 0983779091」共用同一支電話，就是因為當初新增客戶
// 完全沒做這個檢查。excludeId 是編輯時排除自己，不然自己跟自己比對永遠會撞到。
async function findPhoneOwner(normalized: string, excludeId?: number): Promise<{ id: number; name: string } | null> {
  const excludeClause = excludeId ? 'AND c.id != ?' : ''
  const params = excludeId ? [...phoneMatchParams(normalized), excludeId] : phoneMatchParams(normalized)
  const [rows] = await db.query(
    `SELECT c.id, c.name FROM customers c WHERE ${PHONE_MATCH_SQL} AND c.status != 'INACTIVE' ${excludeClause} LIMIT 1`,
    params
  ) as any
  return rows[0] || null
}

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
  const [fixedItems] = await db.query(
    'SELECT id, gas_type as gasType, quantity FROM customer_fixed_items WHERE customer_id = ? ORDER BY id ASC',
    [id]
  ) as any
  const [extraPhoneRows] = await db.query(
    'SELECT phone FROM customer_phones WHERE customer_id = ? ORDER BY id ASC',
    [id]
  ) as any
  const extraPhones = extraPhoneRows.map((r: any) => r.phone)
  res.json({ ...rows[0], orders, fixedItems, extraPhones })
}

// 固定配送品項整批換新：先刪掉這位客戶原本的品項，再依傳入的清單重新寫入，
// 跟訂單品項（order_items）的「整批換新」是同一種寫法。傳空陣列或不是固定配送就等於清空
async function replaceFixedItems(customerId: number, fixedItems: any) {
  await db.query('DELETE FROM customer_fixed_items WHERE customer_id = ?', [customerId])
  if (!Array.isArray(fixedItems)) return
  for (const it of fixedItems) {
    const gasType = it.gasType || it.gas_type
    const quantity = Number(it.quantity)
    if (!gasType || !quantity || quantity <= 0) continue
    await db.query(
      'INSERT INTO customer_fixed_items (customer_id, gas_type, quantity) VALUES (?, ?, ?)',
      [customerId, gasType, quantity]
    )
  }
}

// 額外電話整批換新（跟固定配送品項同一種寫法）：一間店可能有兩支以上的電話
// （例如同一店家的市話＋兩支員工手機），phone/phone2 兩個固定欄位裝不下，
// 這裡用一張獨立表存「第三支以後」的電話，數量不限。
// 傳進來前後端都不做去重，這裡統一 normalize + 去重 + 去掉空字串
async function replaceExtraPhones(customerId: number, extraPhones: any) {
  await db.query('DELETE FROM customer_phones WHERE customer_id = ?', [customerId])
  if (!Array.isArray(extraPhones)) return
  const seen = new Set<string>()
  for (const raw of extraPhones) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const phone = normalizePhone(raw.trim())
    if (!phone || seen.has(phone)) continue
    seen.add(phone)
    await db.query(
      'INSERT INTO customer_phones (customer_id, phone) VALUES (?, ?)',
      [customerId, phone]
    )
  }
}

export async function createCustomer(req: Request, res: Response) {
  const {
    name, phone, phone2, address, district, note, deposit = 0, priceOverride,
    deliveryCycle = 'ON_CALL', deliveryDay, gasType = 'BOTTLED_20KG', customerType, cylindersHeld = 0,
    default_order_quantity, default_unit_price, fixedItems, extraPhones,
  } = req.body
  // 電話存進資料庫前一律 normalize，跟接電話比對用的格式保持一致——
  // 否則例如手key「0912-345-678」跟來電比對到的「0912345678」會被當成兩支不同號碼
  const normalizedPhone = phone ? normalizePhone(phone) : phone
  const normalizedPhone2 = phone2 ? normalizePhone(phone2) : (phone2 ?? null)

  // 新增前先查電話有沒有被別的客戶佔用——同一人開兩間店共用電話是合法情境，
  // 所以這裡不是硬擋，而是要求前端跳確認、staff 明確按下「仍要新增」（confirmDuplicate）才放行，
  // 避免的是像「來電 0983779091」那樣沒人注意到就悄悄建出一筆重複客戶
  if (!req.body.confirmDuplicate) {
    const owner = normalizedPhone ? await findPhoneOwner(normalizedPhone) : null
    const owner2 = !owner && normalizedPhone2 ? await findPhoneOwner(normalizedPhone2) : null
    const dup = owner || owner2
    if (dup) {
      return res.status(409).json({
        error: `這支電話已經登記在「${dup.name}」名下，確定要新增新客戶嗎？`,
        duplicate: dup,
      })
    }
  }

  const [result] = await db.query(
    `INSERT INTO customers
      (name, phone, phone2, address, district, note, deposit, price_override, delivery_cycle, delivery_day,
       gas_type, customer_type, cylinders_held, status, default_order_quantity, default_unit_price)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name, normalizedPhone, normalizedPhone2, address, district, note, deposit, priceOverride, deliveryCycle, deliveryDay,
      gasType, customerType || 'UNKNOWN', cylindersHeld, 'ACTIVE', default_order_quantity ?? null, default_unit_price ?? null,
    ]
  ) as any
  const customerId = result.insertId
  await db.query('INSERT INTO ar_balances (customer_id, amount_owed, cylinders_owed) VALUES (?, 0, 0)', [customerId])
  if (deliveryCycle === 'WEEKLY' || deliveryCycle === 'MONTHLY_FIXED') {
    await replaceFixedItems(customerId, fixedItems)
  }
  if (Array.isArray(extraPhones)) {
    await replaceExtraPhones(customerId, extraPhones)
  }
  res.status(201).json({ id: customerId, name, phone: normalizedPhone })
}

export async function updateCustomer(req: Request, res: Response) {
  const id = Number(req.params.id)
  const fields = ['name', 'phone', 'phone2', 'address', 'district', 'note', 'deposit', 'price_override', 'delivery_cycle', 'delivery_day', 'gas_type', 'customer_type', 'cylinders_held', 'status', 'default_order_quantity', 'default_unit_price']
  const updates: string[] = []
  const params: any[] = []
  const body: any = req.body

  // 只有真的要「改成一個新號碼」才需要查重複；沒改、或改成的號碼本來就是自己已有的，
  // 都不用查（不然自己編輯自己會一直被自己擋下來）
  if (!body.confirmDuplicate && (body.phone || body.phone2)) {
    const [existingRows] = await db.query('SELECT phone, phone2 FROM customers WHERE id = ?', [id]) as any
    const existing = existingRows[0]
    for (const f of ['phone', 'phone2'] as const) {
      const raw = body[f]
      if (typeof raw !== 'string' || !raw) continue
      const normalized = normalizePhone(raw)
      if (existing && (normalized === existing.phone || normalized === existing.phone2)) continue
      const dup = await findPhoneOwner(normalized, id)
      if (dup) {
        return res.status(409).json({
          error: `這支電話已經登記在「${dup.name}」名下，確定要儲存嗎？`,
          duplicate: dup,
        })
      }
    }
  }

  for (const f of fields) {
    const key = f.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    let value = body[key] !== undefined ? body[key] : (body[f] !== undefined ? body[f] : undefined)
    if (value === undefined) continue
    // 電話欄位一律 normalize 再存，理由同 createCustomer
    if ((f === 'phone' || f === 'phone2') && typeof value === 'string' && value) {
      value = normalizePhone(value)
    }
    updates.push(`${f} = ?`)
    params.push(value)
  }
  if (updates.length) {
    params.push(id)
    await db.query(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`, params)
  }
  // fixedItems 有帶才處理：固定配送客戶（WEEKLY/MONTHLY_FIXED）整批換新品項；
  // 取消固定配送（切回 ON_CALL）時，body 會帶空陣列或 delivery_cycle=ON_CALL，兩種都清空品項
  if (body.fixedItems !== undefined) {
    const cycle = body.delivery_cycle ?? body.deliveryCycle
    await replaceFixedItems(id, cycle === 'WEEKLY' || cycle === 'MONTHLY_FIXED' ? body.fixedItems : [])
  }
  // extraPhones 有帶才處理：第三支以後的電話整批換新
  if (body.extraPhones !== undefined) {
    await replaceExtraPhones(id, body.extraPhones)
  }
  if (!updates.length && body.fixedItems === undefined && body.extraPhones === undefined) {
    return res.status(400).json({ error: '沒有要更新的欄位' })
  }
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

    // 電話：被合併那筆的電話，補進保留客戶的空欄位（phone 優先、其次 phone2，
    // 兩個固定欄位都滿了就放進 customer_phones，不會再像以前那樣直接被丟掉）
    if (mergeCustomer.phone && mergeCustomer.phone !== keepCustomer.phone && mergeCustomer.phone !== keepCustomer.phone2) {
      if (!keepCustomer.phone) {
        await conn.query('UPDATE customers SET phone = ? WHERE id = ?', [mergeCustomer.phone, keep])
      } else if (!keepCustomer.phone2) {
        await conn.query('UPDATE customers SET phone2 = ? WHERE id = ?', [mergeCustomer.phone, keep])
      } else {
        await conn.query(
          'INSERT IGNORE INTO customer_phones (customer_id, phone) VALUES (?, ?)',
          [keep, mergeCustomer.phone]
        )
      }
    }
    // 被合併那筆自己額外掛的電話（customer_phones），全部轉到保留客戶身上
    await conn.query(
      `INSERT IGNORE INTO customer_phones (customer_id, phone)
       SELECT ?, phone FROM customer_phones WHERE customer_id = ?`,
      [keep, merge]
    )
    await conn.query('DELETE FROM customer_phones WHERE customer_id = ?', [merge])
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
