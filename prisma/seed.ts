import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  const hash = await bcrypt.hash('admin1234', 10)
  await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      passwordHash: hash,
      name: '管理員',
      role: 'ADMIN',
    },
  })
  console.log('Seed 完成：admin / admin1234')
}

main().finally(() => prisma.$disconnect())
