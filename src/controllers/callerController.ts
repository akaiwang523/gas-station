import { Request, Response } from 'express'
import { db } from '../lib/db'

function normalizePhone(raw: string): string {
  let p = raw.replace(/[\s\-().]/g, '')
  if (p.startsWith('+886')) p = '0' + p.slice(4)
  if (p.startsWith('886') && p.length >= 10) p = '0' + p.slice(3)
  return p
}

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

  // 這支號碼現在建檔了，把陌生來電紀錄標記已處理
  await db.query(
    `UPDATE unknown_calls SET status = 'HANDLED', handled_at = NOW() WHERE phone = ? AND status = 'PENDING'`,
    [normalized]
  )

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
    // 陌生號碼，寫進資料庫（同號碼重複來電只累加次數，不重複建列）
    const [existingUnknown] = await db.query(
      `SELECT id FROM unknown_calls WHERE phone = ? AND status = 'PENDING' LIMIT 1`,
      [normalized]
    ) as any

    if (existingUnknown[0]) {
      await db.query(
        `UPDATE unknown_calls SET last_called_at = NOW(), call_count = call_count + 1 WHERE id = ?`,
        [existingUnknown[0].id]
      )
    } else {
      await db.query(
        `INSERT INTO unknown_calls (phone, status) VALUES (?, 'PENDING')`,
        [normalized]
      )
    }

    return res.json({ found: false, phone: normalized, draft: null })
  }

  // 這支號碼現在找到客戶了，把之前的陌生來電紀錄標記已處理
  await db.query(
    `UPDATE unknown_calls SET status = 'HANDLED', handled_at = NOW() WHERE phone = ? AND status = 'PENDING'`,
    [normalized]
  )

  const c = rows[0]

  // 同一客戶若已經有一筆尚未處理的草稿單，就不重複建單，沿用既有那筆
  const [existingDrafts] = await db.query(
    `SELECT id FROM orders WHERE customer_id = ? AND status = 'DRAFT' ORDER BY created_at DESC LIMIT 1`,
    [c.id]
  ) as any

  let draftId: number

  if (existingDrafts[0]) {
    draftId = existingDrafts[0].id
    // 標記為「再次來電」，更新時間，內容維持原樣讓司機自己確認
    await db.query(
      `UPDATE orders SET note = CONCAT(COALESCE(note, ''), '（再次來電 ', ?, '）'), updated_at = NOW() WHERE id = ?`,
      [new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' }), draftId]
    )
  } else {
    // 抓上一次「已送達」訂單的所有品項（原本用 JOIN + LIMIT 1，品項多筆時 JOIN 出多列會被 LIMIT 1 直接砍到只剩第一項，
    // 導致客戶明明訂 20kg+16kg 兩種，草稿卻只帶出其中一種——這裡先只鎖定訂單本身，再單獨撈出該筆訂單底下的全部品項）
    const [lastOrderRows] = await db.query(
      `SELECT id FROM orders WHERE customer_id = ? AND status = 'DELIVERED' ORDER BY created_at DESC LIMIT 1`,
      [c.id]
    ) as any
    const lastOrderId = lastOrderRows[0]?.id

    let lastItems: { gas_type: string; quantity: number }[] = []
    if (lastOrderId) {
      const [itemRows] = await db.query(
        `SELECT gas_type, quantity FROM order_items WHERE order_id = ?`,
        [lastOrderId]
      ) as any
      lastItems = itemRows
    }

    // 單價一律用「客戶目前該有的正確單價」：有特殊單價就用特殊單價，沒有就用目前的基準價，
    // 不用上一單當時的歷史成交價（避免基準價調整後，草稿還帶出舊價格）
    const [baselineRows] = await db.query(
      `SELECT \`key\`, \`value\` FROM settings WHERE \`key\` LIKE 'baseline_price_%'`
    ) as any
    const baselinePrice: Record<string, number> = {}
    for (const row of baselineRows) {
      baselinePrice[row.key.replace('baseline_price_', '')] = Number(row.value)
    }

    const draftItems = lastItems.length > 0
      ? lastItems.map((i) => ({
          gasType: i.gas_type,
          quantity: i.quantity,
          unitPrice: c.price_override || baselinePrice[i.gas_type] || 800,
        }))
      : [{
          gasType: c.gas_type || 'BOTTLED_20KG',
          quantity: 1,
          unitPrice: c.price_override || baselinePrice[c.gas_type] || baselinePrice.BOTTLED_20KG || 800,
        }]

    const totalAmount = draftItems.reduce((s, it) => s + it.quantity * it.unitPrice, 0)
    const totalQuantity = draftItems.reduce((s, it) => s + it.quantity, 0)
    // 主表 unit_price 是舊資料相容用的加權平均，實際品項明細以 order_items 為準
    const avgUnitPrice = totalQuantity > 0 ? totalAmount / totalQuantity : 0

    const [result] = await db.query(
      `INSERT INTO orders (customer_id, quantity, unit_price, total_amount, status, payment_type, note, call_time)
       VALUES (?, ?, ?, ?, 'DRAFT', 'CASH', ?, NOW())`,
      [c.id, totalQuantity, avgUnitPrice, totalAmount, `來電自動草稿 ${normalized}`]
    ) as any

    draftId = result.insertId

    for (const it of draftItems) {
      await db.query(
        `INSERT INTO order_items (order_id, gas_type, quantity, unit_price, subtotal)
         VALUES (?, ?, ?, ?, ?)`,
        [draftId, it.gasType, it.quantity, it.unitPrice, it.quantity * it.unitPrice]
      )
    }
  }

  const [draftRow] = await db.query('SELECT * FROM orders WHERE id = ?', [draftId]) as any
  const [items] = await db.query('SELECT * FROM order_items WHERE order_id = ?', [draftId]) as any
  const order = draftRow[0]

  return res.json({
    found: true,
    draft: {
      id: draftId,
      customer: {
        id: c.id, name: c.name, phone: c.phone,
        address: c.address, note: c.note,
        amountOwed: c.amount_owed ?? 0,
      },
      items: items.map((i: any) => ({
        gasType: i.gas_type, quantity: i.quantity, unitPrice: i.unit_price, subtotal: i.subtotal,
      })),
      totalAmount: order.total_amount,
      paymentType: order.payment_type,
    },
  })
}

