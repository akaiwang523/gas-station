import { Router } from 'express'
import { lookupCaller, createFromCall } from '../controllers/callerController'

export const callerRoutes = Router()
callerRoutes.post('/lookup', lookupCaller)
callerRoutes.post('/create', createFromCall)
