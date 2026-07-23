import { useState, useEffect } from 'react'
import { api } from '../lib/api'

const GAS_LABELS: Record<string, string> = {
  BOTTLED_20KG: '20kg 桶',
  BOTTLED_16KG: '16kg 桶',
  BOTTLED_10KG: '10kg 桶',
  BOTTLED_4KG: '4kg 桶',
}

const GAS_ORDER = ['BOTTLED_20KG', 'BOTTLED_16KG', 'BOTTLED_10KG', 'BOTTLED_4KG']

export default function BaselinePriceSettings({ onClose }: { onClose: () => void }) {
  const [prices, setPrices] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    api.getBaselinePrices()
      .then(res => setPrices(res.prices))
      .catch(() => setError('讀取基準價失敗'))
      .finally(() => setLoading(false))
  }, [])

  function updatePrice(gasType: string, value: string) {
    setPrices(prev => ({ ...prev, [gasType]: Number(value) || 0 }))
    setSuccess(false)
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    try {
      const res = await api.updateBaselinePrices(prices)
      setPrices(res.prices)
      setSuccess(true)
    } catch (e: any) {
      setError(e.message || '儲存失敗')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-bold text-gray-800">🔧 基準價設定</h2>
          <button onClick={onClose} className="text-gray-400 text-xl">×</button>
        </div>
        <p className="text-sm text-gray-500">
          這裡設定的價格是全站的基準價。沒有設定「特殊單價」的客戶，快速接單時會自動帶入這裡的數字。
        </p>

        {loading ? (
          <div className="text-center text-gray-400 py-6">載入中...</div>
        ) : (
          <div className="space-y-3">
            {GAS_ORDER.map(gasType => (
              <div key={gasType} className="flex items-center justify-between gap-3">
                <label className="text-sm font-medium text-gray-700 w-16">{GAS_LABELS[gasType]}</label>
                <div className="flex items-center gap-1 flex-1">
                  <span className="text-gray-400">$</span>
                  <input
                    type="number"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-orange-400"
                    value={prices[gasType] ?? ''}
                    onChange={e => updatePrice(gasType, e.target.value)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {error && <div className="text-red-500 text-sm">{error}</div>}
        {success && <div className="text-green-600 text-sm">✅ 已儲存，之後新單會用新的基準價</div>}

        <button
          onClick={handleSave}
          disabled={loading || saving}
          className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 text-white font-bold py-3 rounded-xl transition"
        >
          {saving ? '儲存中...' : '儲存'}
        </button>
      </div>
    </div>
  )
}
