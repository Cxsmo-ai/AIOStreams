import {
  autocompletion,
  Completion,
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import {
  ARGUMENT_EXAMPLES,
  CALL_MODIFIERS,
  comparatorNames,
  FIELD_REGISTRY,
  stringModifierNames,
  numberModifierNames,
  arrayModifierNames,
  booleanModifierNames,
  conditionalModifierNames,
} from '../../../../../../core/src/formatters/engine';

const SECTIONS = Object.keys(FIELD_REGISTRY);

const sectionCompletions: Completion[] = SECTIONS.map((section) => ({
  label: section,
  type: 'namespace',
  // a section is only ever followed by `.property`, so complete the dot too
  apply: `${section}.`,
}));

// after `::` the user may want a modifier, a comparator, or a conditional
const modifierCompletions: Completion[] = [
  ...CALL_MODIFIERS.map(([name, shape]) => ({
    label: name,
    type: 'function',
    detail: ARGUMENT_EXAMPLES[shape],
    apply: `${name}${ARGUMENT_EXAMPLES[shape]}`,
  })),
  ...conditionalModifierNames.map((name) => ({
    label: name,
    type: 'keyword',
    detail: 'conditional',
  })),
  ...dedupe([
    ...stringModifierNames,
    ...numberModifierNames,
    ...arrayModifierNames,
    ...booleanModifierNames,
  ]).map((name) => ({ label: name, type: 'method' })),
  ...comparatorNames.map((name) => ({
    label: name,
    type: 'operator',
    detail: 'comparator',
    apply: `${name}::`,
  })),
];

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function propertyCompletions(section: string): Completion[] {
  const canonical = SECTIONS.find(
    (s) => s.toLowerCase() === section.toLowerCase()
  );
  if (!canonical) return [];
  return FIELD_REGISTRY[canonical].map((property) => ({
    label: property,
    type: 'property',
  }));
}

const IDENT = /^[A-Za-z]*$/;

function completeFormatter(
  context: CompletionContext
): CompletionResult | null {
  const before = context.state.doc.sliceString(0, context.pos);
  const open = before.lastIndexOf('{');
  if (open < 0) return null;
  // only inside a still-open expression
  if (before.lastIndexOf('}') > open) return null;
  const inExpr = before.slice(open);

  // after `::` → modifiers / comparators
  const afterSep = /::([A-Za-z]*)$/.exec(inExpr);
  if (afterSep) {
    return {
      from: context.pos - afterSep[1].length,
      options: modifierCompletions,
      validFor: IDENT,
    };
  }

  // `section.` → that section's properties
  const afterDot = /([A-Za-z]+)\.([A-Za-z]*)$/.exec(inExpr);
  if (afterDot) {
    const options = propertyCompletions(afterDot[1]);
    if (options.length)
      return {
        from: context.pos - afterDot[2].length,
        options,
        validFor: IDENT,
      };
  }

  // `{` (but not `{?`) → sections
  const afterBrace = /\{\s*([A-Za-z]*)$/.exec(inExpr);
  if (afterBrace) {
    return {
      from: context.pos - afterBrace[1].length,
      options: sectionCompletions,
      validFor: IDENT,
    };
  }

  return null;
}

export const formatterCompletion = autocompletion({
  override: [completeFormatter],
  icons: false,
});
