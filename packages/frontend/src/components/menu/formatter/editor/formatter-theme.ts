import { EditorView } from '@codemirror/view';

/**
 * CodeMirror theme for the formatter language. Colours reference the app's own
 * CSS variables (defined in globals.css for both light and dark), so the editor
 * follows the active theme automatically with no JS theme hook. `color-mix`
 * derives translucent accents from the same tokens the rest of the UI uses.
 */
export const formatterTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--foreground)',
    fontSize: '0.8125rem',
    // fill the resizable wrapper so dragging its handle grows the editor
    height: '100%',
  },
  '.cm-content': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    padding: '0.5rem 0.6rem',
    caretColor: 'var(--foreground)',
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-placeholder': { color: 'var(--muted)' },
  // native selection (drawSelection is off), so it stops at the last character
  '.cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--ring) 30%, transparent)',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--ring) 22%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--ring) 45%, transparent)',
  },
  '.cm-nonmatchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--red) 30%, transparent)',
  },
  // popups / tooltips
  '.cm-tooltip': {
    backgroundColor: 'var(--paper)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--foreground)',
    boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    maxHeight: '16rem',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'color-mix(in srgb, var(--ring) 25%, transparent)',
    color: 'var(--foreground)',
  },
  '.cm-completionLabel': { color: 'var(--foreground)' },
  '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'italic' },
  '.cm-tooltip.cm-tooltip-lint': { padding: '0.25rem 0.5rem' },
  '.cm-diagnosticText': { color: 'var(--foreground)' },

  // syntax tokens
  '.cmf-section': { color: 'var(--sky)', fontWeight: '500' },
  '.cmf-property': { color: 'var(--blue)' },
  '.cmf-dot': { color: 'var(--muted)' },
  '.cmf-modifier': { color: 'var(--violet)' },
  '.cmf-comparator': { color: 'var(--amber)', fontWeight: '600' },
  '.cmf-prefix': { color: 'var(--amber)' },
  '.cmf-args': { color: 'var(--foreground)' },
  '.cmf-literal': { color: 'var(--green)' },
  '.cmf-tool': { color: 'var(--teal)', fontStyle: 'italic' },
  '.cmf-sep': { color: 'var(--muted)' },
  '.cmf-quote': { color: 'var(--muted)' },
  '.cmf-pipe': { color: 'var(--rose)', fontWeight: '600' },
  // an unresolved {...} renders as literal text: dim + dotted so it reads dead
  '.cmf-invalid': {
    color: 'var(--muted)',
    textDecoration:
      'underline dotted color-mix(in srgb, var(--red) 60%, transparent)',
    opacity: '0.75',
  },

  // rainbow brackets, coloured by nesting depth
  '.cmf-d0': { color: 'var(--yellow)' },
  '.cmf-d1': { color: 'var(--violet)' },
  '.cmf-d2': { color: 'var(--sky)' },
  '.cmf-d3': { color: 'var(--pink)' },
  '.cmf-d4': { color: 'var(--teal)' },

  // inline resolved-value hint on the active line
  '.cmf-hint': {
    color: 'var(--muted)',
    fontStyle: 'italic',
    opacity: '0.85',
    paddingLeft: '0.35rem',
  },
});
