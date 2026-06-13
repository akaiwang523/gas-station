import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
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

app.get('/health', (_req, res) => res.json({ ok: true }))
app.use('/api/auth', authRoutes)
app.use('/api/customers', customerRoutes)
app.use('/api/caller', callerRoutes)
app.use('/api/orders', orderRoutes)
app.use('/api/ar', arRoutes)

const frontendDist = '/app/frontend/dist'
app.use(express.static(frontendDist))
app.get('*', (_req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'))
})

app.use(errorHandler)

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
