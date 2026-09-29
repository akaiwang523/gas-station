import { Request, Response } from 'express'
import { db } from '../lib/db'

// 還沒完成的訂單狀態：不管是哪一天建立/排定的，只要還沒送達就該一直看得到，
// 不能被「只看今天」的預設日期限制擋住，否則昨天以前沒送出去的單會憑空消失
const ACTIVE_STATUSES = ['PENDING', 'ASSIGNED', 'DELIVERING']

export async function getOrderCounts(_req: Request, res: Response) {
  const [rows] = await db.query(
    `SELECT
      SUM(CASE WHEN DATE(COALESCE(scheduled_date, created_at)) = CURDATE() THEN 1 ELSE 0 END) as \`all\`,
      SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'DELIVERING' THEN 1 ELSE 0 END) as delivering,
      SUM(CASE WHEN status = 'DELIVERED' AND DATE(delivered_at) = CURDATE() THEN 1 ELSE 0 END) as delivered,
      SUM(CASE WHEN scheduled_date IS NOT NULL AND scheduled_date > CURDATE() THEN 1 ELSE 0 END) as scheduled
     FROM orders`
  ) as any
  res.json(rows[0])
}

// 給前端輕量輪詢用：只回傳「目前最新的 LINE 訂單 id / LINE 詢問 id」這兩個數字，
// 不是完整訂單清單，前端拿這個跟自己記的上一次的值比對，有變化才觸發真正的重新整理。
// 這樣不用整個訂單列表輪詢（資料量大、頻繁打會浪費），卻能在 LINE 官方帳號有新訂單/新對話時自動更新畫面
export async function getLineActivity(_req: Request, res: Response) {
  const [[orderRow]] = await db.query(
    // 來電也會自動建單（不經過瀏覽器操作），一起納入，訂單頁才會即時出現
    `SELECT COALESCE(MAX(id), 0) as latestOrderId FROM orders WHERE source IN ('LINE', 'CALLER')`
  ) as any
  const [[inquiryRow]] = await db.query(
    `SELECT COALESCE(MAX(id), 0) as latestInquiryId FROM line_inquiries`
  ) as any
  res.json({
    latestOrderId: orderRow.latestOrderId,
    latestInquiryId: inquiryRow.latestInquiryId,
  })
}

