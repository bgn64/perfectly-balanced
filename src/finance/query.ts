const pageSize = 1_000

interface PageResult<T> {
  data: T[] | null
  error: { message: string } | null
}

export async function collectPages<T extends { id: string }>(
  fetchPage: (
    afterId: string | null,
    limit: number,
  ) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const rows: T[] = []
  let afterId: string | null = null

  for (;;) {
    const { data, error } = await fetchPage(afterId, pageSize)
    if (error) {
      throw new Error(error.message)
    }

    const page = data ?? []
    rows.push(...page)
    if (page.length < pageSize) {
      return rows
    }
    const nextAfterId = page[page.length - 1].id
    if (nextAfterId === afterId) {
      throw new Error('Pagination did not advance.')
    }
    afterId = nextAfterId
  }
}
