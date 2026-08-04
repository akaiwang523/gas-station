import { Request, Response } from 'express'
import { db } from '../lib/db'

const WEEKDAY_LABEL = ['週日', '週一', '週二', '週三', '週四', '週五', '週六']

// 配送熱點分析：星期幾規律（排兼職班表用）+ 行政區熱區（依配送訂單量，不是客戶數）
export async function getHotspots(req: Request, res: Response) {
  try {
    const days = Number(req.query.days) || 90

    // 星期規律：抓每一天的訂單數/桶數，再依星期幾分組平均——
    // 用「平均」而不是「加總」，是因為區間裡每個星期幾出現的次數本來就不一定剛好相等
    // 注意：DAYOFWEEK(created_at) 邏輯上完全由 DATE(created_at) 決定，但 MySQL 的
    // only_full_group_by 不會自動判斷函式之間的相依性，兩個運算式都要放進 GROUP BY，
    // 不然會直接噴錯——這支查詢每次載入報表頁都會呼叫，噴錯若沒被 catch 到會讓整個服務當機重開
    const [daily] = await db.query(
      `SELECT DATE(COALESCE(scheduled_date, created_at)) as d,
              DAYOFWEEK(COALESCE(scheduled_date, created_at)) as dow, COUNT(*) as cnt, SUM(quantity) as cyl
       FROM orders
       WHERE COALESCE(scheduled_date, created_at) >= DATE_SUB(CURDATE(), INTERVAL ? DAY) AND status != 'CANCELLED'
       GROUP BY DATE(COALESCE(scheduled_date, created_at)), DAYOFWEEK(COALESCE(scheduled_date, created_at))`,
      [days]
    ) as any

    const byWeekday: Record<number, { days: number; orders: number; cylinders: number }> = {}
    for (let i = 0; i < 7; i++) byWeekday[i] = { days: 0, orders: 0, cylinders: 0 }
    for (const row of daily) {
      const dow = row.dow - 1 // MySQL DAYOFWEEK: 1=週日...7=週六，轉成 0=週日...6=週六
      byWeekday[dow].days += 1
      byWeekday[dow].orders += Number(row.cnt)
      byWeekday[dow].cylinders += Number(row.cyl || 0)
    }
    const weekdayPattern = Object.entries(byWeekday).map(([dow, v]) => ({
      weekday: Number(dow),
      label: WEEKDAY_LABEL[Number(dow)],
      avgOrders: v.days > 0 ? Math.round((v.orders / v.days) * 10) / 10 : 0,
      avgCylinders: v.days > 0 ? Math.round((v.cylinders / v.days) * 10) / 10 : 0,
      sampleDays: v.days,
    }))

    // 行政區熱區：依配送訂單量排序（訂單筆數、桶數），不是客戶數多寡
    const [districts] = await db.query(
      `SELECT COALESCE(NULLIF(TRIM(c.district), ''), '未分類') as district,
         COUNT(*) as order_count, SUM(o.quantity) as cylinders
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       WHERE COALESCE(o.scheduled_date, o.created_at) >= DATE_SUB(CURDATE(), INTERVAL ? DAY) AND o.status != 'CANCELLED'
       GROUP BY district
       ORDER BY cylinders DESC`,
      [days]
    ) as any

    res.json({
      days,
      weekdayPattern,
      districtHotspots: districts,
    })
  } catch (err) {
    console.error('[getHotspots]', err)
    res.status(500).json({ error: '熱點分析失敗' })
  }
}

// 今日快覽
export async function getTodayReport(req: Request, res: Response) {
  // 統計基準用「訂單歸屬日」= COALESCE(scheduled_date, created_at)，不是單純的建立時間——
  // 預約單/補登的過去單，created_at 是建單當下，不代表這張單實際算哪一天，
  // 跟 getOrderCounts 的 `all` 統計口徑保持一致
  const [summary] = await db.query(
    `SELECT 
      COUNT(*) as total_orders,
      SUM(quantity) as total_cylinders,
      SUM(CASE WHEN payment_type != 'AR' THEN total_amount ELSE 0 END) as cash_amount,
      SUM(CASE WHEN payment_type = 'AR' THEN total_amount ELSE 0 END) as ar_amount,
      SUM(total_amount) as total_amount,
      SUM(CASE WHEN status = 'PENDING' OR status = 'DELIVERING' THEN 1 ELSE 0 END) as pending_count,
      SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) as delivered_count
     FROM orders
     WHERE DATE(COALESCE(scheduled_date, created_at)) = CURDATE() AND status != 'CANCELLED'`
  ) as any

  res.json(summary[0])
}

