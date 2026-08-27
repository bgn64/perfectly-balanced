import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../auth/useAuth.ts'
import { getSupabaseClient } from '../lib/supabase.ts'

interface Category {
  id: string
  name: string
}

interface CategoriesPanelProps {
  onCategoriesChanged: () => void
}

function categoryErrorMessage(error: {
  code?: string
  message: string
}): string {
  if (error.code === '23505') {
    return 'Category names must be unique.'
  }

  if (error.code === '23503') {
    return 'This category is assigned to a transaction and cannot be deleted.'
  }

  return error.message
}

export function CategoriesPanel({
  onCategoriesChanged,
}: CategoriesPanelProps) {
  const { user } = useAuth()
  const [categories, setCategories] = useState<Category[]>([])
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function loadCategories() {
    const { data, error } = await getSupabaseClient()
      .from('categories')
      .select('id, name')
      .order('name')

    if (error) {
      setErrorMessage(error.message)
    } else {
      setErrorMessage(null)
      setCategories(data ?? [])
    }

    setIsLoading(false)
  }

  useEffect(() => {
    let isCurrent = true

    void getSupabaseClient()
      .from('categories')
      .select('id, name')
      .order('name')
      .then(({ data, error }) => {
        if (!isCurrent) {
          return
        }

        if (error) {
          setErrorMessage(error.message)
        } else {
          setCategories(data ?? [])
        }

        setIsLoading(false)
      })

    return () => {
      isCurrent = false
    }
  }, [])

  async function createCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const name = newName.trim()
    if (!name || !user) {
      setErrorMessage('Enter a category name.')
      return
    }

    setBusyId('new')
    setErrorMessage(null)

    const { error } = await getSupabaseClient()
      .from('categories')
      .insert({ name, user_id: user.id })

    setBusyId(null)

    if (error) {
      setErrorMessage(categoryErrorMessage(error))
      return
    }

    setNewName('')
    await loadCategories()
    onCategoriesChanged()
  }

  function startRename(category: Category) {
    setEditingId(category.id)
    setEditingName(category.name)
    setErrorMessage(null)
  }

  async function saveRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const name = editingName.trim()
    if (!editingId || !name) {
      setErrorMessage('Enter a category name.')
      return
    }

    setBusyId(editingId)
    setErrorMessage(null)

    const { error } = await getSupabaseClient()
      .from('categories')
      .update({ name, updated_at: new Date().toISOString() })
      .eq('id', editingId)

    setBusyId(null)

    if (error) {
      setErrorMessage(categoryErrorMessage(error))
      return
    }

    setEditingId(null)
    setEditingName('')
    await loadCategories()
    onCategoriesChanged()
  }

  async function deleteCategory(category: Category) {
    if (!window.confirm(`Delete the ${category.name} category?`)) {
      return
    }

    setBusyId(category.id)
    setErrorMessage(null)

    const { error } = await getSupabaseClient()
      .from('categories')
      .delete()
      .eq('id', category.id)

    setBusyId(null)

    if (error) {
      setErrorMessage(categoryErrorMessage(error))
      return
    }

    await loadCategories()
    onCategoriesChanged()
  }

  return (
    <section className="app-shell__content" aria-labelledby="categories-title">
      <div className="section-header">
        <div>
          <p className="eyebrow">Budget setup</p>
          <h2 id="categories-title">Categories</h2>
          <p>
            Create reusable categories for transaction splits and future
            budgets.
          </p>
        </div>
        <form className="category-create-form" onSubmit={createCategory}>
          <label htmlFor="category-name">New category</label>
          <div className="category-create-form__controls">
            <input
              id="category-name"
              name="category-name"
              placeholder="e.g. Groceries"
              type="text"
              maxLength={100}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              disabled={busyId === 'new'}
            />
            <button
              className="button"
              type="submit"
              disabled={busyId === 'new'}
            >
              {busyId === 'new' ? 'Adding...' : 'Add category'}
            </button>
          </div>
        </form>
      </div>

      {errorMessage && (
        <p className="form-message form-message--error" role="alert">
          {errorMessage}
        </p>
      )}

      {isLoading ? (
        <p className="transactions-panel__status" aria-live="polite">
          Loading categories...
        </p>
      ) : categories.length === 0 ? (
        <p className="transactions-panel__status">
          No categories yet. Add one to start categorizing transactions.
        </p>
      ) : (
        <ul className="category-list" aria-label="Categories">
          {categories.map((category) => (
            <li
              className={`category-item${
                editingId === category.id ? ' category-item--editing' : ''
              }`}
              key={category.id}
            >
              {editingId === category.id ? (
                <form className="category-rename-form" onSubmit={saveRename}>
                  <label className="sr-only" htmlFor={`category-${category.id}`}>
                    Category name
                  </label>
                  <input
                    id={`category-${category.id}`}
                    type="text"
                    maxLength={100}
                    value={editingName}
                    onChange={(event) => setEditingName(event.target.value)}
                    disabled={busyId === category.id}
                    autoFocus
                  />
                  <div className="category-item__actions">
                    <button
                      className="text-button"
                      type="submit"
                      disabled={busyId === category.id}
                    >
                      {busyId === category.id ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => setEditingId(null)}
                      disabled={busyId === category.id}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <span>{category.name}</span>
                  <div className="category-item__actions">
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => startRename(category)}
                      disabled={busyId === category.id}
                    >
                      Rename
                    </button>
                    <button
                      className="text-button text-button--danger"
                      type="button"
                      onClick={() => void deleteCategory(category)}
                      disabled={busyId === category.id}
                    >
                      {busyId === category.id ? 'Deleting...' : 'Delete'}
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
