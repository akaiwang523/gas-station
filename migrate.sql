-- 新增 payment_type 欄位到 orders 表
ALTER TABLE orders 
ADD COLUMN IF NOT EXISTS payment_type ENUM('CASH', 'AR', 'TRANSFER', 'LINE_PAY') NOT NULL DEFAULT 'CASH';

-- 確保 ar_balances 表存在
CREATE TABLE IF NOT EXISTS ar_balances (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL UNIQUE,
  amount_owed DECIMAL(10,2) NOT NULL DEFAULT 0,
  cylinders_owed INT NOT NULL DEFAULT 0,
  last_payment DATETIME NULL,
  memo VARCHAR(200) NULL,
  updated_at DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

-- 確保所有客戶都有 ar_balances 記錄
INSERT IGNORE INTO ar_balances (customer_id, amount_owed, cylinders_owed)
SELECT id, 0, 0 FROM customers;

-- 預測準確度追蹤表：記錄每一輪「系統預測補貨日」與「客戶實際下單日」的配對，
-- 目前只收集資料、不做任何校正，等資料量夠大之後才會拿來分析/校正預測算法
CREATE TABLE IF NOT EXISTS prediction_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  predicted_date DATE NOT NULL,
  predicted_at DATETIME NOT NULL,
  days_per_bottle DECIMAL(10,4) NOT NULL,
  last_order_quantity INT NOT NULL,
  confidence_tier VARCHAR(20) NOT NULL,
  actual_order_id INT NULL,
  actual_order_date DATE NULL,
  created_at DATETIME NOT NULL DEFAULT NOW(),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  INDEX idx_customer_unresolved (customer_id, actual_order_id)
);
