import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { getTodayReport, getMonthReport, exportCsv, getHotspots } from '../controllers/reportController'

export const reportRoutes = Router()
reportRoutes.use(authenticate)
reportRoutes.get('/today', getTodayReport)
reportRoutes.get('/month', getMonthReport)
reportRoutes.get('/export', exportCsv)
reportRoutes.get('/hotspots', getHotspots)
