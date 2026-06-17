import { Router } from 'express'
import { lookupCaller, createFromCall, incomingCall, getDraft, confirmDraft, cancelDraft } from '../controllers/callerController'
import { authenticate } from '../middleware/auth'

export const callerRoutes = Router()

// MacroDroid 來電觸發（不需要登入，用 apiKey 驗證）
callerRoutes.post('/lookup', lookupCaller)
callerRoutes.post('/create', createFromCall)
callerRoutes.post('/incoming', incomingCall)

// 前端用（需要登入）
callerRoutes.get('/draft', authenticate, getDraft)
callerRoutes.post('/draft/:id/confirm', authenticate, confirmDraft)
callerRoutes.delete('/draft/:id', authenticate, cancelDraft)
