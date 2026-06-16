import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { getCustomerReturns, createReturn, resolveReturn, getPendingReturns } from '../controllers/gasReturnController'

export const gasReturnRoutes = Router()
gasReturnRoutes.use(authenticate)
gasReturnRoutes.get('/customer/:customerId', getCustomerReturns)
gasReturnRoutes.get('/customer/:customerId/pending', getPendingReturns)
gasReturnRoutes.post('/', createReturn)
gasReturnRoutes.patch('/:id/resolve', resolveReturn)
