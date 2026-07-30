import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { getPredictions, dismissPrediction, notifyPrediction } from '../controllers/predictionController'

export const predictionRoutes = Router()
predictionRoutes.use(authenticate)
predictionRoutes.get('/', getPredictions)
predictionRoutes.post('/:customerId/dismiss', dismissPrediction)
predictionRoutes.post('/:customerId/notify', notifyPrediction)
