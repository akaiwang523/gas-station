import { Request, Response } from 'express'
import { prisma } from '../lib/prisma'

function normalizePhone(raw: string): string {
  let p = raw.replace(/[\s\-().]/g, '')
  if (p.startsWith('+886')) p = '0' + p.slice(4)
  if (p.startsWith('886') && p.length >= 10) p = '0' + p.slice(3)
  return p
}

export async function lookupCaller(req: Request, res: Response) {
  const { phone, apiKey } = req.body
  if (apiKey !== process.env.CALLER_API_KEY) return res.status(401).json({ error: 'Unauthorized' })
  if (!phone) return res.status(400).json({ error: 'phone required' })
  const normalized = normalizePhone(phone)
  const customer = await prisma.customer.findFirst({
    where: { OR: [{ phone: normalized }, { phone2: normalized }], status: { not: 'INACTIVE' } },
    include: { arBalance: true },
  })
  if (!customer) return res.json({ found: false, phone: normalized, message: '新號碼，尚未建檔' })
  return res.json({
    found: true,
    customer: {
      id: customer.id, name: customer.name, phone: customer.phone,
      address: customer.address, gasType: customer.gasType,
      cylindersHeld: customer.cylindersHeld, priceOverride: customer.priceOverride,
      note: customer.note, amountOwed: customer.arBalance?.amountOwed ?? 0,
      cylindersOwed: customer.arBalance?.cylindersOwed ?? 0, lastDelivery: customer.lastDelivery,
    },
  })
}

export async function createFromCall(req: Request, res: Response) {
  const { phone, name, address, apiKey } = req.body
  if (apiKey !== process.env.CALLER_API_KEY) return res.status(401).json({ error: 'Unauthorized' })
  if (!phone) return res.status(400).json({ error: 'phone required' })
  const normalized = normalizePhone(phone)
  const existing = await prisma.customer.findFirst({ where: { OR: [{ phone: normalized }, { phone2: normalized }] } })
  if (existing) return res.status(409).json({ error: '號碼已存在', customerId: existing.id })
  const customer = await prisma.customer.create({
    data: { name: name || `來電 ${normalized}`, phone: normalized, address: address || '（待補）', status: 'ACTIVE', arBalance: { create: { amountOwed: 0, cylindersOwed: 0 } } },
  })
  return res.status(201).json({ created: true, customer: { id: customer.id, name: customer.name, phone: customer.phone } })
}
