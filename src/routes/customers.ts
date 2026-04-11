import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { listCustomers, getCustomer, createCustomer, updateCustomer, deleteCustomer } from '../controllers/customerController'

export const customerRoutes = Router()
customerRoutes.use(authenticate)
customerRoutes.get('/', listCustomers)
customerRoutes.get('/:id', getCustomer)
customerRoutes.post('/', createCustomer)
customerRoutes.put('/:id', updateCustomer)
customerRoutes.delete('/:id', deleteCustomer)
