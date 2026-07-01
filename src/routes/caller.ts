import { Router } from 'express'
import { lookupCaller, createFromCall, incomingCall, getDraft, confirmDraft, cancelDraft, incomingCallById, bindCallerToCustomer } from '../controllers/callerController'
import { authenticate } from '../middleware/auth'
import { asyncHandler } from '../lib/asyncHandler'
export const callerRoutes = Router()
// MacroDroid 來電觸發（不需要登入，用 apiKey 驗證）
callerRoutes.post('/lookup', asyncHandler(lookupCaller))
callerRoutes.post('/create', asyncHandler(createFromCall))
callerRoutes.post('/incoming', asyncHandler(incomingCall))
// 前端用（需要登入）
callerRoutes.get('/draft', authenticate, asyncHandler(getDraft))
callerRoutes.post('/draft/:id/confirm', authenticate, asyncHandler(confirmDraft))
callerRoutes.delete('/draft/:id', authenticate, asyncHandler(cancelDraft))
callerRoutes.post('/incoming-by-id', authenticate, asyncHandler(incomingCallById))
callerRoutes.post('/bind', authenticate, asyncHandler(bindCallerToCustomer))
