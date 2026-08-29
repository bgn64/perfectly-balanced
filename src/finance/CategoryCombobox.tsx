import { useMemo, useRef, useState } from 'react'
import type { Category } from './types.ts'

export function CategoryCombobox({
  categories,
  excludedCategoryIds = [],
  label,
  placeholder = 'Search categories or enter a new name...',
  disabled = false,
  onCreate,
  onSelect,
}: {
  categories: Category[]
  excludedCategoryIds?: string[]
  label: string
  placeholder?: string
  disabled?: boolean
  onCreate: (name: string) => Promise<Category>
  onSelect: (category: Category) => Promise<void> | void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const excluded = useMemo(
    () => new Set(excludedCategoryIds),
    [excludedCategoryIds],
  )
  const normalizedQuery = query.trim()
  const options = categories.filter(
    (category) =>
      !excluded.has(category.id) &&
      category.name.toLocaleLowerCase().includes(
        normalizedQuery.toLocaleLowerCase(),
      ),
  )
  const canCreate =
    normalizedQuery.length > 0 &&
    !categories.some(
      (category) =>
        category.name.toLocaleLowerCase() ===
        normalizedQuery.toLocaleLowerCase(),
    )

  async function choose(category: Category) {
    setIsBusy(true)
    setErrorMessage(null)
    try {
      await onSelect(category)
      setQuery('')
      setIsOpen(false)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'We could not add the category.',
      )
    } finally {
      setIsBusy(false)
    }
  }

  async function createAndChoose() {
    setIsBusy(true)
    setErrorMessage(null)
    try {
      const category = await onCreate(normalizedQuery)
      await onSelect(category)
      setQuery('')
      setIsOpen(false)
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'We could not create the category.',
      )
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <div
      className="category-combobox"
      ref={containerRef}
      onBlur={(event) => {
        if (!containerRef.current?.contains(event.relatedTarget)) {
          setIsOpen(false)
        }
      }}
    >
      <label className="sr-only">{label}</label>
      <input
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={isOpen}
        autoComplete="off"
        disabled={disabled || isBusy}
        maxLength={100}
        placeholder={placeholder}
        role="combobox"
        type="search"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setIsOpen(true)
          setErrorMessage(null)
        }}
        onFocus={() => setIsOpen(true)}
      />
      {isOpen && (
        <div className="combo-menu" role="listbox">
          {canCreate && (
            <button
              className="combo-option combo-option--create"
              disabled={isBusy}
              type="button"
              onClick={() => void createAndChoose()}
            >
              + Create &ldquo;{normalizedQuery}&rdquo;
            </button>
          )}
          {options.map((category) => (
            <button
              className="combo-option"
              disabled={isBusy}
              key={category.id}
              role="option"
              type="button"
              onClick={() => void choose(category)}
            >
              {category.name}
            </button>
          ))}
          {!canCreate && options.length === 0 && (
            <span className="combo-empty">No available categories</span>
          )}
        </div>
      )}
      {errorMessage && (
        <small className="inline-error" role="alert">
          {errorMessage}
        </small>
      )}
    </div>
  )
}
