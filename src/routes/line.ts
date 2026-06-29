import { Router } from 'express'
import { handleLineWebhook } from '../controllers/lineController'

export const lineRoutes = Router()

lineRoutes.post('/webhook', handleLineWebhook)
