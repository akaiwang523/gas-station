/**
 * 每日固定客戶自動建單腳本
 *
 * 用途：依客戶的 delivery_cycle / delivery_day 設定，判斷今天該配送的固定客戶，
 *       自動建立 PENDING 草稿訂單，數量/單價取自客戶的預設值，出貨前仍可在前端調整。
 *
 * 執行方式：
 *   本地測試：npx tsx src/scripts/dailyScheduledOrders.ts
 *   正式排程：建議掛在 Zeabur Cron Job，指令同上，建議排每天 06:00 (UTC+8) 執行一次
 *
 * delivery_day 規則（1=週一 ... 7=週日，可逗號分隔存多個星期幾，如 "1,4" 代表週一與週四）：
 *   - WEEKLY        : 每週固定該星期幾（或多個星期幾）配送
 *   - MONTHLY_FIXED : 每月「該星期幾第一次出現」的那天配送（即日期 <= 7）；若設定多個星期幾，
 *                     則每個星期幾各自的當月第一次出現都會配送
 *   - ON_CALL / FLOW_METER : 不在自動排程範圍內，略過
 *
 * 重複建單規則：
 *   依使用者明確指示，只要今天是該配送日就建立新單，不檢查該客戶是否已有未出貨訂單。
 *   但同一支腳本若同一天被重複執行兩次，仍會用 customer_events 記錄「今天已處理」來防止
 *   同一天內被腳本自己重複觸發（避免排程意外重跑兩次造成同一天建兩筆）。
 */
import { db } from '../lib/db'

type DeliveryCycle = 'ON_CALL' | 'MONTHLY_FIXED' | 'FLOW_METER' | 'WEEKLY'

interface FixedCustomer {
  id: number
  name: string
  delivery_cycle: DeliveryCycle
  delivery_day: string | null
  gas_type: string
  default_order_quantity: number | null
  default_unit_price: number | null
  price_override: number | null
}

function isFirstOccurrenceOfWeekdayThisMonth(dayOfMonth: number): boolean {
  return dayOfMonth <= 7
}

// delivery_day 可能是單一星期幾("3")或逗號分隔多個星期幾("1,4")，統一解析成數字陣列
function parseDeliveryDays(deliveryDay: string | null): number[] {
  if (!deliveryDay) return []
  return deliveryDay
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
}

