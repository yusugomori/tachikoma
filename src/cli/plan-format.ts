import { type CliColor, type CliIo, colorize } from "./io.js";

const INDENT = "  ";
const COLUMN_GAP = "  ";

export interface PlanItem {
  token: string;
  color: CliColor;
  /**
   * Aligned cells rendered after the status token. Every cell except the last is
   * padded to its column's shared width so columns line up across rows.
   */
  cells: string[];
}

/** Bold section heading like `reset plan:`, `targets:`, `bootstrap:`. */
export function planHeading(io: CliIo, text: string): string {
  return colorize(io, "bold", text);
}

/** Indented, colon-aligned `label: value` context lines. */
export function planContextLines(pairs: Array<[string, string]>): string[] {
  const labelWidth = pairs.reduce((width, [label]) => Math.max(width, label.length + 1), 0);

  return pairs.map(([label, value]) => `${INDENT}${`${label}:`.padEnd(labelWidth + 1)} ${value}`);
}

/**
 * Indented item rows with a width-aligned, colored status token followed by
 * aligned cell columns. Shared by reset, init, and install so their plan output
 * stays visually identical.
 */
export function planItemLines(
  io: CliIo,
  items: PlanItem[],
  options: { tokenWidth?: number } = {}
): string[] {
  if (items.length === 0) {
    return [];
  }

  const tokenWidth =
    options.tokenWidth ?? items.reduce((width, item) => Math.max(width, item.token.length), 0);
  const columnCount = items.reduce((count, item) => Math.max(count, item.cells.length), 0);
  const columnWidths: number[] = [];

  for (let column = 0; column < columnCount - 1; column += 1) {
    columnWidths[column] = items.reduce(
      (width, item) => Math.max(width, (item.cells[column] ?? "").length),
      0
    );
  }

  return items.map((item) => {
    const token =
      colorize(io, item.color, item.token) +
      " ".repeat(Math.max(0, tokenWidth - item.token.length));
    const cells = item.cells.map((cell, column) =>
      column < item.cells.length - 1 ? cell.padEnd(columnWidths[column] ?? 0) : cell
    );

    return `${INDENT}${token}${COLUMN_GAP}${cells.join(COLUMN_GAP)}`;
  });
}
