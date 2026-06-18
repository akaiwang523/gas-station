import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { listOrders, createOrder, updateOrderStatus, updateOrder, collectPayment, getTodaySummary, cancelOrder, deleteOrder } from '../controllers/orderController'

export const orderRoutes = Router()
orderRoutes.use(authenticate)
orderRoutes.get('/', listOrders)
orderRoutes.get('/summary', getTodaySummary)
orderRoutes.post('/', createOrder)
orderRoutes.patch('/:id/status', updateOrderStatus)
orderRoutes.post('/:id/payment', collectPayment)
orderRoutes.patch('/:id/cancel', cancelOrder)
orderRoutes.patch('/:id', updateOrder)
orderRoutes.delete('/:id', deleteOrder)
