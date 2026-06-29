import { Router } from 'express'
import { handleLineWebhook } from '../controllers/lineController'
import crypto from 'crypto'
import express from 'express'

export const lineRoutes = Router()

// LINE webhook 需要 raw body 驗證簽名
lineRoutes.post('/webhook', express.raw({ type: 'application/json' }), handleLineWebhook)