export async function listOrders(req: Request, res: Response) {
  const { status, date, customerId, customerSearch, limit = '200', all, upcoming } = req.query
  const conditions: string[] = []
  const params: any[] = []

  if (status) { conditions.push('o.status = ?'); params.push(status) }
  if (customerId) { conditions.push('o.customer_id = ?'); params.push(customerId) }
  if (customerSearch) {
    // 客戶姓名/電話搜尋要在資料庫層先篩選，篩選完才套用筆數上限——
    // 不然像「訂單查詢」那種不指定日期、單純搜客戶名字的用法，會先被 LIMIT 砍到只剩最近 N 筆
    // 全部客戶混在一起的訂單，這位客戶比較久以前的訂單就會憑空從搜尋結果消失
    conditions.push(`(c.name LIKE ? OR c.phone LIKE ? OR c.phone2 LIKE ? OR EXISTS (
      SELECT 1 FROM customer_phones cp WHERE cp.customer_id = c.id AND cp.phone LIKE ?
    ))`)
    const kw = `%${customerSearch}%`
    params.push(kw, kw, kw, kw)
  }
  if (!customerId) {
    if (upcoming) {
      // 已排定未來配送日的訂單（不含今天），讓首頁有地方能查到、編輯這些單
      conditions.push(`o.scheduled_date IS NOT NULL AND o.scheduled_date > CURDATE()`)
    } else if (date) {
      conditions.push('DATE(COALESCE(o.scheduled_date, o.created_at)) = ?')
      params.push(date)
    } else if (!customerSearch && !all && status !== 'DRAFT' && !ACTIVE_STATUSES.includes(String(status))) {
      if (status === 'DELIVERED') {
        // 已完成分頁要跟 getOrderCounts 的統計口徑一致：用「今天完成」而非「今天建立/預約」判斷
        conditions.push('DATE(o.delivered_at) = CURDATE()')
      } else {
        conditions.push('DATE(COALESCE(o.scheduled_date, o.created_at)) = CURDATE()')
      }
    }
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

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
     LIMIT ?`,
    [...params, Number(limit)]
  ) as any

  // 取得每筆訂單的品項
  const orderIds = orders.map((o: any) => o.id)
  let itemsMap: Record<number, any[]> = {}
  if (orderIds.length > 0) {
    const [items] = await db.query(
      `SELECT * FROM order_items WHERE order_id IN (?)`,
      [orderIds]
    ) as any
    items.forEach((item: any) => {
      if (!itemsMap[item.order_id]) itemsMap[item.order_id] = []
      itemsMap[item.order_id].push(item)
    })
  }

  orders.forEach((o: any) => { o.items = itemsMap[o.id] || [] })

  res.json({ orders })
}

export async function createOrder(req: Request, res: Response) {
  const { customerId, items, stairFee = 0, note, paymentType = 'CASH', scheduledDate, callTime } = req.body

  if (!customerId || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: '缺少必要欄位' })
  }

  const gasTotal = items.reduce((s: number, i: any) => s + Number(i.quantity) * Number(i.unit_price), 0)
  const totalAmount = gasTotal + Number(stairFee)
  const totalQuantity = items.reduce((s: number, i: any) => s + Number(i.quantity), 0)

  if (totalQuantity <= 0) {
    return res.status(400).json({ error: '訂購數量需大於 0' })
  }

  // scheduledDate 沒傳或傳空字串就代表「今天」，存 NULL；有傳日期字串（YYYY-MM-DD）就存指定日期
  const finalScheduledDate = scheduledDate && String(scheduledDate).trim() ? scheduledDate : null

  // callTime 沒傳就代表沒有更早的實際來電時間可回填，建單當下的時間就是最準的資訊，交給 SQL COALESCE(?, NOW()) 處理
  // 前端 <input type="datetime-local"> 吐出來的格式是 "2026-07-18T14:30"（T 分隔），
  // 這裡不做任何時區換算——輸入框上打的就是台北時間的字面值，只要把 T 換成空格讓 MySQL 看得懂就好
  const finalCallTime = callTime && String(callTime).trim() ? String(callTime).replace('T', ' ') : null

  // 整筆建單（主表 + 品項 + 欠帳 + 客戶最後配送時間）用同一條連線跑交易，
  // 任何一步失敗就整體回滾，避免留下半套資料（訂單存在但品項缺漏、或 ar_balances 沒同步更新）
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    // 建單前先確認客戶存在，避免寫入找不到客戶的孤兒訂單
    const [customerRows] = await conn.query(
      'SELECT id FROM customers WHERE id = ? FOR UPDATE',
      [customerId]
    ) as any
    if (!customerRows[0]) {
      await conn.rollback()
      return res.status(404).json({ error: '客戶不存在' })
    }

    const [result] = await conn.query(
      `INSERT INTO orders (customer_id, quantity, unit_price, total_amount, status, note, payment_type, scheduled_date, call_time, source)
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, COALESCE(?, NOW()), 'MANUAL')`,
      [customerId, totalQuantity, gasTotal / totalQuantity, totalAmount, note || null, paymentType, finalScheduledDate, finalCallTime]
    ) as any

    const orderId = result.insertId

    // 寫入品項
    for (const item of items) {
      const subtotal = Number(item.quantity) * Number(item.unit_price)
      await conn.query(
        `INSERT INTO order_items (order_id, gas_type, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)`,
        [orderId, item.gas_type, item.quantity, item.unit_price, subtotal]
      )
    }

    // 欠帳處理
    if (paymentType === 'AR') {
      await conn.query(
        `INSERT INTO ar_balances (customer_id, amount_owed, cylinders_owed)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           amount_owed = amount_owed + VALUES(amount_owed),
           cylinders_owed = cylinders_owed + VALUES(cylinders_owed),
           updated_at = NOW()`,
        [customerId, totalAmount, totalQuantity]
      )
    }

    await conn.query('UPDATE customers SET last_delivery = NOW() WHERE id = ?', [customerId])

    await conn.commit()
    res.status(201).json({ id: orderId, totalAmount })
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

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

// 批次標記多筆訂單狀態（例如「待送」分頁多選好幾筆一次標記完成）
export async function bulkUpdateOrderStatus(req: Request, res: Response) {
  const { orderIds, status } = req.body

  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return res.status(400).json({ error: '缺少要更新的訂單清單' })
  }
  const ids = orderIds.map((v: any) => Number(v)).filter((n: number) => Number.isInteger(n))
  if (ids.length === 0) {
    return res.status(400).json({ error: '訂單編號格式錯誤' })
  }
  if (!status) {
    return res.status(400).json({ error: '缺少目標狀態' })
  }

  const placeholders = ids.map(() => '?').join(',')
  const updates = ['status = ?']
  const params: any[] = [status]
  if (status === 'DELIVERED') updates.push('delivered_at = NOW()')
  params.push(...ids)

  await db.query(`UPDATE orders SET ${updates.join(', ')} WHERE id IN (${placeholders})`, params)
  res.json({ ok: true, updated: ids.length })
}

export async function collectPayment(req: Request, res: Response) {
  const orderId = Number(req.params.id)
  const { amount, method = 'CASH', note } = req.body
  const collectedBy = (req as any).user.id

  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: '金額有誤' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [orderRows] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]) as any
    const order = orderRows[0]
    if (!order) {
      await conn.rollback()
      return res.status(404).json({ error: '訂單不存在' })
    }

    await conn.query(
      `INSERT INTO payments (order_id, collected_by, amount, method, note) VALUES (?, ?, ?, ?, ?)`,
      [orderId, collectedBy, amount, method, note || null]
    )

    if (order.payment_type === 'AR') {
      await conn.query(
        `UPDATE ar_balances SET amount_owed = amount_owed - ?, last_payment = NOW() WHERE customer_id = ?`,
        [amount, order.customer_id]
      )
    }

    await conn.query(`UPDATE orders SET status = 'DELIVERED', delivered_at = NOW() WHERE id = ?`, [orderId])

    await conn.commit()
    res.json({ ok: true })
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function getTodaySummary(_req: Request, res: Response) {
  // 訂單頁頂部的統計改成「今天已送達」口徑，跟「已完成」分頁（getOrderCounts.delivered /
  // listOrders 的 DELIVERED 過濾）用同一個條件，數字才對得起來。
  // 原本用「今天建立或排定」算總訂單，昨天建立今天才送的單不會算進去，
  // 就會出現「總訂單 5、已完成 14」這種互相矛盾的畫面
  const [deliveredRows] = await db.query(
    `SELECT
      COUNT(*) AS delivered_orders,
      COALESCE(SUM(quantity), 0) AS delivered_cylinders,
      COALESCE(SUM(CASE WHEN payment_type != 'AR' THEN total_amount ELSE 0 END), 0) AS delivered_cash,
      COALESCE(SUM(CASE WHEN payment_type = 'AR' THEN total_amount ELSE 0 END), 0) AS delivered_ar
     FROM orders
     WHERE status = 'DELIVERED' AND DATE(delivered_at) = CURDATE()`
  ) as any

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
     WHERE DATE(COALESCE(scheduled_date, created_at)) = CURDATE() AND status != 'CANCELLED'`
  ) as any
  res.json({ ...rows[0], ...deliveredRows[0] })
}

