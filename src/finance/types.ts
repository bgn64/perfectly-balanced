export type BudgetDirection = 'spending' | 'income'

export interface Budget {
  id: string
  month: string
}

export interface BudgetSubsection {
  id: string
  name: string
  position: number
}

export interface BudgetAllocation {
  allocation_id: string
  category_id: string
  category_name: string
  subsection_id: string | null
  subsection_name: string | null
  position: number
  direction: BudgetDirection
  budgeted_amount: number
  actual_amount: number
}

export interface Category {
  id: string
  name: string
}

export interface Transaction {
  id: string
  plaid_item_id: string | null
  transaction_date: string
  merchant_name: string | null
  transaction_name: string | null
  amount: number
  currency_code: string | null
  is_pending: boolean
  account_name: string
}

export interface TransactionSplit {
  id: string
  transaction_id: string
  category_id: string
  amount: number
}
