import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { customerRoutes } from './routes/customers'
import { authRoutes } from './routes/auth'
import { callerRoutes } from './routes/caller'
import { errorHandler } from './middleware/errorHandler'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173', credentials: true }))
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true }))
app.use('/api/auth', authRoutes)
app.use('/api/customers', customerRoutes)
app.use('/api/caller', callerRoutes)
app.use(errorHandler)

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
