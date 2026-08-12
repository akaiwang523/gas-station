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

// 選好一種規格的數量之後，問要不要再加其他規格（例如 20kg 兩桶 + 16kg 一桶），
// 不用像以前那樣一種規格要整個流程重跑一次、變成兩張分開的訂單——
// 全部品項會併成同一張訂單一次送出。使用者按過「什麼時候要」拿掉了，
// 一律當「今天盡快」處理，不用另外問
function moreItemsMenu() {
  return {
    type: 'template',
    altText: '還需要其他規格嗎？',
    template: {
      type: 'buttons',
      title: '還需要其他規格嗎？',
      text: '可以一次訂好幾種規格',
      actions: [
        { type: 'postback', label: '➕ 再加一種規格', data: 'action=add_more' },
        { type: 'postback', label: '✅ 完成，送出訂單', data: 'action=submit_cart' }
      ]
    }
  }
}

// 使用者狀態暫存（記憶對話狀態）
const userState: Record<string, any> = {}

// 日期選單：今天/明天/後天。品項都選完（購物車確定）之後才問一次，
// 因為配送日是整張訂單共用的，不是每種規格各自選一次
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

function dateMenu() {
  return {
    type: 'template',
    altText: '請選擇配送日期',
    template: {
      type: 'buttons',
      title: '選擇配送日期',
      text: '請選擇希望的配送日期',
      actions: [
        { type: 'postback', label: '今天', data: 'action=order_date&date=today' },
        { type: 'postback', label: '明天', data: 'action=order_date&date=tomorrow' },
        { type: 'postback', label: '後天', data: 'action=order_date&date=dayafter' }
      ]
    }
  }
}

