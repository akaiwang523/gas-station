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
