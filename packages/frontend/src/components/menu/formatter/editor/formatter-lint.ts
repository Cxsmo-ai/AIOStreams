import { Diagnostic as CMDiagnostic, linter } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';
import {
  DiagnosticCategory,
  validateTemplate,
} from '../../../../../../core/src/formatters/engine';

// unparseable / unterminated spans are hard errors; unknown field/modifier and
// argument-shape mistakes are advisory (they render as literal text)
const ERROR_CATEGORIES: ReadonlySet<DiagnosticCategory> = new Set([
  'unterminated',
  'unterminated-group',
  'unparseable',
]);

/**
 * Client-side validation, running the same `validateTemplate` the engine uses.
 * Diagnostics anchor to the exact offending span, and when the engine offers a
 * near-miss `suggestion` it becomes a one-click quick-fix that rewrites just the
 * bad identifier (the first back-ticked token in the message).
 */
export const formatterLinter = linter(
  (view: EditorView): CMDiagnostic[] => {
    const text = view.state.doc.toString();
    const len = text.length;
    return validateTemplate(text).map((d) => {
      const from = Math.max(0, Math.min(d.index, len));
      const rawTo = d.index + (d.source ? d.source.length : 1);
      const to = Math.max(from + 1, Math.min(rawTo, len));
      const diagnostic: CMDiagnostic = {
        from,
        to,
        severity: ERROR_CATEGORIES.has(d.category) ? 'error' : 'warning',
        message: d.message,
      };
      if (d.suggestion) {
        const suggestion = d.suggestion;
        const badToken = /`([^`]+)`/.exec(d.message)?.[1];
        diagnostic.actions = [
          {
            name: `Replace with ${suggestion}`,
            apply(v, aFrom, aTo) {
              const span = v.state.doc.sliceString(aFrom, aTo);
              const offset = badToken ? span.indexOf(badToken) : -1;
              if (badToken && offset >= 0) {
                v.dispatch({
                  changes: {
                    from: aFrom + offset,
                    to: aFrom + offset + badToken.length,
                    insert: suggestion,
                  },
                });
              }
            },
          },
        ];
      }
      return diagnostic;
    });
  },
  { delay: 200 }
);
