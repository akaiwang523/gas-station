import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
dotenv.config()

export const db = mysql.createPool({
  uri: process.env.DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 10,
})