export async function cancelOrder(req: Request, res: Response) {
  const id = Number(req.params.id)

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    // 鎖住該筆訂單，避免重複點擊「取消」造成 ar_balances 被扣兩次
    const [orderRows] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]) as any
    const order = orderRows[0]
    if (!order) {
      await conn.rollback()
      return res.status(404).json({ error: '訂單不存在' })
    }
    if (order.status === 'DELIVERED') {
      await conn.rollback()
      return res.status(400).json({ error: '已完成訂單無法取消，請使用撤銷' })
    }
    if (order.status === 'CANCELLED') {
      await conn.rollback()
      return res.status(400).json({ error: '訂單已是取消狀態' })
    }

    // 如果是欠帳單，回滾 ar_balances
    if (order.payment_type === 'AR') {
      await conn.query(
        `UPDATE ar_balances SET amount_owed = amount_owed - ?, cylinders_owed = cylinders_owed - ? WHERE customer_id = ?`,
        [order.total_amount, order.quantity, order.customer_id]
      )
    }

    await conn.query(`UPDATE orders SET status = 'CANCELLED' WHERE id = ?`, [id])

    await conn.commit()
    res.json({ ok: true })
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function deleteOrder(req: Request, res: Response) {
  const id = Number(req.params.id)
  const [orderRows] = await db.query('SELECT * FROM orders WHERE id = ?', [id]) as any
  const order = orderRows[0]
  if (!order) return res.status(404).json({ error: '訂單不存在' })
  if (order.status !== 'CANCELLED' && order.status !== 'DELIVERED') {
    return res.status(400).json({ error: '只能刪除已取消或已完成的訂單' })
  }

  await db.query('DELETE FROM order_items WHERE order_id = ?', [id])
  await db.query('DELETE FROM payments WHERE order_id = ?', [id])
  await db.query('DELETE FROM orders WHERE id = ?', [id])
  res.json({ ok: true })
}

