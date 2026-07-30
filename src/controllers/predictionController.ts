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
      // 取最近 4 個「有下單的日子」，每個日子的桶數用 SUM 加總——
      // 同一天不管建了幾張單（不管是分次記錄、還是不小心重複建單），都要當成同一次配送需求，
      // 不能各自成一筆去算間隔，不然兩筆訂單只隔幾小時，天數幾乎是 0，桶數除下去會爆出離譜的用量速度
      const [orders] = await db.query(
        `SELECT MIN(o.id) as id, DATE(o.created_at) as order_date, MAX(o.created_at) as created_at,
                COALESCE(SUM(oi.quantity), SUM(o.quantity)) as total_quantity
         FROM orders o
         LEFT JOIN order_items oi ON oi.order_id = o.id
         WHERE o.customer_id = ? AND o.status != 'CANCELLED'
         GROUP BY DATE(o.created_at)
         ORDER BY order_date DESC
         LIMIT 4`,
        [customer.id]
      ) as any

      if (orders.length < 3) continue

      // 這一輪提醒被取消過，而且之後沒有新訂單進來，就先不顯示
      const lastOrderTime = new Date(orders[0].created_at).getTime()
      if (dismissedAt[customer.id] && dismissedAt[customer.id] >= lastOrderTime) continue

      // 用「量」不是「次數」去算：這次叫得多，理論上要撐比較久才會再打來，
      // 不能像以前那樣不管每次叫幾桶，通通當成同一次「訂購」去算平均間隔——
      // 改成先算這位客戶平均一天大概用掉幾桶（每個區間的桶數 ÷ 那段區間的天數），
      // 再用「上次實際叫了幾桶」反推這批貨大概能撐幾天，藉此推算下次配送日
      const chronological = [...orders].reverse() as any[] // 轉成舊到新，方便算區間
      const dailyRates: number[] = []
      for (let i = 0; i < chronological.length - 1; i++) {
        const days = (new Date(chronological[i + 1].created_at).getTime() - new Date(chronological[i].created_at).getTime()) / (1000 * 60 * 60 * 24)
        const qty = Number(chronological[i].total_quantity) || 1
        if (days > 0) dailyRates.push(qty / days)
      }
      if (dailyRates.length === 0) continue

      // 用中位數而不是平均數：系統剛上線、資料還不多，每位客戶通常只有 2-3 段區間可以算，
      // 只要其中一段剛好是異常值（例如那次是進貨囤貨、不是正常消耗），平均數會被單一異常值整個拉走，
      // 中位數對這種離群值比較不敏感，樣本數越少的時候這個差異影響越大
      const sortedRates = [...dailyRates].sort((a, b) => a - b)
      const mid = Math.floor(sortedRates.length / 2)
      const avgDailyUsage = sortedRates.length % 2 !== 0
        ? sortedRates[mid]
        : (sortedRates[mid - 1] + sortedRates[mid]) / 2

      // 信心標示：樣本數（區間數）太少時，明確標示「僅供參考」，避免把還在累積資料階段的
      // 猜測當成準確預測——系統剛上線，大部分客戶現階段都只會落在「僅供參考」，這是預期中的事，
      // 之後資料累積夠了會自動轉為一般信心
      const confidence = dailyRates.length >= 3 ? 'normal' : 'low'

      const lastOrder = orders[0]
      const lastQuantity = Number(lastOrder.total_quantity) || 1
      const daysThisBatchLasts = avgDailyUsage > 0 ? lastQuantity / avgDailyUsage : 9999

      const lastOrderDate = new Date(lastOrder.created_at)
      const predictedDate = new Date(lastOrderDate.getTime() + daysThisBatchLasts * 24 * 60 * 60 * 1000)

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
        // 上次訂單的品項明細（用來顯示「上次訂 20kg×2」這種資訊），跟總桶數分開撈
        const [lastItems] = await db.query(
          `SELECT gas_type, quantity, unit_price FROM order_items WHERE order_id = ?`,
          [lastOrder.id]
        ) as any
        predictions.push({
          customerId: customer.id,
          customerName: customer.name,
          customerPhone: customer.phone,
          predictedDate: predictedDate.toISOString().slice(0, 10),
          overdueDays,
          avgDailyUsage: Math.round(avgDailyUsage * 100) / 100,
          estimatedDaysPerBatch: Math.round(daysThisBatchLasts),
          lastQuantity,
          lastGasType: lastItems[0]?.gas_type,
          lastUnitPrice: lastItems[0]?.unit_price,
          confidence,
          sampleSize: dailyRates.length,
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
