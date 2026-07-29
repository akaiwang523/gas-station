import { Request, Response } from 'express'
import { db } from '../lib/db'

export async function getPredictions(req: Request, res: Response) {
  try {
    // 撈出歷史訂單 >= 3 筆的活躍客戶，取最近 4 筆
    const [customers] = await db.query(
      `SELECT c.id, c.name, c.phone,
              (SELECT COUNT(*) FROM orders WHERE customer_id = c.id AND status != 'CANCELLED') as order_count
       FROM customers c
       WHERE c.status = 'ACTIVE'
       HAVING order_count >= 3`
    ) as any

    // 「取消提醒」的紀錄：只要取消時間晚於這位客戶最後一筆訂單，就代表這一輪提醒已經被處理過了，先跳過；
    // 之後只要幫他建了新訂單，最後一筆訂單時間就會比取消時間新，下一輪預測會自動恢復顯示，不用另外清除紀錄
    const [dismissals] = await db.query(`SELECT customer_id, dismissed_at FROM prediction_dismissals`) as any
    const dismissedAt: Record<number, number> = {}
    for (const d of dismissals) {
      dismissedAt[d.customer_id] = new Date(d.dismissed_at).getTime()
    }

    const predictions = []

    for (const customer of customers) {
      // 取最近 4 筆訂單日期與品項
      const [orders] = await db.query(
        `SELECT o.id, o.created_at, oi.gas_type, oi.quantity, oi.unit_price
         FROM orders o
         LEFT JOIN order_items oi ON oi.order_id = o.id
         WHERE o.customer_id = ? AND o.status != 'CANCELLED'
         ORDER BY o.created_at DESC
         LIMIT 4`,
        [customer.id]
      ) as any

      if (orders.length < 3) continue

      // 這一輪提醒被取消過，而且之後沒有新訂單進來，就先不顯示
      const lastOrderTime = new Date(orders[0].created_at).getTime()
      if (dismissedAt[customer.id] && dismissedAt[customer.id] >= lastOrderTime) continue

      // 計算 3 個間隔天數的平均
      const dates = orders.map((o: any) => new Date(o.created_at).getTime())
      const intervals = []
      for (let i = 0; i < dates.length - 1; i++) {
        intervals.push((dates[i] - dates[i + 1]) / (1000 * 60 * 60 * 24))
      }
      const avgInterval = intervals.reduce((a: number, b: number) => a + b, 0) / intervals.length

      // 預測耗盡日
      const lastOrderDate = new Date(orders[0].created_at)
      const predictedDate = new Date(lastOrderDate.getTime() + avgInterval * 24 * 60 * 60 * 1000)

      // 上限：明天以內才提前顯示（不用太早打擾客戶）；沒有下限——
      // 預測日期一旦到了，就會持續出現在清單裡，直到真的幫他建單為止，
      // 不會因為老闆哪天剛好沒開系統檢查，就永久錯過這個客戶（原本用「昨天~明天」3天窗口會有這個問題）
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000)
      const predictedDay = new Date(predictedDate)
      predictedDay.setHours(0, 0, 0, 0)

      // 排除今天已有訂單的客戶（用台北時區的日期字串，避免跟 container 的 UTC 時間對不起來）
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' })
      const [todayOrders] = await db.query(
        `SELECT id FROM orders WHERE customer_id = ? AND DATE(created_at) = ? AND status != 'CANCELLED'`,
        [customer.id, todayStr]
      ) as any
      if ((todayOrders as any[]).length > 0) continue

      if (predictedDay <= tomorrow) {
        const overdueDays = Math.round((today.getTime() - predictedDay.getTime()) / (1000 * 60 * 60 * 24))
        predictions.push({
          customerId: customer.id,
          customerName: customer.name,
          customerPhone: customer.phone,
          predictedDate: predictedDate.toISOString().slice(0, 10),
          overdueDays,
          avgInterval: Math.round(avgInterval),
          lastGasType: orders[0].gas_type,
          lastQuantity: orders[0].quantity,
          lastUnitPrice: orders[0].unit_price,
        })
      }
    }

    // 拖越久沒問的排越前面，最需要優先聯絡的客戶先看到
    predictions.sort((a, b) => b.overdueDays - a.overdueDays)

    res.json({ predictions })
  } catch (err) {
    console.error('[getPredictions]', err)
    res.status(500).json({ error: '預測失敗' })
  }
}

// 取消這位客戶「這一輪」的預測提醒；下次他有新訂單進來，就會自動重新開始下一輪預測
export async function dismissPrediction(req: Request, res: Response) {
  const customerId = Number(req.params.customerId)
  if (!customerId) return res.status(400).json({ error: '缺少客戶編號' })

  await db.query(
    `INSERT INTO prediction_dismissals (customer_id, dismissed_at) VALUES (?, NOW())
     ON DUPLICATE KEY UPDATE dismissed_at = NOW()`,
    [customerId]
  )
  res.json({ ok: true })
}
