import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { getPredictions } from '../controllers/predictionController'

export const predictionRoutes = Router()
predictionRoutes.use(authenticate)
predictionRoutes.get('/', getPredictions)
