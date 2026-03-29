import Table from "cli-table3";

const DEFAULT_TERMINAL_WIDTH = 80;
const CELL_PADDING = 2; // cli-table3 adds 1 char padding on each side
const BORDER_CHAR = 1; // each border character

function getTerminalWidth(): number {
  return process.stdout.columns || DEFAULT_TERMINAL_WIDTH;
}

/**
 * Calculate column widths that fit within the terminal width.
 * Distributes available space proportionally based on content width.
 */
function fitColumnWidths(
  contentWidths: number[],
  terminalWidth: number,
): number[] | undefined {
  const numCols = contentWidths.length;
  const overhead = numCols * CELL_PADDING + (numCols + 1) * BORDER_CHAR;
  const totalContentWidth = contentWidths.reduce((sum, w) => sum + w, 0);

  // If it fits, let cli-table3 auto-size
  if (totalContentWidth + overhead <= terminalWidth) {
    return undefined;
  }

  const availableContent = terminalWidth - overhead;
  const minColWidth = 5;

  return contentWidths.map((w) =>
    Math.max(
      minColWidth,
      Math.floor((w / totalContentWidth) * availableContent),
    ),
  );
}

function truncate(str: string, maxLen: number): string {
  if (maxLen < 1) return str;
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "\u2026";
}

/**
 * Render a table from column headers and row data.
 * Automatically truncates content when the table exceeds terminal width.
 */
export function renderTable(head: string[], rows: string[][]): string {
  const terminalWidth = getTerminalWidth();

  const contentWidths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)),
  );

  const colWidths = fitColumnWidths(contentWidths, terminalWidth);

  const table = new Table({
    head,
    ...(colWidths && { colWidths }),
  });

  if (colWidths) {
    for (const row of rows) {
      table.push(row.map((cell, i) => truncate(cell, colWidths[i] - CELL_PADDING)));
    }
  } else {
    for (const row of rows) {
      table.push(row);
    }
  }

  return table.toString();
}
