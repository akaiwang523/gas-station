import { Request, Response } from 'express'
import { db } from '../lib/db'

const GAS_TYPES = ['BOTTLED_20KG', 'BOTTLED_16KG', 'BOTTLED_10KG', 'BOTTLED_4KG']

function keyFor(gasType: string) {
  return `baseline_price_${gasType}`
}

// GET /api/settings/baseline-prices
// 回傳目前四種品項的基準價，例如 { BOTTLED_20KG: 800, BOTTLED_16KG: 650, ... }
export async function getBaselinePrices(_req: Request, res: Response) {
  const [rows] = await db.query(
    `SELECT \`key\`, \`value\` FROM settings WHERE \`key\` LIKE 'baseline_price_%'`
  ) as any

  const prices: Record<string, number> = {}
  for (const gasType of GAS_TYPES) {
    const row = rows.find((r: any) => r.key === keyFor(gasType))
    prices[gasType] = row ? Number(row.value) : 0
  }
  res.json({ prices })
}

// PUT /api/settings/baseline-prices
// body: { prices: { BOTTLED_20KG: 850, BOTTLED_16KG: 700, ... } }（可以只帶要改的品項）
export async function updateBaselinePrices(req: Request, res: Response) {
  const { prices } = req.body as { prices: Record<string, number> }
  if (!prices || typeof prices !== 'object') {
    return res.status(400).json({ error: '缺少 prices 物件' })
  }

  for (const gasType of Object.keys(prices)) {
    if (!GAS_TYPES.includes(gasType)) continue
    const value = Number(prices[gasType])
    if (!Number.isFinite(value) || value < 0) {
      return res.status(400).json({ error: `${gasType} 的價格不合法` })
    }
    await db.query(
      `INSERT INTO settings (\`key\`, \`value\`) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)`,
      [keyFor(gasType), String(value)]
    )
  }

  const [rows] = await db.query(
    `SELECT \`key\`, \`value\` FROM settings WHERE \`key\` LIKE 'baseline_price_%'`
  ) as any
  const updated: Record<string, number> = {}
  for (const gasType of GAS_TYPES) {
    const row = rows.find((r: any) => r.key === keyFor(gasType))
    updated[gasType] = row ? Number(row.value) : 0
  }
  res.json({ prices: updated })
}
