import { Router } from 'express'
import { login, me } from '../controllers/authController'
import { authenticate } from '../middleware/auth'

export const authRoutes = Router()
authRoutes.post('/login', login)
authRoutes.get('/me', authenticate, me)
