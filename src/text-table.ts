import chalk from 'chalk'

export type TableColumn = {
  header: string
  // Right-align the cell contents (numbers/costs). Left-aligned otherwise.
  right?: boolean
}

/**
 * Render a fixed-width, whitespace-padded text table for terminal output.
 * Each column is sized to the widest cell (header or body). `right` columns
 * pad with padStart, everything else with padEnd. Rows whose index is in
 * `opts.boldRows` are emphasized with chalk.bold (e.g. a Totals row).
 */
export function renderTable(
  columns: TableColumn[],
  body: string[][],
  opts?: { boldRows?: Set<number> },
): string {
  const boldRows = opts?.boldRows ?? new Set<number>()
  const widths = columns.map((col, i) => {
    let w = col.header.length
    for (const row of body) {
      const cell = row[i] ?? ''
      if (cell.length > w) w = cell.length
    }
    return w
  })

  const pad = (text: string, i: number): string =>
    columns[i]?.right ? text.padStart(widths[i]!) : text.padEnd(widths[i]!)

  const headerLine = columns.map((col, i) => pad(col.header, i)).join('  ')
  const sepLine = widths.map((w) => '-'.repeat(w)).join('  ')

  const lines = [chalk.bold(headerLine), chalk.dim(sepLine)]
  body.forEach((row, r) => {
    const line = columns.map((_, i) => pad(row[i] ?? '', i)).join('  ')
    lines.push(boldRows.has(r) ? chalk.bold(line) : line)
  })

  return lines.join('\n')
}
