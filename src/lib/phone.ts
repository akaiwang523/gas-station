// 統一電話正規化：任何時候要「存進資料庫」或「拿去比對」電話號碼，一律先經過這裡，
// 確保格式一致（去除空白/連字號/括號，+886 轉回 0 開頭）。
// 之前的 bug：接電話比對時有做這個正規化，但客戶管理新增/編輯客戶時完全沒有做，
// 導致同一支電話如果打法不同（有無「-」、空白），會被當成兩支不同號碼，
// 造成「這通電話是哪一間？」的多客戶比對永遠比對不到、直接漏掉其中一間店。
export function normalizePhone(raw: string): string {
  let p = raw.replace(/[\s\-().]/g, '')
  if (p.startsWith('+886')) p = '0' + p.slice(4)
  if (p.startsWith('886') && p.length >= 10) p = '0' + p.slice(3)
  return p
}

// 統一的「這支電話是不是已經有客戶在用」比對片段：phone / phone2 兩個固定欄位，
// 加上 customer_phones 這張「第三支以後」的電話表，三個地方都要一起查——
// 原本只有 callerController 裡有這段，customerController 手動新增/編輯客戶完全沒查，
// 這正是「來電 0983779091」這種孤兒客戶會被生出來的根本原因之一。
// 抽成共用工具，接電話比對跟手動新增/編輯客戶都用同一套，不會再各查各的、兩邊不同步。
export const PHONE_MATCH_SQL = `(c.phone = ? OR c.phone2 = ? OR EXISTS (
  SELECT 1 FROM customer_phones cp WHERE cp.customer_id = c.id AND cp.phone = ?
))`
export function phoneMatchParams(normalized: string): [string, string, string] {
  return [normalized, normalized, normalized]
}
