import { db } from './db'

// 隔日自動完成：前一天（含更早）還沒按完成的單，一律改成已完成。
//
// 原因：實際流程是出貨後常常忘了按完成，隔天這些單還掛在待派送，
// 跟當天的新單混在一起，容易重複送或重複建單。
//
// 安全網：這裡只改狀態，不會打勾「已對帳」（verified_at 維持 NULL），
// 所以晚上拿出貨單對帳時，沒有出貨單的一樣會被抓出來作廢。
// 備註會加上「隔日自動完成」，對帳頁看得出來是系統按的，不是人按的。
//
// 不會動到：已排定在今天或之後的單（scheduled_date >= 今天）、已完成、已取消、草稿，
// 以及還沒有人按「收到」的 LINE 單（沒人看到的單不能被系統默默結掉，那就真的漏單了）。
// delivered_at 用訂單自己那天（有排定日用排定日中午，否則用建立時間），
// 不用「現在」——否則會全部算成今天送達，灌爆今天的統計（08/03 的教訓）
export async function autoCompleteStaleOrders(): Promise<{ completed: number; ids: number[] }> {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })

  const [rows] = await db.query(
    `SELECT id FROM orders
     WHERE status IN ('PENDING', 'ASSIGNED', 'DELIVERING')
       AND DATE(COALESCE(scheduled_date, CONVERT_TZ(created_at, '+00:00', '+08:00'))) < ?
       AND NOT (source = 'LINE' AND line_ack_at IS NULL)`,
    [today]
  ) as any
  const ids: number[] = rows.map((r: any) => r.id)
  if (ids.length === 0) return { completed: 0, ids }

  const [result] = await db.query(
    `UPDATE orders
     SET status = 'DELIVERED',
         delivered_at = CASE WHEN scheduled_date IS NOT NULL THEN TIMESTAMP(scheduled_date, '04:00:00') ELSE created_at END,
         note = CONCAT(COALESCE(note, ''), ?)
     WHERE id IN (${ids.map(() => '?').join(',')})
       AND status IN ('PENDING', 'ASSIGNED', 'DELIVERING')`,
    [`（${today} 隔日自動完成）`, ...ids]
  ) as any

  return { completed: result.affectedRows ?? 0, ids }
}
