/**
 * Template AST.
 *
 * `RawText` is a node rather than an error path because unparseable spans are
 * still rendered, verbatim, into output the user sees.
 */

export type TemplateNode = RawTextNode | ExpressionNode | ToolNode | GroupNode;

/**
 * Document offsets set by `parseTemplate`, always in document coordinates
 * (group children are re-based, see `offsetNodes`). Optional so the render path,
 * which never reads them, is unaffected.
 */
export interface NodeSpan {
  start?: number;
  end?: number;
}

export interface RawTextNode extends NodeSpan {
  kind: 'raw';
  text: string;
}

/**
 * `{? ... ?}` renders only when every field inside it is present, so a prefix
 * and its value disappear together.
 */
export interface GroupNode extends NodeSpan {
  kind: 'group';
  nodes: TemplateNode[];
}

/** `{tools.newLine}` / `{tools.removeLine}`: layout directives, not values. */
export interface ToolNode extends NodeSpan {
  kind: 'tool';
  tool: 'newLine' | 'removeLine';
}

/** `{ operand (::comparator:: operand)* (["true"||"false"])? }` */
export interface ExpressionNode extends NodeSpan {
  kind: 'expression';
  /** exact source, emitted when rendering falls back to literal text */
  source: string;
  operands: OperandNode[];
  /** always operands.length - 1 */
  comparators: string[];
  check?: CheckNode;
}

export interface CheckNode {
  /** raw branch text, compiled recursively and depth-capped */
  trueTemplate: string;
  falseTemplate: string;
  /** taken when the value is absent rather than false */
  absentTemplate?: string;
  /**
   * Offset of each branch's content (the character after its opening `"`), in
   * the coordinates of whatever string was parsed to produce this node. Used to
   * map in-branch diagnostics back to a precise position.
   */
  trueStart?: number;
  falseStart?: number;
  absentStart?: number;
}

export interface OperandNode {
  /** a quoted value used where a field is expected, e.g. `{'N/A'::smallcaps}` */
  literal?: string;
  /** case preserved: matching is case-insensitive, lookup is not */
  section: string;
  property: string;
  /** case preserved: names are matched case-insensitively, arguments are not */
  modifiers: string[];
}

export function rawText(text: string): RawTextNode {
  return { kind: 'raw', text };
}
