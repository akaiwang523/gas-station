import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { handleLineWebhook, listLineInquiries, handleLineInquiry } from '../controllers/lineController'

export const lineRoutes = Router()

lineRoutes.post('/webhook', handleLineWebhook)

lineRoutes.get('/inquiries', authenticate, listLineInquiries)
lineRoutes.patch('/inquiries/:id/handle', authenticate, handleLineInquiry)