export async function getDraft(_req: Request, res: Response) {
  // 撈出「所有」尚未處理的草稿單（不再只抓最新一筆），依建立時間由舊到新排序
  const [rows] = await db.query(
    `SELECT o.*, 
      c.name as customer_name, c.phone as customer_phone,
      c.address as customer_address, c.note as customer_note,
      a.amount_owed
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN ar_balances a ON a.customer_id = c.id
     WHERE o.status = 'DRAFT'
     ORDER BY o.created_at ASC`
  ) as any

  if (rows.length > 0) {
    const orderIds = rows.map((o: any) => o.id)
    const placeholders = orderIds.map(() => '?').join(',')
    const [allItems] = await db.query(
      `SELECT * FROM order_items WHERE order_id IN (${placeholders})`,
      orderIds
    ) as any

    const drafts = rows.map((order: any) => ({
      id: order.id,
      customer: {
        id: order.customer_id,
        name: order.customer_name,
        phone: order.customer_phone,
        address: order.customer_address,
        note: order.customer_note,
        amountOwed: order.amount_owed ?? 0,
      },
      items: allItems
        .filter((i: any) => i.order_id === order.id)
        .map((i: any) => ({
          gasType: i.gas_type,
          quantity: i.quantity,
          unitPrice: i.unit_price,
          subtotal: i.subtotal,
        })),
      totalAmount: order.total_amount,
      paymentType: order.payment_type,
      createdAt: order.created_at,
    }))

    return res.json({
      draft: drafts[0],   // 保留舊欄位相容：最早那筆（先到的客戶優先處理）
      drafts,             // 完整草稿佇列，前端可改用這個顯示所有待處理來電
      unknownPhone: null,
      unknownCalls: [],
    })
  }

  // 沒有草稿單，查資料庫裡還沒處理的陌生來電（不再有 5 分鐘限制，永久保留直到處理）
  const [unknownRows] = await db.query(
    `SELECT id, phone, first_called_at, last_called_at, call_count
     FROM unknown_calls WHERE status = 'PENDING' ORDER BY first_called_at ASC`
  ) as any

  const unknownCalls = unknownRows.map((u: any) => ({
    id: u.id,
    phone: u.phone,
    firstCalledAt: u.first_called_at,
    lastCalledAt: u.last_called_at,
    callCount: u.call_count,
  }))

  return res.json({
    draft: null,
    drafts: [],
    unknownPhone: unknownCalls[0]?.phone || null,  // 舊欄位相容：最早那筆
    unknownCalls,                                    // 完整佇列，之後首頁可以用這個顯示常駐清單
  })
}

