
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {

  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "budget_sections": {
                  Row: {
                    "archived": boolean,"id": string,"kind": string,"name": string,"owner_id": string,"position": number
                  }
                  Insert: {
                    "archived"?: boolean,"id"?: string,"kind": string,"name": string,"owner_id": string,"position"?: number
                  }
                  Update: {
                    "archived"?: boolean,"id"?: string,"kind"?: string,"name"?: string,"owner_id"?: string,"position"?: number
                  }
                  Relationships: [

                  ]
                },"categories": {
                  Row: {
                    "archived": boolean,"id": string,"name": string,"owner_id": string,"section_id": string
                  }
                  Insert: {
                    "archived"?: boolean,"id"?: string,"name": string,"owner_id": string,"section_id": string
                  }
                  Update: {
                    "archived"?: boolean,"id"?: string,"name"?: string,"owner_id"?: string,"section_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "categories_owner_id_section_id_fkey"
      columns: ["owner_id","section_id"]
isOneToOne: false
      referencedRelation: "budget_sections"
      referencedColumns: ["owner_id","id"]
    }
                  ]
                },"import_batches": {
                  Row: {
                    "created_at": string,"fingerprint": string,"id": string,"owner_id": string
                  }
                  Insert: {
                    "created_at"?: string,"fingerprint": string,"id"?: string,"owner_id": string
                  }
                  Update: {
                    "created_at"?: string,"fingerprint"?: string,"id"?: string,"owner_id"?: string
                  }
                  Relationships: [

                  ]
                },"monthly_budget_categories": {
                  Row: {
                    "budget_id": string,"category_id": string,"name": string,"owner_id": string,"planned_cents": number,"position": number,"section_id": string
                  }
                  Insert: {
                    "budget_id": string,"category_id": string,"name": string,"owner_id": string,"planned_cents"?: number,"position"?: number,"section_id": string
                  }
                  Update: {
                    "budget_id"?: string,"category_id"?: string,"name"?: string,"owner_id"?: string,"planned_cents"?: number,"position"?: number,"section_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "monthly_budget_categories_owner_id_budget_id_section_id_fkey"
      columns: ["owner_id","budget_id","section_id"]
isOneToOne: false
      referencedRelation: "monthly_budget_sections"
      referencedColumns: ["owner_id","budget_id","section_id"]
    },{
      foreignKeyName: "monthly_budget_categories_owner_id_category_id_section_id_fkey"
      columns: ["owner_id","category_id","section_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["owner_id","id","section_id"]
    }
                  ]
                },"monthly_budget_sections": {
                  Row: {
                    "budget_id": string,"name": string,"owner_id": string,"position": number,"section_id": string
                  }
                  Insert: {
                    "budget_id": string,"name": string,"owner_id": string,"position"?: number,"section_id": string
                  }
                  Update: {
                    "budget_id"?: string,"name"?: string,"owner_id"?: string,"position"?: number,"section_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "monthly_budget_sections_owner_id_budget_id_fkey"
      columns: ["owner_id","budget_id"]
isOneToOne: false
      referencedRelation: "monthly_budgets"
      referencedColumns: ["owner_id","id"]
    },{
      foreignKeyName: "monthly_budget_sections_owner_id_section_id_fkey"
      columns: ["owner_id","section_id"]
isOneToOne: false
      referencedRelation: "budget_sections"
      referencedColumns: ["owner_id","id"]
    }
                  ]
                },"monthly_budgets": {
                  Row: {
                    "id": string,"month": string,"owner_id": string
                  }
                  Insert: {
                    "id"?: string,"month": string,"owner_id": string
                  }
                  Update: {
                    "id"?: string,"month"?: string,"owner_id"?: string
                  }
                  Relationships: [

                  ]
                },"transaction_allocations": {
                  Row: {
                    "amount_cents": number,"category_id": string | null,"id": string,"owner_id": string,"transaction_id": string
                  }
                  Insert: {
                    "amount_cents": number,"category_id"?: string | null,"id"?: string,"owner_id": string,"transaction_id": string
                  }
                  Update: {
                    "amount_cents"?: number,"category_id"?: string | null,"id"?: string,"owner_id"?: string,"transaction_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "transaction_allocations_owner_id_category_id_fkey"
      columns: ["owner_id","category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["owner_id","id"]
    },{
      foreignKeyName: "transaction_allocations_owner_id_transaction_id_fkey"
      columns: ["owner_id","transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["owner_id","id"]
    }
                  ]
                },"transactions": {
                  Row: {
                    "amount_cents": number,"created_at": string,"currency": string,"date_override": string | null,"description": string,"effective_date": string | null,"excluded": boolean,"id": string,"merchant": string,"original_date": string,"owner_id": string,"provider_removed": boolean,"revision": number,"source": string,"source_id": string | null
                  }
                  Insert: {
                    "amount_cents": number,"created_at"?: string,"currency"?: string,"date_override"?: string | null,"description": string,"effective_date"?: never,"excluded"?: boolean,"id"?: string,"merchant"?: string,"original_date": string,"owner_id": string,"provider_removed"?: boolean,"revision"?: number,"source": string,"source_id"?: string | null
                  }
                  Update: {
                    "amount_cents"?: number,"created_at"?: string,"currency"?: string,"date_override"?: string | null,"description"?: string,"effective_date"?: never,"excluded"?: boolean,"id"?: string,"merchant"?: string,"original_date"?: string,"owner_id"?: string,"provider_removed"?: boolean,"revision"?: number,"source"?: string,"source_id"?: string | null
                  }
                  Relationships: [

                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "app_bank_resolve":
{ Args: { "p_allocations"?: Json,"p_decision": string,"p_id": string,"p_revision"?: number,"p_transaction"?: string,"p_version": number }; Returns: undefined
                           },
"app_bank_resolve_internal":
{ Args: { "p_allocations"?: Json,"p_decision": string,"p_id": string,"p_transaction"?: string,"p_version": number }; Returns: undefined
                           },
"app_bank_restore":
{ Args: { "p_id": string,"p_revision": number }; Returns: undefined
                           },
"app_banking":
{ Args: { "p_offset"?: number }; Returns: Json
                           },
"app_banking_internal":
{ Args: { "p_offset"?: number }; Returns: Json
                           },
"app_banking_versioned":
{ Args: { "p_offset"?: number }; Returns: Json
                           },
"app_demo":
{ Args: { "p_month": string }; Returns: undefined
                           },
"app_history":
{ Args: { "p_id": string }; Returns: Json
                           },
"app_import_preview":
{ Args: { "p_fingerprint": string,"p_rows": Json }; Returns: Json
                           },
"app_month":
{ Args: { "p_month": string }; Returns: Json
                           },
"app_mutate":
{ Args: { "p_action": string,"p_payload": Json }; Returns: Json
                           },
"app_page":
{ Args: { "p_category"?: string,"p_excluded"?: string,"p_month": string,"p_offset"?: number,"p_search"?: string,"p_sort"?: string,"p_uncategorized"?: boolean }; Returns: Json
                           },
"plaid_admin":
{ Args: { "p_action": string,"p_payload": Json }; Returns: Json
                           },
"plaid_admin_catchup":
{ Args: { "p_action": string,"p_payload": Json }; Returns: Json
                           },
"plaid_admin_guarded":
{ Args: { "p_action": string,"p_payload": Json }; Returns: Json
                           },
"plaid_admin_hardened":
{ Args: { "p_action": string,"p_payload": Json }; Returns: Json
                           },
"plaid_admin_internal":
{ Args: { "p_action": string,"p_payload": Json }; Returns: Json
                           },
"plaid_admin_ready":
{ Args: { "p_action": string,"p_payload": Json }; Returns: Json
                           },
"plaid_admin_scoped":
{ Args: { "p_action": string,"p_payload": Json }; Returns: Json
                           },
"plaid_admin_selected":
{ Args: { "p_action": string,"p_payload": Json }; Returns: Json
                           },
"plaid_rate":
{ Args: { "p_owner": string }; Returns: undefined
                           },
"plaid_schedule":
{ Args: { "p_url": string,"p_worker_secret": string }; Returns: undefined
                           },
"plaid_worker_receipt":
{ Args: { "p_nonce": string }; Returns: boolean
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {

          }
        },"public": {
          Enums: {

          }
        }
} as const
