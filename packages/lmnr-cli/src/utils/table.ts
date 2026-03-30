import Table from "cli-table3";

const DEFAULT_TERMINAL_WIDTH = 80;
const PADDING_RIGHT = 2;

const noBorderChars = {
  top: "", "top-mid": "", "top-left": "", "top-right": "",
  bottom: "", "bottom-mid": "", "bottom-left": "", "bottom-right": "",
  left: "", "left-mid": "", mid: "", "mid-mid": "",
  right: "", "right-mid": "", middle: "",
};

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
  // With no borders, overhead is just padding-right per column
  const overhead = contentWidths.length * PADDING_RIGHT;
  const totalContentWidth = contentWidths.reduce((sum, w) => sum + w, 0);

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
 * Render a borderless table from column headers and row data.
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
    chars: noBorderChars,
    style: {
      "padding-left": 0,
      "padding-right": PADDING_RIGHT,
    },
    ...(colWidths && { colWidths }),
  });

  if (colWidths) {
    for (const row of rows) {
      table.push(row.map((cell, i) => truncate(cell, colWidths[i])));
    }
  } else {
    for (const row of rows) {
      table.push(row);
    }
  }

  return table.toString();
}
