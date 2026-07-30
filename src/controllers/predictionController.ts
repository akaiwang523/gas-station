import { Request, Response } from 'express'
import { db } from '../lib/db'

// 資料量不足時的預設值：單桶大概能撐幾天，依客戶類型區分
// （營業用通常用量大、撐比較短；一般住家用量小、撐比較久）
// 注意：customer_type 是資料庫既有欄位，允許值是 RESIDENTIAL / COMMERCIAL / UNKNOWN（不能是 NULL），
// 不是後來新設計的 BUSINESS，這裡要對齊既有欄位定義
const DEFAULT_DAYS_PER_BOTTLE: Record<string, number> = {
  COMMERCIAL: 5,
  RESIDENTIAL: 30,
}
// 下限不是固定值，而是依「這位客戶平均每次訂購幾桶」動態調整——
// 一次訂比較多桶的客戶（例如餐飲業一次叫 2-3 桶），用量規模本來就大，
// 不該用跟「一次只訂 1 桶」的客戶同一套下限去卡他，否則會像白妞民族那樣，
// 明明實際算出來單桶只需要 1.5 天，卻被固定下限 3 天硬拉高，預測日期整整晚了快一週
const ABSOLUTE_MIN_DAYS_PER_BOTTLE = 1 // 下限本身也有下限，避免動態算出離譜的極端值
const BASE_MIN_DAYS_PER_BOTTLE = 3 // 平均每次只訂 1 桶時的下限（維持原本設計）
const MAX_DAYS_PER_BOTTLE = 60

export async function getPredictions(req: Request, res: Response) {
  try {
    // 撈出「至少有 1 筆訂單」的活躍客戶——降低門檻是因為現在改成資料不夠時會用
    // 客戶類型的預設值頂上，所以不用像以前那樣硬性要求至少 3 筆才能進入預測名單，
    // 只要有 1 筆訂單當「上次配送」的基準點就能推算
    const [customers] = await db.query(
      `SELECT c.id, c.name, c.phone, c.customer_type,
              (SELECT COUNT(*) FROM orders WHERE customer_id = c.id AND status != 'CANCELLED') as order_count
       FROM customers c
       WHERE c.status = 'ACTIVE'
       HAVING order_count >= 1`
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

      if (orders.length === 0) continue

      // 這一輪提醒被取消過，而且之後沒有新訂單進來，就先不顯示
      const lastOrderTime = new Date(orders[0].created_at).getTime()
      if (dismissedAt[customer.id] && dismissedAt[customer.id] >= lastOrderTime) continue

      let daysPerBottle: number
      let confidence: 'default' | 'low' | 'normal'
      let sampleSize = 0

      if (orders.length < 3) {
        // 資料量門檻：歷史下單天數不到 3 天，樣本太少不採計歷史平均，
        // 直接套用客戶類型的預設值（沒設定類型的客戶，先當一般住家處理，比較保守不會太常打擾）
        daysPerBottle = DEFAULT_DAYS_PER_BOTTLE[customer.customer_type] ?? DEFAULT_DAYS_PER_BOTTLE.RESIDENTIAL
        confidence = 'default'
      } else {
        // 用「量」不是「次數」去算：這次叫得多，理論上要撐比較久才會再打來，
        // 不能像以前那樣不管每次叫幾桶，通通當成同一次「訂購」去算平均間隔——
        // 改成先算這位客戶平均一天大概用掉幾桶（每個區間的桶數 ÷ 那段區間的天數），
        // 再反推「一桶大概能撐幾天」
        const chronological = [...orders].reverse() as any[] // 轉成舊到新，方便算區間
        const dailyRates: number[] = []
        for (let i = 0; i < chronological.length - 1; i++) {
          const days = (new Date(chronological[i + 1].created_at).getTime() - new Date(chronological[i].created_at).getTime()) / (1000 * 60 * 60 * 24)
          const qty = Number(chronological[i].total_quantity) || 1
          if (days > 0) dailyRates.push(qty / days)
        }

        if (dailyRates.length === 0) {
          daysPerBottle = DEFAULT_DAYS_PER_BOTTLE[customer.customer_type] ?? DEFAULT_DAYS_PER_BOTTLE.RESIDENTIAL
          confidence = 'default'
        } else {
          // 用中位數而不是平均數：只要其中一段剛好是異常值（例如那次是進貨囤貨、不是正常消耗），
          // 平均數會被單一異常值整個拉走，中位數對這種離群值比較不敏感
          const sortedRates = [...dailyRates].sort((a, b) => a - b)
          const mid = Math.floor(sortedRates.length / 2)
          const medianDailyUsage = sortedRates.length % 2 !== 0
            ? sortedRates[mid]
            : (sortedRates[mid - 1] + sortedRates[mid]) / 2

          // 動態下限：平均每次訂購桶數越多，下限跟著等比例降低——
          // 例如平均每次訂 2 桶，下限就從 3 天降到 1.5 天；平均訂 3 桶以上，下限降到 1 天封頂
          const avgQtyPerOrder = chronological.reduce((s, o: any) => s + (Number(o.total_quantity) || 1), 0) / chronological.length
          const dynamicMinDaysPerBottle = Math.max(BASE_MIN_DAYS_PER_BOTTLE / Math.max(avgQtyPerOrder, 1), ABSOLUTE_MIN_DAYS_PER_BOTTLE)

          const rawDaysPerBottle = medianDailyUsage > 0 ? 1 / medianDailyUsage : MAX_DAYS_PER_BOTTLE
          // 上下限夾擊：就算用了中位數，資料還是可能整批偏掉（例如客戶剛好都在特殊時間點叫貨），
          // 強制夾在「動態下限～60 天」之間，避免算出不合理的極端值，
          // 同時不會誤傷那些原本就一次訂很多桶、用量本來就快的客戶
          daysPerBottle = Math.min(Math.max(rawDaysPerBottle, dynamicMinDaysPerBottle), MAX_DAYS_PER_BOTTLE)
          confidence = 'normal'
          sampleSize = dailyRates.length
        }
      }

      const lastOrder = orders[0]
      const lastQuantity = Number(lastOrder.total_quantity) || 1
      const daysThisBatchLasts = daysPerBottle * lastQuantity

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
          customerType: customer.customer_type,
          predictedDate: predictedDate.toISOString().slice(0, 10),
          overdueDays,
          daysPerBottle: Math.round(daysPerBottle * 10) / 10,
          estimatedDaysPerBatch: Math.round(daysThisBatchLasts),
          lastQuantity,
          lastGasType: lastItems[0]?.gas_type,
          lastUnitPrice: lastItems[0]?.unit_price,
          confidence,
          sampleSize,
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
