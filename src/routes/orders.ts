import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { listOrders, createOrder, updateOrderStatus, collectPayment, getTodaySummary } from '../controllers/orderController'

export const orderRoutes = Router()
orderRoutes.use(authenticate)
orderRoutes.get('/', listOrders)
orderRoutes.get('/summary', getTodaySummary)
orderRoutes.post('/', createOrder)
orderRoutes.patch('/:id/status', updateOrderStatus)
orderRoutes.post('/:id/payment', collectPayment)
