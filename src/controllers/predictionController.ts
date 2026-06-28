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

      // 只回傳昨天、今天、明天的
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
      const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000)
      const predictedDay = new Date(predictedDate)
      predictedDay.setHours(0, 0, 0, 0)

      // 排除今天已有訂單的客戶
      const [todayOrders] = await db.query(
        `SELECT id FROM orders WHERE customer_id = ? AND DATE(created_at) = ? AND status != 'CANCELLED'`,
        [customer.id, todayStr]
      ) as any
      if ((todayOrders as any[]).length > 0) continue

      if (predictedDay >= yesterday && predictedDay <= tomorrow) {
        predictions.push({
          customerId: customer.id,
          customerName: customer.name,
          customerPhone: customer.phone,
          predictedDate: predictedDate.toISOString().slice(0, 10),
          avgInterval: Math.round(avgInterval),
          lastGasType: orders[0].gas_type,
          lastQuantity: orders[0].quantity,
          lastUnitPrice: orders[0].unit_price,
        })
      }
    }

    res.json({ predictions })
  } catch (err) {
    console.error('[getPredictions]', err)
    res.status(500).json({ error: '預測失敗' })
  }
}
