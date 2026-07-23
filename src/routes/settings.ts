import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { getBaselinePrices, updateBaselinePrices } from '../controllers/settingsController'

export const settingsRoutes = Router()
settingsRoutes.use(authenticate)
settingsRoutes.get('/baseline-prices', getBaselinePrices)
settingsRoutes.put('/baseline-prices', updateBaselinePrices)
