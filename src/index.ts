import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import fs from 'fs'
import { customerRoutes } from './routes/customers'
import { authRoutes } from './routes/auth'
import { callerRoutes } from './routes/caller'
import { orderRoutes } from './routes/orders'
import { arRoutes } from './routes/ar'
import { errorHandler } from './middleware/errorHandler'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 8080

app.use(cors({ origin: '*', credentials: true }))
app.use(express.json())

console.log('CWD:', process.cwd())
console.log('/ contents:', fs.readdirSync('/').join(', '))
console.log('/src contents:', fs.readdirSync('/src').join(', '))

app.get('/health', (_req, res) => res.json({ ok: true }))
app.use('/api/auth', authRoutes)
app.use('/api/customers', customerRoutes)
app.use('/api/caller', callerRoutes)
app.use('/api/orders', orderRoutes)
app.use('/api/ar', arRoutes)
app.use(errorHandler)

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