// 月報表
export async function getMonthReport(req: Request, res: Response) {
  const { month } = req.query
  const targetMonth = month || new Date().toISOString().slice(0, 7)

  // 全部改用「訂單歸屬日」COALESCE(scheduled_date, created_at) 而不是 created_at：
  // 1) 預約單的 created_at 是預約當下建立的時間，不是實際算哪一天
  // 2) 這裡刻意不要求 status='DELIVERED'／不看 delivered_at——
  //    試營運期間常有訂單忘記按「已完成」，若報表依賴 delivered_at 會直接漏算整筆，
  //    現有邏輯本來就只排除 CANCELLED，維持這點即可涵蓋「忘記標記完成」的單

  // 月份總計
  const [summary] = await db.query(
    `SELECT 
      COUNT(*) as total_orders,
      SUM(quantity) as total_cylinders,
      SUM(CASE WHEN payment_type != 'AR' THEN total_amount ELSE 0 END) as cash_amount,
      SUM(CASE WHEN payment_type = 'AR' THEN total_amount ELSE 0 END) as ar_amount,
      SUM(total_amount) as total_amount
     FROM orders
     WHERE DATE_FORMAT(COALESCE(scheduled_date, created_at), '%Y-%m') = ? AND status != 'CANCELLED'`,
    [targetMonth]
  ) as any

  // 各品項桶數
  const [cylinders] = await db.query(
    `SELECT oi.gas_type, SUM(oi.quantity) as qty, SUM(oi.subtotal) as amount
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE DATE_FORMAT(COALESCE(o.scheduled_date, o.created_at), '%Y-%m') = ? AND o.status != 'CANCELLED'
     GROUP BY oi.gas_type`,
    [targetMonth]
  ) as any

  // 每日訂單數和金額
  const [daily] = await db.query(
    `SELECT 
      DAY(COALESCE(scheduled_date, created_at)) as day,
      COUNT(*) as orders,
      SUM(total_amount) as amount,
      SUM(quantity) as cylinders
     FROM orders
     WHERE DATE_FORMAT(COALESCE(scheduled_date, created_at), '%Y-%m') = ? AND status != 'CANCELLED'
     GROUP BY DAY(COALESCE(scheduled_date, created_at))
     ORDER BY day ASC`,
    [targetMonth]
  ) as any

  // 當月收款記錄
  const [payments] = await db.query(
    `SELECT SUM(p.amount) as total_paid
     FROM payments p
     WHERE DATE_FORMAT(p.paid_at, '%Y-%m') = ?`,
    [targetMonth]
  ) as any

  // 前五名客戶
  const [topCustomers] = await db.query(
    `SELECT c.name, c.phone, COUNT(*) as order_count,
      SUM(o.quantity) as cylinders, SUM(o.total_amount) as amount
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE DATE_FORMAT(COALESCE(o.scheduled_date, o.created_at), '%Y-%m') = ? AND o.status != 'CANCELLED'
     GROUP BY o.customer_id, c.name, c.phone
     ORDER BY amount DESC
     LIMIT 5`,
    [targetMonth]
  ) as any

  res.json({
    month: targetMonth,
    summary: summary[0],
    cylinders,
    daily,
    totalPaid: payments[0]?.total_paid || 0,
    topCustomers,
  })
}

// 匯出 CSV
export async function exportCsv(req: Request, res: Response) {
  const { month } = req.query
  const targetMonth = month || new Date().toISOString().slice(0, 7)

  const [orders] = await db.query(
    `SELECT 
      o.id, DATE(COALESCE(o.scheduled_date, o.created_at)) as date, c.name as customer, c.phone,
      c.address, o.quantity, o.unit_price, o.total_amount,
      o.payment_type, o.status, o.note,
      GROUP_CONCAT(CONCAT(oi.gas_type,'x',oi.quantity) SEPARATOR '+') as items
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE DATE_FORMAT(COALESCE(o.scheduled_date, o.created_at), '%Y-%m') = ? AND o.status != 'CANCELLED'
     GROUP BY o.id
     ORDER BY COALESCE(o.scheduled_date, o.created_at) ASC`,
    [targetMonth]
  ) as any

  const headers = ['日期', '客戶', '電話', '地址', '品項', '桶數', '金額', '付款方式', '狀態', '備註']
  const paymentMap: Record<string, string> = { CASH: '現金', AR: '欠帳', TRANSFER: '轉帳', LINE_PAY: 'LINE Pay' }
  const statusMap: Record<string, string> = { PENDING: '待送', DELIVERING: '配送中', DELIVERED: '已完成' }

  const rows = orders.map((o: any) => [
    o.date, o.customer, o.phone, o.address,
    o.items || `${o.quantity}桶`,
    o.quantity, o.total_amount,
    paymentMap[o.payment_type] || o.payment_type,
    statusMap[o.status] || o.status,
    o.note || ''
  ])

  const csv = [headers, ...rows].map(row =>
    row.map((cell: any) => `"${String(cell).replace(/"/g, '""')}"`).join(',')
  ).join('\n')

  const bom = '\uFEFF'
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="orders-${targetMonth}.csv"`)
  res.send(bom + csv)
}
