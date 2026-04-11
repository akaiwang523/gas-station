import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

export interface AuthRequest extends Request {
  user?: { id: number; role: string }
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: '未登入' })
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as { id: number; role: string }
    req.user = payload
    next()
  } catch {
    res.status(401).json({ error: 'Token 無效或已過期' })
  }
}
