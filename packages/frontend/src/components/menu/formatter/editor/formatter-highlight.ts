import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import {
  tokenize,
  TokenKind,
} from '../../../../../../core/src/formatters/engine';

// Paired delimiters are coloured by depth (rainbow); everything else by kind.
const KIND_CLASS: Partial<Record<TokenKind, string>> = {
  section: 'cmf-section',
  property: 'cmf-property',
  dot: 'cmf-dot',
  literal: 'cmf-literal',
  modifier: 'cmf-modifier',
  'call-args': 'cmf-args',
  comparator: 'cmf-comparator',
  'prefix-op': 'cmf-prefix',
  tool: 'cmf-tool',
  separator: 'cmf-sep',
  quote: 'cmf-quote',
  pipe: 'cmf-pipe',
  invalid: 'cmf-invalid',
};

const RAINBOW: ReadonlySet<TokenKind> = new Set([
  'brace',
  'bracket',
  'group-brace',
]);

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const text = view.state.doc.toString();
  // tokens come back sorted and non-overlapping, which RangeSetBuilder requires
  for (const token of tokenize(text)) {
    const cls = RAINBOW.has(token.kind)
      ? `cmf-d${token.depth % 5}`
      : KIND_CLASS[token.kind];
    if (!cls) continue;
    builder.add(token.start, token.end, Decoration.mark({ class: cls }));
  }
  return builder.finish();
}

/** Re-tokenises the whole (short) template on each edit and marks the spans. */
export const formatterHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = buildDecorations(update.view);
    }
  },
  { decorations: (v) => v.decorations }
);