// 把一筆未送達的訂單改期（例如今天沒送到、延到明天再送），只動 scheduled_date，不動品項/金額
export async function rescheduleOrder(req: Request, res: Response) {
  const id = Number(req.params.id)
  const { scheduledDate } = req.body // 'YYYY-MM-DD'；沒傳或空字串代表清除排定日（=改回今天）
  const finalScheduledDate = scheduledDate && String(scheduledDate).trim() ? scheduledDate : null
  const [result] = await db.query(
    'UPDATE orders SET scheduled_date = ? WHERE id = ?',
    [finalScheduledDate, id]
  ) as any
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: '訂單不存在' })
  }
  res.json({ ok: true, scheduledDate: finalScheduledDate })
}

export async function updateOrder(req: Request, res: Response) {
  const id = Number(req.params.id)
  const { items, note, paymentType } = req.body

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: '缺少品項資料' })
  }
  for (const item of items) {
    if (!item.gasType) {
      return res.status(400).json({ error: '每個品項都需要指定瓦斯規格' })
    }
    if (!(Number(item.quantity) > 0)) {
      return res.status(400).json({ error: '每個品項的桶數需大於 0' })
    }
  }
  if (paymentType !== undefined && paymentType !== 'CASH' && paymentType !== 'AR') {
    return res.status(400).json({ error: '付款方式錯誤' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]) as any
    const oldOrder = rows[0]
    if (!oldOrder) {
      await conn.rollback()
      return res.status(404).json({ error: '訂單不存在' })
    }
    // 原本這裡會擋掉已完成/已取消的訂單不給改，但實際使用情境常常是「送完之後才發現當初單價/品項打錯」，
    // 需要回頭修正歷史紀錄——欠帳校正邏輯（下面）是抓舊付款方式跟新付款方式的差額調整，跟訂單狀態無關，
    // 不管訂單是哪個狀態都一樣安全，所以拿掉這個限制

    // 找出目前資料庫裡實際存在的品項 id，用來判斷哪些被使用者刪除了
    const [existingRows] = await conn.query('SELECT id FROM order_items WHERE order_id = ?', [id]) as any
    const existingIds = new Set(existingRows.map((r: any) => r.id))
    const keptIds = new Set<number>()

    for (const item of items) {
      const qty = Number(item.quantity)
      const price = Number(item.unitPrice)
      const subtotal = qty * price
      const itemId = item.id ? Number(item.id) : 0

      if (itemId && existingIds.has(itemId)) {
        // 既有品項：更新
        await conn.query(
          `UPDATE order_items SET gas_type = ?, quantity = ?, unit_price = ?, subtotal = ? WHERE id = ? AND order_id = ?`,
          [item.gasType, qty, price, subtotal, itemId, id]
        )
        keptIds.add(itemId)
      } else {
        // 新品項：新增
        const [insertResult] = await conn.query(
          `INSERT INTO order_items (order_id, gas_type, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)`,
          [id, item.gasType, qty, price, subtotal]
        ) as any
        keptIds.add(insertResult.insertId)
      }
    }

    // 刪除使用者在前端移除的品項
    const idsToDelete = [...existingIds].filter((eid) => !keptIds.has(eid as number))
    if (idsToDelete.length > 0) {
      await conn.query(`DELETE FROM order_items WHERE id IN (?) AND order_id = ?`, [idsToDelete, id])
    }

    // 從品項加總，回寫到 orders 主表（quantity/unit_price 維持相容用途，混合規格時 unit_price 為加權平均）
    const totalQuantity = items.reduce((s: number, i: any) => s + Number(i.quantity), 0)
    const totalAmount = items.reduce((s: number, i: any) => s + Number(i.quantity) * Number(i.unitPrice), 0)
    const avgUnitPrice = totalQuantity > 0 ? totalAmount / totalQuantity : 0
    const newPaymentType = paymentType !== undefined ? paymentType : oldOrder.payment_type

    await conn.query(
      `UPDATE orders SET quantity = ?, unit_price = ?, total_amount = ?, note = ?, payment_type = ? WHERE id = ?`,
      [totalQuantity, avgUnitPrice, totalAmount, note ?? null, newPaymentType, id]
    )

    // 欠帳金額校正：先扣掉這筆訂單原本掛在 ar_balances 上的舊金額/舊桶數，
    // 再依新的付款方式決定要不要重新加回去（涵蓋現金⇄欠帳切換，也順便修正
    // 「欠帳單改品項/金額但 ar_balances 沒跟著變」這個既有問題）
    if (oldOrder.payment_type === 'AR') {
      await conn.query(
        `UPDATE ar_balances SET amount_owed = amount_owed - ?, cylinders_owed = cylinders_owed - ? WHERE customer_id = ?`,
        [oldOrder.total_amount, oldOrder.quantity, oldOrder.customer_id]
      )
    }
    if (newPaymentType === 'AR') {
      await conn.query(
        `INSERT INTO ar_balances (customer_id, amount_owed, cylinders_owed)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           amount_owed = amount_owed + VALUES(amount_owed),
           cylinders_owed = cylinders_owed + VALUES(cylinders_owed),
           updated_at = NOW()`,
        [oldOrder.customer_id, totalAmount, totalQuantity]
      )
    }

    await conn.commit()
    res.json({ ok: true })
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

// POST /api/orders/bulk-delete { orderIds } — 訂單查詢頁「全選 → 刪除」
// 規則（每筆各自在 transaction 裡處理，一筆失敗不影響其他筆）：
// - 已取消：直接刪
// - 未完成（待送/草稿等）：現金單直接刪；記帳單先把掛在 ar_balances 的金額/桶數扣回（同取消邏輯）再刪
// - 已完成現金單：刪（連同收款紀錄，報表營收會跟著減少）
// - 已完成記帳單：跳過 —— 可能已部分收款，自動扣欠款容易算錯，請個別處理
export async function bulkDeleteOrders(req: Request, res: Response) {
  const ids: number[] = Array.isArray(req.body?.orderIds)
    ? [...new Set<number>(req.body.orderIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0))]
    : []
  if (ids.length === 0) return res.status(400).json({ error: '沒有選擇任何訂單' })
  if (ids.length > 500) return res.status(400).json({ error: '一次最多刪除 500 筆' })

  let deleted = 0
  const skipped: { id: number; reason: string }[] = []

  for (const id of ids) {
    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()
      const [rows] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]) as any
      const o = rows[0]
      if (!o) { await conn.rollback(); continue }

      if (o.status === 'DELIVERED' && o.payment_type === 'AR') {
        await conn.rollback()
        skipped.push({ id, reason: '已完成的記帳單' })
        continue
      }
      if (o.status !== 'DELIVERED' && o.status !== 'CANCELLED' && o.payment_type === 'AR') {
        await conn.query(
          `UPDATE ar_balances SET amount_owed = amount_owed - ?, cylinders_owed = cylinders_owed - ? WHERE customer_id = ?`,
          [o.total_amount, o.quantity, o.customer_id]
        )
      }
      await conn.query('DELETE FROM order_items WHERE order_id = ?', [id])
      await conn.query('DELETE FROM payments WHERE order_id = ?', [id])
      await conn.query('DELETE FROM orders WHERE id = ?', [id])
      await conn.commit()
      deleted++
    } catch (err) {
      await conn.rollback()
      console.error('[bulk-delete]', id, err)
      skipped.push({ id, reason: '有其他資料關聯，無法刪除' })
    } finally {
      conn.release()
    }
  }
  res.json({ ok: true, deleted, skipped })
}

