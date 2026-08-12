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

// 傳訊息給使用者（回覆客戶主動傳來的訊息用）
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

// 主動推播訊息給使用者（不需要客戶先傳訊息，系統可以主動發起——例如預測補貨提醒）
export async function pushMessage(lineUserId: string, messages: any[]) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ACCESS_TOKEN}`
    },
    body: JSON.stringify({ to: lineUserId, messages })
  })
  if (res.status !== 200) {
    const errText = await res.text()
    throw new Error(`LINE 推播失敗: ${errText}`)
  }
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
        { type: 'postback', label: '⚡ 一鍵叫瓦斯', data: 'action=quick_order' },
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

// 日期選單：今天/明天/後天，讓 LINE 訂單也能像來電草稿一樣預約未來的配送日
const DATE_CHOICE_OFFSET: Record<string, number> = { today: 0, tomorrow: 1, dayafter: 2 }
const DATE_CHOICE_LABEL: Record<string, string> = { today: '今天', tomorrow: '明天', dayafter: '後天' }

// 用 Asia/Taipei 時區算出「今天 + N 天」的日期字串（YYYY-MM-DD）
function taipeiDateString(daysOffset: number): string {
  const taipeiNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }))
  taipeiNow.setDate(taipeiNow.getDate() + daysOffset)
  const y = taipeiNow.getFullYear()
  const m = String(taipeiNow.getMonth() + 1).padStart(2, '0')
  const d = String(taipeiNow.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// dateChoice ('today'/'tomorrow'/'dayafter') 轉換成實際要存進 orders.scheduled_date 的值 + 顯示用文字
// today 存 null（跟其他管道一樣代表「今天，不特別排定」），tomorrow/dayafter 存實際日期字串
function resolveDateChoice(dateChoice: string): { scheduledDate: string | null, label: string } {
  const offset = DATE_CHOICE_OFFSET[dateChoice] ?? 0
  const dateStr = taipeiDateString(offset)
  const [, m, d] = dateStr.split('-')
  const label = `${DATE_CHOICE_LABEL[dateChoice] || '今天'} ${Number(m)}/${Number(d)}`
  return { scheduledDate: offset === 0 ? null : dateStr, label }
}

function dateMenu(gasType: string, qty: number) {
  return {
    type: 'template',
    altText: '請選擇配送日期',
    template: {
      type: 'buttons',
      title: '選擇配送日期',
      text: '請選擇希望的配送日期',
      actions: [
        { type: 'postback', label: '今天', data: `action=date&type=${gasType}&qty=${qty}&date=today` },
        { type: 'postback', label: '明天', data: `action=date&type=${gasType}&qty=${qty}&date=tomorrow` },
        { type: 'postback', label: '後天', data: `action=date&type=${gasType}&qty=${qty}&date=dayafter` }
      ]
    }
  }
}

// 選好規格數量之後的「何時要」選單：取代直接跳「選日期」再「選時段」共兩步，
// 大多數人其實就是要「今天盡快」，這裡直接給一個一鍵完成的快速選項，
// 真的有指定日期/時段需求的人再點下面那個走原本的兩步流程
function whenMenu(gasType: string, qty: number) {
  return {
    type: 'template',
    altText: '請選擇配送時間',
    template: {
      type: 'buttons',
      title: '什麼時候要？',
      text: '大部分人選「盡快」就可以了',
      actions: [
        { type: 'postback', label: '⚡ 盡快（今天）', data: `action=quick_when&type=${gasType}&qty=${qty}` },
        { type: 'postback', label: '📅 指定日期/時段', data: `action=want_schedule&type=${gasType}&qty=${qty}` }
      ]
    }
  }
}

// 時段選單
function timeSlotMenu(gasType: string, qty: number, dateChoice: string) {
  return {
    type: 'template',
    altText: '請選擇配送時段',
    template: {
      type: 'buttons',
      title: '選擇配送時段',
      text: '請選擇希望的配送時段',
      actions: [
        { type: 'postback', label: '上午 9-12 點', data: `action=timeslot&type=${gasType}&qty=${qty}&date=${dateChoice}&slot=上午9-12點` },
        { type: 'postback', label: '下午 12-17 點', data: `action=timeslot&type=${gasType}&qty=${qty}&date=${dateChoice}&slot=下午12-17點` },
        { type: 'postback', label: '傍晚 17-20 點', data: `action=timeslot&type=${gasType}&qty=${qty}&date=${dateChoice}&slot=傍晚17-20點` },
        { type: 'postback', label: '指定時間', data: `action=timeslot_custom&type=${gasType}&qty=${qty}&date=${dateChoice}` }
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
        // 主電話、副電話、customer_phones 三個地方都要比對到——客戶原本可能登記在
        // 副電話或第三支以後的電話，只查主電話會誤判成新客戶、多開一筆重複資料
        const [rows] = await db.query(
          `SELECT id, name FROM customers c WHERE (c.phone = ? OR c.phone2 = ? OR EXISTS (
            SELECT 1 FROM customer_phones cp WHERE cp.customer_id = c.id AND cp.phone = ?
          )) AND c.status = 'ACTIVE'`,
          [phone, phone, phone]
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
        userState[userId] = { step: 'waiting_date_select', gasType, qty }
        await replyMessage(replyToken, [whenMenu(gasType, qty)])
        continue
      }

      // 等待自訂時間
      if (userState[userId]?.step === 'waiting_time') {
        const { gasType, qty, dateChoice } = userState[userId]
        userState[userId] = {}
        const { scheduledDate, label } = resolveDateChoice(dateChoice)
        await createLineOrder(userId, replyToken, gasType, qty, `${label} 指定時間：${text}`, scheduledDate)
        continue
      }

      // 自由打字問問題（不是照按鈕點選單，也不在任何進行中的流程步驟裡）：
      // 不回覆客戶（避免干擾），但存起來讓工作人員在網站上看得到——
      // 有些客戶傳訊息不是要叫瓦斯，是問其他業務相關的事，完全不回覆又不留紀錄的話會漏接
      try {
        const [binding] = await db.query(
          `SELECT customer_id FROM line_users WHERE line_user_id = ?`, [userId]
        ) as any
        await db.query(
          `INSERT INTO line_inquiries (line_user_id, customer_id, message) VALUES (?, ?, ?)`,
          [userId, binding[0]?.customer_id || null, text]
        )
      } catch (err) {
        console.error('[line_inquiries insert]', err)
      }
      continue
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
        userState[userId] = { step: 'waiting_date_select', gasType, qty }
        await replyMessage(replyToken, [whenMenu(gasType, qty)])
      }

      else if (action === 'quick_when') {
        const gasType = params.get('type')!
        const qty = parseInt(params.get('qty')!)
        userState[userId] = {}
        await createLineOrder(userId, replyToken, gasType, qty, '盡快配送')
      }

      else if (action === 'want_schedule') {
        const gasType = params.get('type')!
        const qty = parseInt(params.get('qty')!)
        userState[userId] = { step: 'waiting_date_select', gasType, qty }
        await replyMessage(replyToken, [dateMenu(gasType, qty)])
      }

      else if (action === 'quantity_custom') {
        const gasType = params.get('type')!
        userState[userId] = { step: 'waiting_qty', gasType }
        await replyMessage(replyToken, [{ type: 'text', text: '請輸入您需要的桶數：' }])
      }

      else if (action === 'date') {
        const gasType = params.get('type')!
        const qty = parseInt(params.get('qty')!)
        const dateChoice = params.get('date')!
        userState[userId] = {}
        await replyMessage(replyToken, [timeSlotMenu(gasType, qty, dateChoice)])
      }

      else if (action === 'timeslot') {
        const gasType = params.get('type')!
        const qty = parseInt(params.get('qty')!)
        const slot = params.get('slot')!
        const dateChoice = params.get('date') || 'today'
        userState[userId] = {}
        const { scheduledDate, label } = resolveDateChoice(dateChoice)
        await createLineOrder(userId, replyToken, gasType, qty, `${label} ${slot}`, scheduledDate)
      }

      else if (action === 'timeslot_custom') {
        const gasType = params.get('type')!
        const qty = parseInt(params.get('qty')!)
        const dateChoice = params.get('date') || 'today'
        userState[userId] = { step: 'waiting_time', gasType, qty, dateChoice }
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
             ORDER BY o.created_at DESC LIMIT 1`,
            [binding[0].customer_id]
          ) as any
          if (orders.length === 0) {
            await replyMessage(replyToken, [{ type: 'text', text: '目前沒有進行中的訂單。' }])
          } else {
            const o = orders[0]
            const STATUS: Record<string, string> = {
              PENDING: '待派送', ASSIGNED: '已指派', DELIVERING: '配送中'
            }
            const summary = `訂單 #${o.id}：${o.gas_type?.replace('BOTTLED_','').replace('KG','kg')} × ${o.quantity} 桶\n狀態：${STATUS[o.status] || o.status}`

            if (o.status === 'PENDING') {
              await replyMessage(replyToken, [{
                type: 'template',
                altText: summary,
                template: {
                  type: 'buttons',
                  text: summary,
                  actions: [
                    { type: 'postback', label: '❌ 取消訂單', data: `action=cancel_order&order_id=${o.id}` }
                  ]
                }
              }])
            } else if (o.status === 'DELIVERING') {
              await replyMessage(replyToken, [{ type: 'text', text: '您的瓦斯已出發' }])
            } else {
              await replyMessage(replyToken, [{ type: 'text', text: summary }])
            }
          }
        }
      }

      else if (action === 'cancel_order') {
        const orderId = params.get('order_id')!
        const [rows] = await db.query(`SELECT status FROM orders WHERE id = ?`, [orderId]) as any
        if (rows.length === 0) {
          await replyMessage(replyToken, [{ type: 'text', text: '⚠️ 找不到該筆訂單。' }])
        } else if (rows[0].status === 'PENDING') {
          await db.query(`UPDATE orders SET status = 'CANCELLED' WHERE id = ?`, [orderId])
          await replyMessage(replyToken, [{ type: 'text', text: '✅ 訂單已為您取消。' }])
        } else {
          await replyMessage(replyToken, [{ type: 'text', text: '⚠️ 抱歉，司機已經出發，無法直接取消。若需取消請直接點擊下方【聯絡我們】來電通知。' }])
        }
      }

      else if (action === 'quick_order') {
        const [binding] = await db.query(
          `SELECT customer_id FROM line_users WHERE line_user_id = ?`, [userId]
        ) as any
        if (!binding[0]) {
          userState[userId] = { step: 'waiting_phone' }
          await replyMessage(replyToken, [{ type: 'text', text: '請先輸入您的電話號碼進行綁定：' }])
        } else {
          const customerId = binding[0].customer_id
          const [lastOrders] = await db.query(
            `SELECT oi.gas_type, oi.quantity
             FROM orders o
             LEFT JOIN order_items oi ON oi.order_id = o.id
             WHERE o.customer_id = ? AND o.status != 'CANCELLED'
             ORDER BY o.created_at DESC LIMIT 1`,
            [customerId]
          ) as any
          if (lastOrders.length === 0 || !lastOrders[0].gas_type) {
            await replyMessage(replyToken, [
              { type: 'text', text: '您還沒有歷史訂單可以複製，請改用「我要叫瓦斯」下單：' },
              mainMenu()
            ])
          } else {
            const { gas_type, quantity } = lastOrders[0]
            await createLineOrder(userId, replyToken, gas_type, quantity, '盡快配送（一鍵再訂）')
          }
        }
      }

      else if (action === 'contact') {
        await replyMessage(replyToken, [{
          type: 'text',
          text: '🔥 瓦斯品項：\n・20kg 桶裝\n・16kg 桶裝\n・10kg 桶裝\n・4kg 桶裝\n\n🕐 營業時間：\n週一至週六 09:00-20:00\n\n📞 客服電話：\n06-2231668\n06-2264569'
        }])
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

async function createLineOrder(userId: string, replyToken: string, gasType: string, qty: number, timeSlot: string, scheduledDate: string | null = null) {
  const [binding] = await db.query(
    `SELECT customer_id FROM line_users WHERE line_user_id = ?`, [userId]
  ) as any
  if (!binding[0]) return

  const customerId = binding[0].customer_id
  const [customers] = await db.query(
    `SELECT price_override FROM customers WHERE id = ?`, [customerId]
  ) as any
  // 單價統一跟其他進單管道（快速接單/來電草稿/固定配送自動建單）同一套邏輯：
  // 優先用客戶的特殊單價，沒有就用目前的基準價，不使用已經停用的 default_unit_price 欄位
  const [baselineRows] = await db.query(
    `SELECT \`value\` FROM settings WHERE \`key\` = ?`, [`baseline_price_${gasType}`]
  ) as any
  const baselinePrice = baselineRows[0] ? Number(baselineRows[0].value) : 800
  const unitPrice = customers[0]?.price_override || baselinePrice
  const totalAmount = qty * unitPrice

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [result] = await conn.query(
      `INSERT INTO orders (customer_id, quantity, unit_price, total_amount, status, note, payment_type, source, scheduled_date)
       VALUES (?, ?, ?, ?, 'PENDING', ?, 'CASH', 'LINE', ?)`,
      [customerId, qty, unitPrice, totalAmount, `LINE預訂 / ${timeSlot}`, scheduledDate]
    ) as any
    const orderId = result.insertId
    await conn.query(
      `INSERT INTO order_items (order_id, gas_type, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)`,
      [orderId, gasType, qty, unitPrice, totalAmount]
    )
    await conn.commit()
    const gasLabel = gasType.replace('BOTTLED_', '').replace('KG', 'kg')
    // LINE buttons template 的 text 欄位有長度上限，「指定時間」的自訂輸入是使用者自己打的字、
    // 長度不受控，這裡截短一下避免超過上限導致整則訊息送不出去
    const timeSlotDisplay = timeSlot.length > 30 ? timeSlot.slice(0, 30) + '…' : timeSlot
    await replyMessage(replyToken, [{
      type: 'template',
      altText: `訂單已收到：${gasLabel} × ${qty} 桶`,
      template: {
        type: 'buttons',
        title: '✅ 訂單已收到',
        text: `${gasLabel} × ${qty} 桶\n${timeSlotDisplay}`,
        actions: [
          { type: 'postback', label: '📋 查詢訂單狀態', data: 'action=status' }
        ]
      }
    }])
  } catch (err) {
    await conn.rollback()
    await replyMessage(replyToken, [{ type: 'text', text: '訂單建立失敗，請稍後再試或直接來電。' }])
  } finally {
    conn.release()
  }
}

// GET /api/line/inquiries?status=PENDING — 客戶自由打字、不是照選單點選的訊息清單
export async function listLineInquiries(req: Request, res: Response) {
  const { status } = req.query
  const conditions: string[] = []
  const params: any[] = []
  if (status) { conditions.push('li.status = ?'); params.push(status) }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

  const [rows] = await db.query(
    `SELECT li.id, li.line_user_id, li.customer_id, li.message, li.status, li.created_at,
            c.name as customer_name, c.phone as customer_phone
     FROM line_inquiries li
     LEFT JOIN customers c ON c.id = li.customer_id
     ${where}
     ORDER BY li.created_at DESC
     LIMIT 100`,
    params
  ) as any
  res.json({ inquiries: rows })
}

// PATCH /api/line/inquiries/:id/handle — 標記這則訊息已經處理過了
export async function handleLineInquiry(req: Request, res: Response) {
  const id = Number(req.params.id)
  if (!id) return res.status(400).json({ error: '缺少編號' })
  await db.query(`UPDATE line_inquiries SET status = 'HANDLED' WHERE id = ?`, [id])
  res.json({ ok: true })
}
