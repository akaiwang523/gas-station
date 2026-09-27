import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { asyncHandler } from '../lib/asyncHandler'
import { getReconcileDay, setVerified, voidUnverified } from '../controllers/reconcileController'

export const reconcileRoutes = Router()
reconcileRoutes.use(authenticate)
reconcileRoutes.get('/', asyncHandler(getReconcileDay))
reconcileRoutes.post('/verify', asyncHandler(setVerified))
reconcileRoutes.post('/void', asyncHandler(voidUnverified))