// LINE 新單確認：LINE 進來的單不會響，要有人按「收到」（同時補寫紙本出貨單）才算有人看到。
// GET /api/orders/line-unacked — 所有分頁共用，不管排哪天都列出來
export async function listLineUnacked(_req: Request, res: Response) {
  const [rows] = await db.query(
    `SELECT o.id, o.customer_id, o.note, o.scheduled_date, o.created_at, o.total_amount,
            c.name AS customer_name, c.address AS customer_address, c.phone AS customer_phone
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.source = 'LINE' AND o.line_ack_at IS NULL AND o.status NOT IN ('CANCELLED','DRAFT')
     ORDER BY o.created_at`
  ) as any
  const ids = rows.map((r: any) => r.id)
  const itemsBy: Record<number, any[]> = {}
  if (ids.length) {
    const [items] = await db.query(
      `SELECT order_id, gas_type, quantity FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')})`, ids
    ) as any
    for (const it of items) (itemsBy[it.order_id] ||= []).push({ gasType: it.gas_type, qty: Number(it.quantity) })
  }
  res.json({ orders: rows.map((r: any) => ({ ...r, items: itemsBy[r.id] || [] })) })
}

// PATCH /api/orders/:id/ack
export async function ackLineOrder(req: Request, res: Response) {
  const id = Number(req.params.id)
  if (!id) return res.status(400).json({ error: '缺少編號' })
  await db.query(`UPDATE orders SET line_ack_at = NOW() WHERE id = ? AND line_ack_at IS NULL`, [id])
  res.json({ ok: true })
}
