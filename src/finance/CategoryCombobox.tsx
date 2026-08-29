import { useId, useMemo, useRef, useState, type Ref } from 'react'
import type { Category } from './types.ts'

export function CategoryCombobox({
  autoFocus = false,
  cancelOnBlur = false,
  categories,
  createAlternativeLabel,
  excludedCategoryIds = [],
  inputRef,
  label,
  onCancel,
  placeholder = 'Search categories or enter a new name...',
  selectedCategory,
  disabled = false,
  onCreate,
  onCreateAlternative,
  onSelect,
}: {
  autoFocus?: boolean
  cancelOnBlur?: boolean
  categories: Category[]
  createAlternativeLabel?: (name: string) => string
  excludedCategoryIds?: string[]
  inputRef?: Ref<HTMLInputElement>
  label: string
  onCancel?: () => void
  placeholder?: string
  selectedCategory?: Category
  disabled?: boolean
  onCreate: (name: string) => Promise<Category>
  onCreateAlternative?: (name: string) => Promise<Category>
  onSelect: (category: Category) => Promise<void> | void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const optionIdPrefix = useId()
  const [query, setQuery] = useState(selectedCategory?.name ?? '')
  const [isOpen, setIsOpen] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
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
  const menuOptions = [
    ...options.map((category) => ({
      id: `category-${category.id}`,
      label: category.name,
      kind: 'category' as const,
      category,
    })),
    ...(canCreate
      ? [
          {
            id: 'create',
            label: `+ Create “${normalizedQuery}”`,
            kind: 'create' as const,
          },
        ]
      : []),
    ...(canCreate && onCreateAlternative && createAlternativeLabel
      ? [
          {
            id: 'create-alternative',
            label: createAlternativeLabel(normalizedQuery),
            kind: 'create-alternative' as const,
          },
        ]
      : []),
  ]

  async function choose(category: Category) {
    setIsBusy(true)
    setErrorMessage(null)
    try {
      await onSelect(category)
      setQuery(selectedCategory ? category.name : '')
      setIsOpen(false)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'We could not add the category.',
      )
    } finally {
      setIsBusy(false)
    }
  }

  async function createAndChoose(
    create: (name: string) => Promise<Category> = onCreate,
  ) {
    setIsBusy(true)
    setErrorMessage(null)
    try {
      const category = await create(normalizedQuery)
      await onSelect(category)
      setQuery(selectedCategory ? category.name : '')
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

  async function chooseActiveOption() {
    const option = menuOptions[activeIndex]
    if (!option) {
      return
    }
    if (option.kind === 'category') {
      await choose(option.category)
      return
    }
    await createAndChoose(
      option.kind === 'create-alternative' && onCreateAlternative
        ? onCreateAlternative
        : onCreate,
    )
  }

  function moveActiveOption(direction: 1 | -1) {
    if (menuOptions.length === 0) {
      return
    }
    setIsOpen(true)
    setActiveIndex((current) =>
      (current + direction + menuOptions.length) % menuOptions.length,
    )
  }

  return (
    <div
      className="category-combobox"
      ref={containerRef}
      onBlur={(event) => {
        if (!containerRef.current?.contains(event.relatedTarget)) {
          setIsOpen(false)
          if (cancelOnBlur && !query.trim()) {
            onCancel?.()
          }
        }
      }}
    >
      <label className="sr-only">{label}</label>
      <input
        ref={inputRef}
        aria-activedescendant={
          isOpen && menuOptions[activeIndex]
            ? `${optionIdPrefix}-${menuOptions[activeIndex].id}`
            : undefined
        }
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={isOpen}
        aria-controls={`${optionIdPrefix}-listbox`}
        autoFocus={autoFocus}
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
          setActiveIndex(0)
          setErrorMessage(null)
        }}
        onFocus={(event) => {
          setIsOpen(true)
          setActiveIndex(0)
          if (selectedCategory && query === selectedCategory.name) {
            event.currentTarget.select()
          }
        }}
        onKeyDown={(event) => {
          const key = event.key.toLocaleLowerCase()
          if (event.key === 'ArrowDown' || (event.ctrlKey && key === 'n')) {
            event.preventDefault()
            moveActiveOption(1)
          } else if (
            event.key === 'ArrowUp' ||
            (event.ctrlKey && key === 'p')
          ) {
            event.preventDefault()
            moveActiveOption(-1)
          } else if (event.key === 'Enter' && isOpen) {
            event.preventDefault()
            void chooseActiveOption()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setQuery(selectedCategory?.name ?? '')
            setIsOpen(false)
            onCancel?.()
          }
        }}
      />
      {isOpen && (
        <div
          className="combo-menu"
          id={`${optionIdPrefix}-listbox`}
          role="listbox"
        >
          {menuOptions.map((option, index) => (
            <button
              aria-selected={index === activeIndex}
              className={`combo-option${
                option.kind === 'category'
                  ? ''
                  : option.kind === 'create'
                    ? ' combo-option--create'
                    : ' combo-option--create combo-option--budget'
              }${index === activeIndex ? ' highlighted' : ''}`}
              disabled={isBusy}
              id={`${optionIdPrefix}-${option.id}`}
              key={option.id}
              role="option"
              type="button"
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => {
                if (option.kind === 'category') {
                  void choose(option.category)
                } else {
                  void createAndChoose(
                    option.kind === 'create-alternative' &&
                      onCreateAlternative
                      ? onCreateAlternative
                      : onCreate,
                  )
                }
              }}
            >
              {option.label}
            </button>
          ))}
          {menuOptions.length === 0 && (
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
