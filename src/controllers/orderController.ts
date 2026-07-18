import { Request, Response } from 'express'
import { db } from '../lib/db'

export async function listOrders(req: Request, res: Response) {
  const { status, date, customerId, limit = '10', all, upcoming } = req.query
  const conditions: string[] = []
  const params: any[] = []

  if (status) { conditions.push('o.status = ?'); params.push(status) }
  if (customerId) { conditions.push('o.customer_id = ?'); params.push(customerId) }
  if (!customerId) {
    if (upcoming) {
      // 已排定未來配送日的訂單（不含今天），讓首頁有地方能查到、編輯這些單
      conditions.push(`o.scheduled_date IS NOT NULL AND o.scheduled_date > CURDATE()`)
    } else if (date) {
      conditions.push('DATE(COALESCE(o.scheduled_date, o.created_at)) = ?')
      params.push(date)
    } else if (!all && status !== 'DRAFT') {
      conditions.push('DATE(COALESCE(o.scheduled_date, o.created_at)) = CURDATE()')
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
      `INSERT INTO orders (customer_id, quantity, unit_price, total_amount, status, note, payment_type, scheduled_date, call_time)
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, COALESCE(?, NOW()))`,
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

    await conn.query(`UPDATE orders SET status = 'DELIVERED' WHERE id = ?`, [orderId])

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
    if (oldOrder.status === 'DELIVERED' || oldOrder.status === 'CANCELLED') {
      await conn.rollback()
      return res.status(400).json({ error: '已完成或已取消的訂單無法修改' })
    }

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
