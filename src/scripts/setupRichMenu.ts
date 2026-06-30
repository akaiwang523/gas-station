import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!

async function main() {
  if (!ACCESS_TOKEN) {
    console.error('缺少 LINE_CHANNEL_ACCESS_TOKEN 環境變數')
    process.exit(1)
  }

  // 0. 清除舊的 Rich Menu，避免重複執行留下空殼選單
  console.log('清除舊的 Rich Menu...')
  const listRes = await fetch('https://api.line.me/v2/bot/richmenu/list', {
    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }
  })
  const listData = await listRes.json() as any
  for (const menu of listData.richmenus || []) {
    await fetch(`https://api.line.me/v2/bot/richmenu/${menu.richMenuId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }
    })
    console.log('已刪除舊選單：', menu.richMenuId)
  }

  // 1. 建立 Rich Menu 結構（2500x843，2x2 四宮格）
  const richMenuBody = {
    size: { width: 2500, height: 843 },
    selected: true,
    name: '瓦斯行主選單',
    chatBarText: '展開選單',
    areas: [
      {
        bounds: { x: 0, y: 0, width: 1250, height: 421 },
        action: { type: 'postback', data: 'action=order' }
      },
      {
        bounds: { x: 1250, y: 0, width: 1250, height: 421 },
        action: { type: 'postback', data: 'action=status' }
      },
      {
        bounds: { x: 0, y: 421, width: 1250, height: 422 },
        action: { type: 'postback', data: 'action=faq' }
      },
      {
        bounds: { x: 1250, y: 421, width: 1250, height: 422 },
        action: { type: 'postback', data: 'action=contact' }
      }
    ]
  }

  console.log('建立 Rich Menu 結構...')
  const createRes = await fetch('https://api.line.me/v2/bot/richmenu', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ACCESS_TOKEN}`
    },
    body: JSON.stringify(richMenuBody)
  })
  const createData = await createRes.json() as any
  if (!createData.richMenuId) {
    console.error('建立失敗：', createData)
    process.exit(1)
  }
  const richMenuId = createData.richMenuId
  console.log('建立成功，richMenuId =', richMenuId)

  // 2. 上傳圖片（用腳本自身位置算出絕對路徑，不依賴執行時的工作目錄）
  console.log('上傳圖片中...')
  const imagePath = path.join(__dirname, 'richmenu.png')
  const imageBuffer = fs.readFileSync(imagePath)
  const uploadRes = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'POST',
    headers: {
      'Content-Type': 'image/png',
      'Authorization': `Bearer ${ACCESS_TOKEN}`
    },
    body: imageBuffer
  })
  if (uploadRes.status !== 200) {
    console.error('圖片上傳失敗：', await uploadRes.text())
    process.exit(1)
  }
  console.log('圖片上傳成功')

  // 3. 設為預設選單（所有使用者都會看到）
  console.log('設定為預設選單...')
  const setDefaultRes = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }
  })
  if (setDefaultRes.status !== 200) {
    console.error('設定預設選單失敗：', await setDefaultRes.text())
    process.exit(1)
  }
  console.log('✅ 完成！Rich Menu 已設定為預設選單，richMenuId =', richMenuId)
}

main()