// 時段選單：日期選完之後再問一次，一樣是整張訂單共用，不分品項各自問
function timeSlotMenu() {
  return {
    type: 'template',
    altText: '請選擇配送時段',
    template: {
      type: 'buttons',
      title: '選擇配送時段',
      text: '請選擇希望的配送時段',
      actions: [
        { type: 'postback', label: '上午', data: 'action=order_timeslot&slot=上午' },
        { type: 'postback', label: '中午', data: 'action=order_timeslot&slot=中午' },
        { type: 'postback', label: '傍晚', data: 'action=order_timeslot&slot=傍晚' }
      ]
    }
  }
}

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
        const cart = [...(userState[userId].cart || []), { gasType, qty }]
        userState[userId] = { step: 'cart_more', cart }
        await replyMessage(replyToken, [moreItemsMenu()])
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
          userState[userId] = { cart: [] }
          await replyMessage(replyToken, [gasTypeMenu()])
        }
      }

      else if (action === 'gas_type') {
        const gasType = params.get('type')!
        const cart = userState[userId]?.cart || []
        userState[userId] = { step: 'waiting_qty_select', gasType, cart }
        await replyMessage(replyToken, [quantityMenu(gasType)])
      }

      else if (action === 'quantity') {
        const gasType = params.get('type')!
        const qty = parseInt(params.get('qty')!)
        const cart = [...(userState[userId]?.cart || []), { gasType, qty }]
        userState[userId] = { step: 'cart_more', cart }
        await replyMessage(replyToken, [moreItemsMenu()])
      }

      else if (action === 'quantity_custom') {
        const gasType = params.get('type')!
        const cart = userState[userId]?.cart || []
        userState[userId] = { step: 'waiting_qty', gasType, cart }
        await replyMessage(replyToken, [{ type: 'text', text: '請輸入您需要的桶數：' }])
      }

      // 還要再加一種規格：回到規格選單，購物車內容留著繼續累加
      else if (action === 'add_more') {
        const cart = userState[userId]?.cart || []
        userState[userId] = { cart }
        await replyMessage(replyToken, [gasTypeMenu()])
      }

      // 完成，購物車裡的品項先記著，問一次配送日期再真的送出
      else if (action === 'submit_cart') {
        const cart = userState[userId]?.cart || []
        if (cart.length === 0) {
          userState[userId] = {}
          await replyMessage(replyToken, [{ type: 'text', text: '還沒有選擇任何品項喔，請重新開始下單：' }, mainMenu()])
        } else {
          userState[userId] = { cart }
          await replyMessage(replyToken, [dateMenu()])
        }
      }

      // 選好配送日期，再問一次時段，購物車跟日期先記著
      else if (action === 'order_date') {
        const cart = userState[userId]?.cart || []
        const dateChoice = params.get('date')!
        if (cart.length === 0) {
          userState[userId] = {}
          await replyMessage(replyToken, [{ type: 'text', text: '購物車是空的，請重新開始下單：' }, mainMenu()])
        } else {
          userState[userId] = { cart, dateChoice }
          await replyMessage(replyToken, [timeSlotMenu()])
        }
      }

      // 選好時段，購物車裡累積的所有品項合併成一張訂單一次送出
      else if (action === 'order_timeslot') {
        const cart = userState[userId]?.cart || []
        const dateChoice = userState[userId]?.dateChoice || 'today'
        const slot = params.get('slot')!
        userState[userId] = {}
        if (cart.length === 0) {
          await replyMessage(replyToken, [{ type: 'text', text: '購物車是空的，請重新開始下單：' }, mainMenu()])
        } else {
          const { scheduledDate, label } = resolveDateChoice(dateChoice)
          await createLineOrder(userId, replyToken, cart, scheduledDate, `${label} ${slot}`)
        }
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
          // 先找出上一張訂單的 id，再單獨撈出該筆訂單底下的全部品項——
          // 不能直接 JOIN 完再 LIMIT 1，上一單如果有好幾種規格，LIMIT 1 會把其他品項砍掉，
          // 一鍵再訂就只會訂到其中一種規格
          const [lastOrderRows] = await db.query(
            `SELECT id FROM orders WHERE customer_id = ? AND status != 'CANCELLED' ORDER BY created_at DESC LIMIT 1`,
            [customerId]
          ) as any
          const lastOrderId = lastOrderRows[0]?.id
          const lastItems = lastOrderId
            ? (await db.query(`SELECT gas_type, quantity FROM order_items WHERE order_id = ?`, [lastOrderId]) as any)[0]
            : []
          if (!lastItems.length) {
            await replyMessage(replyToken, [
              { type: 'text', text: '您還沒有歷史訂單可以複製，請改用「我要叫瓦斯」下單：' },
              mainMenu()
            ])
          } else {
            const cart = lastItems.map((i: any) => ({ gasType: i.gas_type, qty: i.quantity }))
            await createLineOrder(userId, replyToken, cart)
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

// items：一張訂單裡的所有品項（可能不只一種規格）；scheduledDate/dateLabel 是配送日期
async function createLineOrder(
  userId: string, replyToken: string, items: { gasType: string; qty: number }[],
  scheduledDate: string | null = null, dateLabel: string = '今天'
) {
  const [binding] = await db.query(
    `SELECT customer_id FROM line_users WHERE line_user_id = ?`, [userId]
  ) as any
  if (!binding[0]) return

  const customerId = binding[0].customer_id
  const [customers] = await db.query(
    `SELECT price_override FROM customers WHERE id = ?`, [customerId]
  ) as any
  const priceOverride = customers[0]?.price_override || null

  // 單價統一跟其他進單管道（快速接單/來電草稿/固定配送自動建單）同一套邏輯：
  // 優先用客戶的特殊單價，沒有就用目前的基準價，不使用已經停用的 default_unit_price 欄位。
  // 每個品項各自的基準價不同，一次撈全部再逐項查表
  const [baselineRows] = await db.query(
    `SELECT \`key\`, \`value\` FROM settings WHERE \`key\` LIKE 'baseline_price_%'`
  ) as any
  const baselinePrice: Record<string, number> = {}
  for (const row of baselineRows) baselinePrice[row.key.replace('baseline_price_', '')] = Number(row.value)

  const priced = items.map(it => {
    const unitPrice = priceOverride || baselinePrice[it.gasType] || 800
    return { ...it, unitPrice, subtotal: it.qty * unitPrice }
  })
  const totalQuantity = priced.reduce((s, it) => s + it.qty, 0)
  const totalAmount = priced.reduce((s, it) => s + it.subtotal, 0)
  // 主表 unit_price 是舊資料相容用的加權平均，實際品項明細以 order_items 為準
  const avgUnitPrice = totalQuantity > 0 ? totalAmount / totalQuantity : 0

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [result] = await conn.query(
      `INSERT INTO orders (customer_id, quantity, unit_price, total_amount, status, note, payment_type, source, scheduled_date)
       VALUES (?, ?, ?, ?, 'PENDING', ?, 'CASH', 'LINE', ?)`,
      [customerId, totalQuantity, avgUnitPrice, totalAmount, `LINE預訂 / ${dateLabel}`, scheduledDate]
    ) as any
    const orderId = result.insertId
    for (const it of priced) {
      await conn.query(
        `INSERT INTO order_items (order_id, gas_type, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)`,
        [orderId, it.gasType, it.qty, it.unitPrice, it.subtotal]
      )
    }
    await conn.commit()
    const itemsSummary = priced
      .map(it => `${it.gasType.replace('BOTTLED_', '').replace('KG', 'kg')} × ${it.qty}`)
      .join('、')
    // LINE buttons template 的 text 欄位有長度上限，品項種類多的話組合起來的字串長度不受控，
    // 這裡截短一下避免超過上限導致整則訊息送不出去
    const itemsDisplay = itemsSummary.length > 40 ? itemsSummary.slice(0, 40) + '…' : itemsSummary
    await replyMessage(replyToken, [{
      type: 'template',
      altText: `訂單已收到：${itemsSummary}`,
      template: {
        type: 'buttons',
        title: '✅ 訂單已收到',
        text: `${itemsDisplay}\n${dateLabel}`,
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
