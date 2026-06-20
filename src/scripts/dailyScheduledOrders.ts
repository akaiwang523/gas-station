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

function isoWeekday(date: Date): number {
  // JS getDay(): 0=Sun..6=Sat -> 轉成 1=Mon..7=Sun
  const d = date.getDay()
  return d === 0 ? 7 : d
}

function isFirstOccurrenceOfWeekdayThisMonth(date: Date): boolean {
  return date.getDate() <= 7
}

// delivery_day 可能是單一星期幾("3")或逗號分隔多個星期幾("1,4")，統一解析成數字陣列
function parseDeliveryDays(deliveryDay: string | null): number[] {
  if (!deliveryDay) return []
  return deliveryDay
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
}

async function run() {
  const today = new Date()
  const todayWeekday = isoWeekday(today)
  const todayStr = today.toISOString().slice(0, 10) // YYYY-MM-DD

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

  console.log(`[dailyScheduledOrders] 共 ${fixedCustomers.length} 位固定配送客戶待檢查`)

  const dueToday = fixedCustomers.filter((c) => {
    const days = parseDeliveryDays(c.delivery_day)
    if (!days.includes(todayWeekday)) return false
    if (c.delivery_cycle === 'WEEKLY') return true
    if (c.delivery_cycle === 'MONTHLY_FIXED') return isFirstOccurrenceOfWeekdayThisMonth(today)
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
    const [existing] = await db.query(
      `SELECT id FROM customer_events
       WHERE customer_id = ? AND event_type = 'AUTO_SCHEDULED_ORDER' AND DATE(created_at) = ?`,
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

    const unitPrice = customer.default_unit_price ?? customer.price_override
    if (unitPrice === null || unitPrice === undefined) {
      console.warn(`[dailyScheduledOrders] 客戶 ${customer.name}(#${customer.id}) 未設定單價(default_unit_price/price_override)，略過，請手動建單`)
      skipped++
      continue
    }

    const totalAmount = quantity * Number(unitPrice)

    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()

      const [result] = await conn.query(
        `INSERT INTO orders (customer_id, quantity, unit_price, total_amount, status, note, payment_type)
         VALUES (?, ?, ?, ?, 'PENDING', ?, 'CASH')`,
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

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[dailyScheduledOrders] 執行失敗:', err)
    process.exit(1)
  })
