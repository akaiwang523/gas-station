import { Request, Response } from 'express'
import crypto from 'crypto'
import { db } from '../lib/db'

const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET!

// 驗證 LINE 簽名
function verifySignature(body: Buffer, signature: string): boolean {
  const hash = crypto.createHmac('SHA256', CHANNEL_SECRET).update(body).digest('base64')
  return hash === signature
}

// 傳訊息給使用者
async function replyMessage(replyToken: string, messages: any[]) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ACCESS_TOKEN}`
    },
    body: JSON.stringify({ replyToken, messages })
  })
}

// 主選單按鈕
function mainMenu() {
  return {
    type: 'template',
    altText: '請選擇服務',
    template: {
      type: 'buttons',
      title: '🔥 瓦斯行服務',
      text: '請選擇您需要的服務',
      actions: [
        { type: 'postback', label: '🛒 我要叫瓦斯', data: 'action=order' },
        { type: 'postback', label: '📋 查詢訂單狀態', data: 'action=status' },
        { type: 'postback', label: '📞 聯絡我們', data: 'action=contact' }
      ]
    }
  }
}

// 規格選單
function gasTypeMenu() {
  return {
    type: 'template',
    altText: '請選擇瓦斯規格',
    template: {
      type: 'buttons',
      title: '選擇規格',
      text: '請選擇您需要的瓦斯規格',
      actions: [
        { type: 'postback', label: '20kg 桶裝', data: 'action=gas_type&type=BOTTLED_20KG' },
        { type: 'postback', label: '16kg 桶裝', data: 'action=gas_type&type=BOTTLED_16KG' },
        { type: 'postback', label: '10kg 桶裝', data: 'action=gas_type&type=BOTTLED_10KG' },
        { type: 'postback', label: '4kg 桶裝', data: 'action=gas_type&type=BOTTLED_4KG' }
      ]
    }
  }
}

// 數量選單
function quantityMenu(gasType: string) {
  return {
    type: 'template',
    altText: '請選擇數量',
    template: {
      type: 'buttons',
      title: '選擇數量',
      text: '請選擇桶數',
      actions: [
        { type: 'postback', label: '1 桶', data: `action=quantity&type=${gasType}&qty=1` },
        { type: 'postback', label: '2 桶', data: `action=quantity&type=${gasType}&qty=2` },
        { type: 'postback', label: '3 桶', data: `action=quantity&type=${gasType}&qty=3` },
        { type: 'postback', label: '其他數量', data: `action=quantity_custom&type=${gasType}` }
      ]
    }
  }
}

// 時段選單
function timeSlotMenu(gasType: string, qty: number) {
  return {
    type: 'template',
    altText: '請選擇配送時段',
    template: {
      type: 'buttons',
      title: '選擇配送時段',
      text: '請選擇希望的配送時段',
      actions: [
        { type: 'postback', label: '上午 9-12 點', data: `action=timeslot&type=${gasType}&qty=${qty}&slot=上午9-12點` },
        { type: 'postback', label: '下午 12-17 點', data: `action=timeslot&type=${gasType}&qty=${qty}&slot=下午12-17點` },
        { type: 'postback', label: '傍晚 17-20 點', data: `action=timeslot&type=${gasType}&qty=${qty}&slot=傍晚17-20點` },
        { type: 'postback', label: '指定時間', data: `action=timeslot_custom&type=${gasType}&qty=${qty}` }
      ]
    }
  }
}

// 使用者狀態暫存（記憶對話狀態）
const userState: Record<string, any> = {}

export async function handleLineWebhook(req: Request, res: Response) {
  const signature = req.headers['x-line-signature'] as string
  const rawBody = JSON.stringify(req.body)

  const hash = crypto.createHmac('SHA256', CHANNEL_SECRET).update(rawBody).digest('base64')
  if (hash !== signature) {
    return res.status(401).send('Unauthorized')
  }

  const payload = req.body
  res.status(200).send('OK')

  for (const event of payload.events) {
    const userId = event.source.userId
    const replyToken = event.replyToken

    // 文字訊息
    if (event.type === 'message' && event.message.type === 'text') {
      const text = event.message.text.trim()

      // 等待綁定電話號碼
      if (userState[userId]?.step === 'waiting_phone') {
        const phone = text.replace(/[^\d]/g, '')
        const [rows] = await db.query(
          `SELECT id, name FROM customers WHERE phone = ? AND status = 'ACTIVE'`,
          [phone]
        ) as any
        if (rows.length === 0) {
          userState[userId] = { step: 'waiting_name', phone }
          await replyMessage(replyToken, [{ type: 'text', text: '您是新客戶，歡迎！\n\n📝 建立帳號（步驟 1/2）\n請輸入您的姓名：' }])
        } else {
          const customer = rows[0]
          await db.query(
            `INSERT INTO line_users (line_user_id, customer_id) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE customer_id = ?`,
            [userId, customer.id, customer.id]
          )
          userState[userId] = {}
          await replyMessage(replyToken, [
            { type: 'text', text: `✅ 綁定成功！您好，${customer.name}！` },
            mainMenu()
          ])
        }
        continue
      }

      if (userState[userId]?.step === 'waiting_name') {
        const name = text.trim()
        userState[userId] = { ...userState[userId], step: 'waiting_address', name }
        await replyMessage(replyToken, [{ type: 'text', text: `📝 建立帳號（步驟 2/2）\n請輸入您的配送地址：` }])
        continue
      }

      if (userState[userId]?.step === 'waiting_address') {
        const { phone, name } = userState[userId]
        const address = text.trim()
        const [result] = await db.query(
          `INSERT INTO customers (name, phone, address, gas_type, status, delivery_cycle)
           VALUES (?, ?, ?, 'BOTTLED_20KG', 'ACTIVE', 'ON_CALL')`,
          [name, phone, address]
        ) as any
        const customerId = (result as any).insertId
        await db.query(
          `INSERT INTO line_users (line_user_id, customer_id) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE customer_id = ?`,
          [userId, customerId, customerId]
        )
        userState[userId] = {}
        await replyMessage(replyToken, [
          { type: 'text', text: `✅ 建檔完成！您好，${name}！\n日後可直接使用此帳號訂購。` },
          mainMenu()
        ])
        continue
      }

      // 等待自訂數量
      if (userState[userId]?.step === 'waiting_qty') {
        const qty = parseInt(text)
        if (isNaN(qty) || qty <= 0) {
          await replyMessage(replyToken, [{ type: 'text', text: '請輸入有效的數量（正整數）' }])
          continue
        }
        const gasType = userState[userId].gasType
        userState[userId] = { step: 'waiting_timeslot', gasType, qty }
        await replyMessage(replyToken, [timeSlotMenu(gasType, qty)])
        continue
      }

      // 等待自訂時間
      if (userState[userId]?.step === 'waiting_time') {
        const { gasType, qty } = userState[userId]
        userState[userId] = {}
        await createLineOrder(userId, replyToken, gasType, qty, `指定時間：${text}`)
        continue
      }

      // 預設回主選單
      const [binding] = await db.query(
        `SELECT customer_id FROM line_users WHERE line_user_id = ?`, [userId]
      ) as any
      if (!binding[0]) {
        userState[userId] = { step: 'waiting_phone' }
        await replyMessage(replyToken, [{ type: 'text', text: '歡迎使用瓦斯訂購服務！\n請先輸入您的電話號碼進行綁定：' }])
      } else {
        await replyMessage(replyToken, [mainMenu()])
      }
    }

    // Postback 事件（按鈕點擊）
    if (event.type === 'postback') {
      const params = new URLSearchParams(event.postback.data)
      const action = params.get('action')

      if (action === 'order') {
        const [binding] = await db.query(
          `SELECT customer_id FROM line_users WHERE line_user_id = ?`, [userId]
        ) as any
        if (!binding[0]) {
          userState[userId] = { step: 'waiting_phone' }
          await replyMessage(replyToken, [{ type: 'text', text: '請先輸入您的電話號碼進行綁定：' }])
        } else {
          await replyMessage(replyToken, [gasTypeMenu()])
        }
      }

      else if (action === 'gas_type') {
        const gasType = params.get('type')!
        userState[userId] = { step: 'waiting_qty_select', gasType }
        await replyMessage(replyToken, [quantityMenu(gasType)])
      }

      else if (action === 'quantity') {
        const gasType = params.get('type')!
        const qty = parseInt(params.get('qty')!)
        userState[userId] = { step: 'waiting_timeslot', gasType, qty }
        await replyMessage(replyToken, [timeSlotMenu(gasType, qty)])
      }

      else if (action === 'quantity_custom') {
        const gasType = params.get('type')!
        userState[userId] = { step: 'waiting_qty', gasType }
        await replyMessage(replyToken, [{ type: 'text', text: '請輸入您需要的桶數：' }])
      }

      else if (action === 'timeslot') {
        const gasType = params.get('type')!
        const qty = parseInt(params.get('qty')!)
        const slot = params.get('slot')!
        userState[userId] = {}
        await createLineOrder(userId, replyToken, gasType, qty, slot)
      }

      else if (action === 'timeslot_custom') {
        const gasType = params.get('type')!
        const qty = parseInt(params.get('qty')!)
        userState[userId] = { step: 'waiting_time', gasType, qty }
        await replyMessage(replyToken, [{ type: 'text', text: '請輸入希望的配送時間（例如：17:00）：' }])
      }

      else if (action === 'status') {
        const [binding] = await db.query(
          `SELECT customer_id FROM line_users WHERE line_user_id = ?`, [userId]
        ) as any
        if (!binding[0]) {
          userState[userId] = { step: 'waiting_phone' }
          await replyMessage(replyToken, [{ type: 'text', text: '請先輸入您的電話號碼進行綁定：' }])
        } else {
          const [orders] = await db.query(
            `SELECT o.id, o.status, o.created_at, oi.gas_type, oi.quantity
             FROM orders o
             LEFT JOIN order_items oi ON oi.order_id = o.id
             WHERE o.customer_id = ? AND o.status NOT IN ('CANCELLED','DELIVERED')
             ORDER BY o.created_at DESC LIMIT 3`,
            [binding[0].customer_id]
          ) as any
          if (orders.length === 0) {
            await replyMessage(replyToken, [{ type: 'text', text: '目前沒有進行中的訂單。' }])
          } else {
            const STATUS: Record<string, string> = {
              PENDING: '待派送', ASSIGNED: '已指派', DELIVERING: '配送中'
            }
            const text = orders.map((o: any) =>
              `訂單 #${o.id}：${o.gas_type?.replace('BOTTLED_','').replace('KG','kg')} × ${o.quantity} 桶\n狀態：${STATUS[o.status] || o.status}`
            ).join('\n\n')
            await replyMessage(replyToken, [{ type: 'text', text }])
          }
        }
      }

      else if (action === 'contact') {
        await replyMessage(replyToken, [{ type: 'text', text: '📞 請直接撥打電話聯絡我們，感謝！' }])
      }
    }

    // 加入好友
    if (event.type === 'follow') {
      const [binding] = await db.query(
        `SELECT customer_id FROM line_users WHERE line_user_id = ?`, [userId]
      ) as any
      if (!binding[0]) {
        userState[userId] = { step: 'waiting_phone' }
        await replyMessage(replyToken, [{ type: 'text', text: '歡迎加入瓦斯訂購服務！\n請輸入您的電話號碼進行綁定：' }])
      } else {
        await replyMessage(replyToken, [
          { type: 'text', text: '歡迎回來！' },
          mainMenu()
        ])
      }
    }
  }
}

