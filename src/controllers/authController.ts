import { Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { db } from '../lib/db'
import { AuthRequest } from '../middleware/auth'

export async function login(req: Request, res: Response) {
  const { username, password } = req.body
  if (!username || !password) return res.status(400).json({ error: '請輸入帳號密碼' })

  const [rows] = await db.query('SELECT * FROM users WHERE username = ? AND is_active = 1', [username]) as any
  const user = rows[0]
  if (!user) return res.status(401).json({ error: '帳號不存在或已停用' })

  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) return res.status(401).json({ error: '密碼錯誤' })

  const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET!, { expiresIn: '7d' })
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } })
}

export async function me(req: AuthRequest, res: Response) {
  const [rows] = await db.query('SELECT id, name, username, role FROM users WHERE id = ?', [req.user!.id]) as any
  res.json(rows[0])
}