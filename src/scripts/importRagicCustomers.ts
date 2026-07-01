import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { db } from '../lib/db'

// 用腳本自身位置算絕對路徑，不依賴執行時所在資料夾
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

interface RagicRecord {
  name: string
  address: string
  ragicId: string
  note: string | null
}

async function main() {
  const dataPath = path.join(__dirname, 'ragic_customers_data.json')
  const records: RagicRecord[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'))
  console.log(`讀到 ${records.length} 筆 Ragic 客戶資料`)

  // 撈出已經匯入過的 ragicId（用 note 欄位的 "RAGIC:C-xxxxx" 前綴標記防重複）
  const [existingRows] = await db.query(
    `SELECT note FROM customers WHERE note LIKE 'RAGIC:%'`
  ) as any
  const alreadyImported = new Set<string>(
    existingRows.map((r: any) => {
      const match = /^RAGIC:(C-\d+)/.exec(r.note || '')
      return match ? match[1] : null
    }).filter(Boolean)
  )
  console.log(`資料庫裡已經匯入過 ${alreadyImported.size} 筆，將略過這些`)

  let inserted = 0
  let skipped = 0

  for (const rec of records) {
    if (alreadyImported.has(rec.ragicId)) {
      skipped++
      continue
    }

    const noteValue = `RAGIC:${rec.ragicId}` + (rec.note ? ` ${rec.note}` : '')

    const [result] = await db.query(
      `INSERT INTO customers (name, phone, address, note, status, gas_type, cylinders_held, delivery_cycle)
       VALUES (?, '', ?, ?, 'ACTIVE', 'BOTTLED_20KG', 0, 'ON_CALL')`,
      [rec.name, rec.address, noteValue]
    ) as any

    const customerId = result.insertId
    await db.query(
      'INSERT INTO ar_balances (customer_id, amount_owed, cylinders_owed) VALUES (?, 0, 0)',
      [customerId]
    )
    inserted++

    if (inserted % 100 === 0) console.log(`已匯入 ${inserted} 筆...`)
  }

  console.log(`完成。新增 ${inserted} 筆，略過（已存在）${skipped} 筆。`)
  process.exit(0)
}

main().catch(err => {
  console.error('匯入失敗:', err)
  process.exit(1)
})
