import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { listArBalances, getCustomerAr, receivePayment, getStatement } from '../controllers/arController'

export const arRoutes = Router()
arRoutes.use(authenticate)
arRoutes.get('/', listArBalances)
arRoutes.get('/:customerId/statement', getStatement)
arRoutes.get('/:customerId', getCustomerAr)
arRoutes.post('/:customerId/payment', receivePayment)
