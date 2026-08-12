// 一次性腳本：把資料庫裡現有客戶的 phone / phone2 全部重新正規化一次。
// 背景：客戶管理新增/編輯客戶時，電話欄位過去沒有經過正規化（跟接電話比對用的格式不一致），
// 所以資料庫裡可能存在「同一支電話，兩種不同打法」的舊資料（例如一筆是 0912345678，
// 另一筆是 0912-345-678），導致來電比對時只抓到其中一筆，另一間店的來電永遠被漏掉。
// 這支腳本只是把既有資料「格式統一化」，不會新增/刪除/合併任何客戶。
//
// 執行方式（在 Zeabur 雲端終端機，不能在本機跑，因為本機沒有 DATABASE_URL）：
//   npx tsx src/scripts/normalizePhones.ts
import { db } from '../lib/db'
import { normalizePhone } from '../lib/phone'

async function main() {
  const [rows] = await db.query('SELECT id, name, phone, phone2 FROM customers') as any

  let changed = 0
  for (const c of rows) {
    const updates: string[] = []
    const params: any[] = []

    if (c.phone) {
      const n = normalizePhone(c.phone)
      if (n !== c.phone) { updates.push('phone = ?'); params.push(n) }
    }
    if (c.phone2) {
      const n = normalizePhone(c.phone2)
      if (n !== c.phone2) { updates.push('phone2 = ?'); params.push(n) }
    }

    if (updates.length) {
      console.log(`#${c.id} ${c.name}: phone ${c.phone} -> ${params[0]}${c.phone2 ? `, phone2 ${c.phone2} -> ${params[updates.length - 1]}` : ''}`)
      params.push(c.id)
      await db.query(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`, params)
      changed++
    }
  }

  console.log(`完成，共修正 ${changed} 筆客戶的電話格式（總共 ${rows.length} 筆客戶）`)
  process.exit(0)
}

main().catch(err => {
  console.error('normalizePhones 執行失敗', err)
  process.exit(1)
})
