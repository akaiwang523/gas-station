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
import { lineRoutes } from './routes/line'
import { settingsRoutes } from './routes/settings'
import { errorHandler } from './middleware/errorHandler'
import cron from "node-cron"
import { runDailyScheduledOrders } from "./scripts/dailyScheduledOrders"
dotenv.config()

// 安全網：任何 API 裡沒被 catch 到的錯誤（例如這次的 SQL only_full_group_by 問題），
// 正常情況下會變成「unhandled promise rejection」，而 Node 預設遇到這種情況會直接
// 終止整個process——造成單一支 API 寫錯，就讓整個接單系統斷線、必須等 Zeabur 重開機。
// 這裡攔下來只記錄 log、不讓服務真的掛掉，把影響範圍限制在「那支 API 回傳 500」，而不是「全站停擺」。
process.on('unhandledRejection', (reason) => {
  console.error('[未攔截的 Promise 錯誤，服務繼續運作]', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[未攔截的例外，服務繼續運作]', err)
})

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
app.use('/api/line', lineRoutes)
app.use('/api/settings', settingsRoutes)
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
