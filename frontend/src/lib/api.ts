const BASE = (import.meta as any).env?.VITE_API_URL || ''

function getToken() {
  return localStorage.getItem('token')
}

export function setToken(token: string) {
  localStorage.setItem('token', token)
}

export function clearToken() {
  localStorage.removeItem('token')
}

async function request(path: string, options: RequestInit = {}) {
  const token = getToken()
  const res = await fetch(`${BASE}/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (res.status === 401) {
    clearToken()
    window.location.href = '/login'
    throw new Error('未授權')
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || '發生錯誤')
  }
  return res.json()
}

export const api = {
  // Auth
  login: (username: string, password: string) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),

  // Customers
  searchCustomers: (search: string) =>
    request(`/customers?search=${encodeURIComponent(search)}&limit=10`),
  getCustomer: (id: number) =>
    request(`/customers/${id}`),
  createCustomer: (data: any) =>
    request('/customers', { method: 'POST', body: JSON.stringify(data) }),
  updateCustomer: (id: number, data: any) =>
    request(`/customers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  // Orders
  getOrders: (params?: { status?: string; date?: string; driverId?: number; customerId?: number; limit?: number }) => {
    const q = new URLSearchParams()
    if (params?.status) q.set('status', params.status)
    if (params?.date) q.set('date', params.date)
    if (params?.driverId) q.set('driverId', String(params.driverId))
    if (params?.customerId) q.set('customerId', String(params.customerId))
    if (params?.limit) q.set('limit', String(params.limit))
    return request(`/orders?${q}`)
  },
  getTodaySummary: () => request('/orders/summary'),
  createOrder: (data: any) =>
    request('/orders', { method: 'POST', body: JSON.stringify(data) }),
  updateOrderStatus: (id: number, status: string, driverId?: number) =>
    request(`/orders/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status, driverId }) }),
  collectPayment: (orderId: number, data: any) =>
    request(`/orders/${orderId}/payment`, { method: 'POST', body: JSON.stringify(data) }),

  // AR
  getArBalances: (search?: string, month?: string, tab?: string) => {
    const q = new URLSearchParams()
    if (search) q.set('search', search)
    if (month) q.set('month', month)
    if (tab) q.set('tab', tab)
    return request(`/ar${q.toString() ? '?' + q.toString() : ''}`)
  },
  getCustomerAr: (customerId: number) =>
    request(`/ar/${customerId}`),
  receivePayment: (customerId: number, data: any) =>
    request(`/ar/${customerId}/payment`, { method: 'POST', body: JSON.stringify(data) }),
  getTodayReport: () => request('/reports/today'),
  getMonthReport: (month: string) => request(`/reports/month?month=${month}`),
  getStatement: (customerId: number, month?: string) =>
    request(`/ar/${customerId}/statement${month ? `?month=${month}` : ''}`),
  cancelOrder: (id: number) =>
    request(`/orders/${id}/cancel`, { method: 'PATCH' }),
  deleteOrder: (id: number) =>
    request(`/orders/${id}`, { method: 'DELETE' }),
  deactivateCustomer: (id: number) =>
    request(`/customers/${id}/deactivate`, { method: 'PATCH' }),
  hardDeleteCustomer: (id: number) =>
    request(`/customers/${id}/hard`, { method: 'DELETE' }),
  getCustomerReturns: (customerId: number) =>
    request(`/gas-returns/customer/${customerId}`),
  getPendingReturns: (customerId: number) =>
    request(`/gas-returns/customer/${customerId}/pending`),
  createReturn: (data: any) =>
    request('/gas-returns', { method: 'POST', body: JSON.stringify(data) }),
  resolveReturn: (id: number) =>
    request(`/gas-returns/${id}/resolve`, { method: 'PATCH' }),
}
