import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { handleLineWebhook, listLineInquiries, handleLineInquiry } from '../controllers/lineController'
import { liffConfig, liffAuth, liffMe, liffBind, liffOrder, liffProfile, liffAddPhone } from '../controllers/liffController'

export const lineRoutes = Router()

lineRoutes.post('/webhook', handleLineWebhook)

lineRoutes.get('/inquiries', authenticate, listLineInquiries)
lineRoutes.patch('/inquiries/:id/handle', authenticate, handleLineInquiry)

// LIFF 網頁訂購（客人端，用 LINE ID token 驗證，不走後台登入）
lineRoutes.get('/liff/config', liffConfig)
lineRoutes.get('/liff/me', liffAuth, liffMe)
lineRoutes.post('/liff/bind', liffAuth, liffBind)
lineRoutes.post('/liff/order', liffAuth, liffOrder)
lineRoutes.post('/liff/profile', liffAuth, liffProfile)
lineRoutes.post('/liff/phone', liffAuth, liffAddPhone)