export async function runDailyScheduledOrders() {
  // 這支排程是設定在台北時間早上 6 點跑（UTC+8 的 06:00 = UTC 前一天 22:00）。
  // 用 new Date() 直接算「今天」會拿到執行環境（Zeabur 容器，通常是 UTC）的日期/星期，
  // 這個時間點 UTC 那邊其實還是「前一天」，導致每次排程都用錯的星期幾去比對固定配送日，
  // 固定配送客戶會系統性地晚一天觸發。這裡改用 Intl 直接在台北時區算出今天的日期字串跟星期幾。
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date()) // YYYY-MM-DD
  const todayDayOfMonth = Number(todayStr.slice(8, 10))
  const WEEKDAY_MAP: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
  const weekdayName = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', weekday: 'short' }).format(new Date())
  const todayWeekday = WEEKDAY_MAP[weekdayName]

  console.log(`[dailyScheduledOrders] 開始執行，今天日期: ${todayStr}, 星期: ${todayWeekday}`)

  // 撈出所有「固定配送」客戶（WEEKLY / MONTHLY_FIXED），且狀態為 ACTIVE
  const [customers] = await db.query(
    `SELECT id, name, delivery_cycle, delivery_day, gas_type,
            default_order_quantity, default_unit_price, price_override
     FROM customers
     WHERE status = 'ACTIVE'
       AND delivery_cycle IN ('WEEKLY', 'MONTHLY_FIXED')
       AND delivery_day IS NOT NULL`
  ) as any
  const fixedCustomers = customers as FixedCustomer[]

  // 單價跟「快速接單」「來電草稿」用同一套邏輯：優先用客戶的特殊單價，沒有就用目前的基準價。
  // 不能用客戶身上 default_unit_price 這個欄位當主要依據——那是設定固定配送當下手動填的數字，
  // 填完就凍結了，之後基準價再怎麼調整都不會跟著變，導致自動建單價格長期抓到過期的舊數字。
  const [baselineRows] = await db.query(
    `SELECT \`key\`, \`value\` FROM settings WHERE \`key\` LIKE 'baseline_price_%'`
  ) as any
  const baselinePrice: Record<string, number> = {}
  for (const row of baselineRows) {
    baselinePrice[row.key.replace('baseline_price_', '')] = Number(row.value)
  }

  console.log(`[dailyScheduledOrders] 共 ${fixedCustomers.length} 位固定配送客戶待檢查`)

  const dueToday = fixedCustomers.filter((c) => {
    const days = parseDeliveryDays(c.delivery_day)
    if (!days.includes(todayWeekday)) return false
    if (c.delivery_cycle === 'WEEKLY') return true
    if (c.delivery_cycle === 'MONTHLY_FIXED') return isFirstOccurrenceOfWeekdayThisMonth(todayDayOfMonth)
    return false
  })

  console.log(`[dailyScheduledOrders] 今天 (${todayStr}) 應配送客戶數: ${dueToday.length}`)

  if (dueToday.length === 0) {
    console.log('[dailyScheduledOrders] 今天沒有需要自動建單的固定客戶，結束')
    return
  }

  let created = 0
  let skipped = 0

  for (const customer of dueToday) {
    // 防止同一支腳本同一天對同一客戶重複建單（例如排程意外重跑）
    // created_at 存的是 UTC，這裡要用 CONVERT_TZ 轉台北時區再跟 todayStr（台北日期）比較，
    // 否則兩邊日期基準不一致，又會回到同一種時區判斷錯誤
    const [existing] = await db.query(
      `SELECT id FROM customer_events
       WHERE customer_id = ? AND event_type = 'AUTO_SCHEDULED_ORDER' AND DATE(CONVERT_TZ(created_at, '+00:00', '+08:00')) = ?`,
      [customer.id, todayStr]
    ) as any
    if (existing[0]) {
      console.log(`[dailyScheduledOrders] 客戶 ${customer.name}(#${customer.id}) 今天已自動建過單，略過`)
      skipped++
      continue
    }

    const quantity = customer.default_order_quantity
    if (!quantity || quantity <= 0) {
      console.warn(`[dailyScheduledOrders] 客戶 ${customer.name}(#${customer.id}) 未設定 default_order_quantity，略過，請手動建單`)
      skipped++
      continue
    }

    const unitPrice = customer.price_override ?? baselinePrice[customer.gas_type] ?? customer.default_unit_price
    if (unitPrice === null || unitPrice === undefined) {
      console.warn(`[dailyScheduledOrders] 客戶 ${customer.name}(#${customer.id}) 抓不到任何單價依據（特殊單價/基準價/預設單價都沒有），略過，請手動建單`)
      skipped++
      continue
    }

    const totalAmount = quantity * Number(unitPrice)

    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()

      const [result] = await conn.query(
        `INSERT INTO orders (customer_id, quantity, unit_price, total_amount, status, note, payment_type, source)
         VALUES (?, ?, ?, ?, 'PENDING', ?, 'CASH', 'SCHEDULED')`,
        [customer.id, quantity, unitPrice, totalAmount, '系統自動建立(固定配送排程)']
      ) as any
      const orderId = result.insertId

      await conn.query(
        `INSERT INTO order_items (order_id, gas_type, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)`,
        [orderId, customer.gas_type, quantity, unitPrice, totalAmount]
      )

      await conn.query(
        `INSERT INTO customer_events (customer_id, event_type, detail) VALUES (?, 'AUTO_SCHEDULED_ORDER', ?)`,
        [customer.id, `自動建單 order_id=${orderId}`]
      )

      await conn.commit()
      console.log(`[dailyScheduledOrders] 已為 ${customer.name}(#${customer.id}) 建立草稿訂單 #${orderId}，數量 ${quantity}`)
      created++
    } catch (err) {
      await conn.rollback()
      console.error(`[dailyScheduledOrders] 客戶 ${customer.name}(#${customer.id}) 建單失敗:`, err)
    } finally {
      conn.release()
    }
  }

  console.log(`[dailyScheduledOrders] 完成。新建 ${created} 筆，略過 ${skipped} 筆`)
}

// 直接執行時（npx tsx）才跑，被 import 時不自動執行
if (require.main === module) {
  runDailyScheduledOrders()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[dailyScheduledOrders] 執行失敗:', err)
      process.exit(1)
    })
}