export async function confirmDraft(req: Request, res: Response) {
  const id = Number(req.params.id)
  const { paymentType, note, items, scheduledDate } = req.body

  const [rows] = await db.query(`SELECT * FROM orders WHERE id = ? AND status = 'DRAFT'`, [id]) as any
  if (!rows[0]) return res.status(404).json({ error: '草稿不存在' })

  const order = rows[0]

  // items 是前端送來的完整品項陣列 [{ gasType, quantity, unitPrice }, ...]，
  // 沒帶或是空陣列就退回用草稿原本主表上的單一品項當保底，避免舊版前端呼叫時整張單壞掉
  const finalItems = Array.isArray(items) && items.length > 0
    ? items.map((it: any) => ({
        gasType: it.gasType || 'BOTTLED_20KG',
        quantity: Number(it.quantity) || 1,
        unitPrice: Number(it.unitPrice) || 0,
      }))
    : [{ gasType: 'BOTTLED_20KG', quantity: order.quantity, unitPrice: order.unit_price }]

  const finalQty = finalItems.reduce((s: number, it: any) => s + it.quantity, 0)
  const finalTotal = finalItems.reduce((s: number, it: any) => s + it.quantity * it.unitPrice, 0)
  // 主表 unit_price 是舊資料相容用的加權平均，實際品項明細以 order_items 為準
  const finalUnitPrice = finalQty > 0 ? finalTotal / finalQty : 0

  // scheduledDate 沒傳或傳空字串就代表「今天」，存 NULL；有傳日期字串（YYYY-MM-DD）就存指定日期
  const finalScheduledDate = scheduledDate && scheduledDate.trim() ? scheduledDate : null

  console.log('confirmDraft debug:', { finalItems, finalQty, finalTotal, finalScheduledDate, id })

  await db.query(
    `UPDATE orders SET status = 'PENDING', payment_type = ?, note = ?, quantity = ?, unit_price = ?, total_amount = ?, scheduled_date = ? WHERE id = ?`,
    [paymentType || order.payment_type, note || order.note, finalQty, finalUnitPrice, finalTotal, finalScheduledDate, id]
  )

  // 品項整批換新：先刪掉草稿原本的品項，再依畫面上目前的品項清單重新寫入，
  // 才能正確處理「新增品項」「移除品項」「改成好幾種規格」這些情況
  await db.query(`DELETE FROM order_items WHERE order_id = ?`, [id])
  for (const it of finalItems) {
    await db.query(
      `INSERT INTO order_items (order_id, gas_type, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)`,
      [id, it.gasType, it.quantity, it.unitPrice, it.quantity * it.unitPrice]
    )
  }

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

// POST /api/caller/unknown/:id/dismiss
// 手動把某筆陌生來電標記為已處理（例如打錯電話、推銷電話，不想留在佇列裡）
export async function dismissUnknownCall(req: Request, res: Response) {
  const id = Number(req.params.id)
  const [rows] = await db.query(`SELECT id FROM unknown_calls WHERE id = ? AND status = 'PENDING'`, [id]) as any
  if (!rows[0]) return res.status(404).json({ error: '找不到這筆陌生來電' })

  await db.query(`UPDATE unknown_calls SET status = 'HANDLED', handled_at = NOW() WHERE id = ?`, [id])

  return res.json({ ok: true })
}

// POST /api/caller/bind
// body: { customerId, phone }
// 把陌生來電號碼綁定到「既有客戶」（例如 Ragic 匯入、尚未登記電話的舊客戶），
// 而不是建立一筆重複的新客戶，並直接建立草稿單
export async function bindCallerToCustomer(req: Request, res: Response) {
  const { customerId, phone } = req.body
  if (!customerId) return res.status(400).json({ error: 'customerId required' })
  if (!phone) return res.status(400).json({ error: 'phone required' })

  const normalized = normalizePhone(phone)

  const [rows] = await db.query(
    `SELECT c.*, a.amount_owed FROM customers c 
     LEFT JOIN ar_balances a ON a.customer_id = c.id
     WHERE c.id = ? AND c.status != 'INACTIVE' LIMIT 1`,
    [customerId]
  ) as any
  if (!rows[0]) return res.status(404).json({ error: '客戶不存在' })
  const c = rows[0]

  // 確認這支號碼沒有被別的客戶佔用
  const [dup] = await db.query(
    'SELECT id FROM customers WHERE (phone = ? OR phone2 = ?) AND id != ?',
    [normalized, normalized, customerId]
  ) as any
  if (dup[0]) return res.status(409).json({ error: '這支號碼已經綁定在其他客戶身上', customerId: dup[0].id })

  // phone 欄位空的就填 phone，已經有值就填 phone2；兩個都有值就不覆蓋，直接沿用原號碼建單
  if (!c.phone) {
    await db.query('UPDATE customers SET phone = ? WHERE id = ?', [normalized, customerId])
  } else if (!c.phone2 && c.phone !== normalized) {
    await db.query('UPDATE customers SET phone2 = ? WHERE id = ?', [normalized, customerId])
  }

  // 綁定前先撈這支號碼「第一次來電」的真實時間，之後建單要用這個當 call_time，
  // 不能用 NOW()——不然要是這通電話晾了幾小時才處理，訂單上顯示的來電時間會是處理時間、不是實際來電時間
  const [unknownCallRows] = await db.query(
    `SELECT first_called_at FROM unknown_calls WHERE phone = ? ORDER BY first_called_at DESC LIMIT 1`,
    [normalized]
  ) as any
  const callTime = unknownCallRows[0]?.first_called_at || null

  // 這支號碼綁定到既有客戶了，把陌生來電紀錄標記已處理
  await db.query(
    `UPDATE unknown_calls SET status = 'HANDLED', handled_at = NOW() WHERE phone = ? AND status = 'PENDING'`,
    [normalized]
  )

  // 沿用 incomingCallById 的建草稿單邏輯
  const [existingDrafts] = await db.query(
    `SELECT id FROM orders WHERE customer_id = ? AND status = 'DRAFT' ORDER BY created_at DESC LIMIT 1`,
    [customerId]
  ) as any

  if (existingDrafts[0]) {
    return res.json({ ok: true, orderId: existingDrafts[0].id, reused: true, customerId: Number(customerId) })
  }

  const gasType = c.gas_type || 'BOTTLED_20KG'
  const quantity = 1
  const unitPrice = c.price_override || 800
  const totalAmount = quantity * unitPrice

  const [result] = await db.query(
    `INSERT INTO orders (customer_id, quantity, unit_price, total_amount, status, payment_type, note, call_time)
     VALUES (?, ?, ?, ?, 'DRAFT', 'CASH', '陌生來電綁定既有客戶草稿', COALESCE(?, NOW()))`,
    [customerId, quantity, unitPrice, totalAmount, callTime]
  ) as any

  const orderId = result.insertId

  await db.query(
    `INSERT INTO order_items (order_id, gas_type, quantity, unit_price, subtotal)
     VALUES (?, ?, ?, ?, ?)`,
    [orderId, gasType, quantity, unitPrice, totalAmount]
  )

  return res.json({ ok: true, orderId, reused: false, customerId: Number(customerId) })
}

export async function incomingCallById(req: Request, res: Response) {
  const { customerId, phone } = req.body
  if (!customerId) return res.status(400).json({ error: 'customerId required' })

  // 如果前端有帶電話號碼，撈這支號碼「第一次來電」的真實時間當 call_time，
  // 理由同 bindCallerToCustomer：這裡是「確認」的當下，不是「來電」的當下
  let callTime: string | null = null
  if (phone) {
    const normalizedPhone = normalizePhone(phone)
    const [unknownCallRows] = await db.query(
      `SELECT first_called_at FROM unknown_calls WHERE phone = ? ORDER BY first_called_at DESC LIMIT 1`,
      [normalizedPhone]
    ) as any
    callTime = unknownCallRows[0]?.first_called_at || null
  }

  const [rows] = await db.query(
    `SELECT c.*, a.amount_owed FROM customers c 
     LEFT JOIN ar_balances a ON a.customer_id = c.id
     WHERE c.id = ? AND c.status != 'INACTIVE' LIMIT 1`,
    [customerId]
  ) as any

  if (!rows[0]) return res.status(404).json({ error: '客戶不存在' })

  const c = rows[0]

  // 同一客戶若已經有未處理的草稿單，直接沿用，不重複建立
  const [existingDrafts] = await db.query(
    `SELECT id FROM orders WHERE customer_id = ? AND status = 'DRAFT' ORDER BY created_at DESC LIMIT 1`,
    [c.id]
  ) as any

  if (existingDrafts[0]) {
    return res.json({ ok: true, orderId: existingDrafts[0].id, reused: true })
  }

  const gasType = c.gas_type || 'BOTTLED_20KG'
  const quantity = 1
  const unitPrice = c.price_override || 800
  const totalAmount = quantity * unitPrice

  const [result] = await db.query(
    `INSERT INTO orders (customer_id, quantity, unit_price, total_amount, status, payment_type, note, call_time)
     VALUES (?, ?, ?, ?, 'DRAFT', 'CASH', '陌生來電草稿', COALESCE(?, NOW()))`,
    [c.id, quantity, unitPrice, totalAmount, callTime]
  ) as any

  const orderId = result.insertId

  await db.query(
    `INSERT INTO order_items (order_id, gas_type, quantity, unit_price, subtotal)
     VALUES (?, ?, ?, ?, ?)`,
    [orderId, gasType, quantity, unitPrice, totalAmount]
  )

  return res.json({ ok: true, orderId, reused: false })
}