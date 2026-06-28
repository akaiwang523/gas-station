import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import { customerRoutes } from './routes/customers'
import { authRoutes } from './routes/auth'
import { callerRoutes } from './routes/caller'
import { orderRoutes } from './routes/orders'
import { arRoutes } from './routes/ar'
import { reportRoutes } from './routes/reports'
import { gasReturnRoutes } from './routes/gasReturns'
import { predictionRoutes } from './routes/predictions'
import { errorHandler } from './middleware/errorHandler'
import cron from "node-cron"
import { runDailyScheduledOrders } from "./scripts/dailyScheduledOrders"
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
app.use('/api/reports', reportRoutes)
app.use('/api/gas-returns', gasReturnRoutes)
app.use('/api/predictions', predictionRoutes)
// Serve frontend
const frontendDist = path.join(__dirname, '../frontend/dist')
app.use(express.static(frontendDist))
app.get('*', (_req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'))
})
app.use(errorHandler)
cron.schedule("0 6 * * *", () => {
  console.log("[Cron] 執行每日固定配送建單...")
  runDailyScheduledOrders().catch((err: Error) => console.error("[Cron] 建單失敗:", err))
}, { timezone: "Asia/Taipei" })

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