async function createLineOrder(userId: string, replyToken: string, gasType: string, qty: number, timeSlot: string) {
  const [binding] = await db.query(
    `SELECT customer_id FROM line_users WHERE line_user_id = ?`, [userId]
  ) as any
  if (!binding[0]) return

  const customerId = binding[0].customer_id
  const [customers] = await db.query(
    `SELECT price_override, default_unit_price FROM customers WHERE id = ?`, [customerId]
  ) as any
  const unitPrice = customers[0]?.price_override || customers[0]?.default_unit_price || 800
  const totalAmount = qty * unitPrice

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [result] = await conn.query(
      `INSERT INTO orders (customer_id, quantity, unit_price, total_amount, status, note, payment_type)
       VALUES (?, ?, ?, ?, 'PENDING', ?, 'CASH')`,
      [customerId, qty, unitPrice, totalAmount, `LINE預訂 / ${timeSlot}`]
    ) as any
    const orderId = result.insertId
    await conn.query(
      `INSERT INTO order_items (order_id, gas_type, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)`,
      [orderId, gasType, qty, unitPrice, totalAmount]
    )
    await conn.commit()
    await replyMessage(replyToken, [{
      type: 'text',
      text: `✅ 訂單已收到！\n\n規格：${gasType.replace('BOTTLED_','').replace('KG','kg')} × ${qty} 桶\n配送時段：${timeSlot}\n\n我們將盡快為您配送，謝謝！`
    }])
  } catch (err) {
    await conn.rollback()
    await replyMessage(replyToken, [{ type: 'text', text: '訂單建立失敗，請稍後再試或直接來電。' }])
  } finally {
    conn.release()
  }
}
