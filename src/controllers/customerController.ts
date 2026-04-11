import { Request, Response } from 'express'
import { prisma } from '../lib/prisma'
import { z } from 'zod'

const customerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  phone2: z.string().optional(),
  address: z.string().min(1),
  district: z.string().optional(),
  gasType: z.enum(['BOTTLED_20KG', 'BOTTLED_16KG', 'BOTTLED_4KG', 'PIPED']).optional(),
  cylinderSize: z.number().optional(),
  cylindersHeld: z.number().optional(),
  deposit: z.number().optional(),
  priceOverride: z.number().optional(),
  deliveryCycle: z.enum(['ON_CALL', 'MONTHLY_FIXED', 'FLOW_METER', 'WEEKLY']).optional(),
  deliveryDay: z.number().optional(),
  note: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
})

export async function listCustomers(req: Request, res: Response) {
  const { status, district, search, page = '1', limit = '20' } = req.query
  const where: Record<string, unknown> = {}
  if (status) where.status = status
  if (district) where.district = district
  if (search) {
    where.OR = [
      { name: { contains: search as string } },
      { phone: { contains: search as string } },
      { address: { contains: search as string } },
    ]
  }
  const skip = (Number(page) - 1) * Number(limit)
  const [customers, total] = await Promise.all([
    prisma.customer.findMany({ where, include: { arBalance: true }, orderBy: { createdAt: 'desc' }, skip, take: Number(limit) }),
    prisma.customer.count({ where }),
  ])
  res.json({ customers, total, page: Number(page), limit: Number(limit) })
}

export async function getCustomer(req: Request, res: Response) {
  const id = Number(req.params.id)
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: { contacts: true, priceHistory: { orderBy: { effectiveDate: 'desc' }, take: 5 }, arBalance: true, orders: { orderBy: { createdAt: 'desc' }, take: 10 } },
  })
  if (!customer) return res.status(404).json({ error: '客戶不存在' })
  res.json(customer)
}

export async function createCustomer(req: Request, res: Response) {
  const data = customerSchema.parse(req.body)
  const customer = await prisma.customer.create({
    data: { ...data, deposit: data.deposit ?? 0, arBalance: { create: { amountOwed: 0, cylindersOwed: 0 } } },
    include: { arBalance: true },
  })
  res.status(201).json(customer)
}

export async function updateCustomer(req: Request, res: Response) {
  const id = Number(req.params.id)
  const data = customerSchema.partial().parse(req.body)
  const customer = await prisma.customer.update({ where: { id }, data, include: { arBalance: true } })
  res.json(customer)
}

export async function deleteCustomer(req: Request, res: Response) {
  const id = Number(req.params.id)
  await prisma.customer.update({ where: { id }, data: { status: 'INACTIVE' } })
  res.json({ ok: true })
}
