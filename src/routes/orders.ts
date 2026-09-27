import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { autoCompleteStaleOrders } from '../lib/autoCompleteStale'
import { listOrders, createOrder, updateOrderStatus, bulkUpdateOrderStatus, updateOrder, rescheduleOrder, collectPayment, getTodaySummary, getOrderCounts, getLineActivity, cancelOrder, deleteOrder } from '../controllers/orderController'

export const orderRoutes = Router()
orderRoutes.use(authenticate)
orderRoutes.get('/', listOrders)
orderRoutes.get('/summary', getTodaySummary)
orderRoutes.get('/counts', getOrderCounts)
orderRoutes.get('/line-activity', getLineActivity)
orderRoutes.post('/', createOrder)
orderRoutes.patch('/bulk-status', bulkUpdateOrderStatus)
// 手動觸發「隔日自動完成」（平常由每天 06:00 排程執行，這個給測試或臨時補跑用）
orderRoutes.post('/auto-complete-stale', async (_req, res, next) => {
  try { res.json(await autoCompleteStaleOrders()) } catch (e) { next(e) }
})
orderRoutes.patch('/:id/status', updateOrderStatus)
orderRoutes.post('/:id/payment', collectPayment)
orderRoutes.patch('/:id/cancel', cancelOrder)
orderRoutes.patch('/:id/reschedule', rescheduleOrder)
orderRoutes.patch('/:id', updateOrder)
orderRoutes.delete('/:id', deleteOrder)
