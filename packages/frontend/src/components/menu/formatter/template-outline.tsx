import React, { useMemo, useState } from 'react';
import { EditorView } from '@codemirror/view';
import {
  ChevronDown,
  ChevronRight,
  Braces,
  GitBranch,
  Wrench,
  Layers,
} from 'lucide-react';
import {
  parseTemplate,
  TemplateNode,
} from '../../../../../core/src/formatters/engine';

type ItemKind = 'expression' | 'group' | 'tool' | 'branch';

interface OutlineItem {
  label: string;
  from: number;
  to: number;
  kind: ItemKind;
  children: OutlineItem[];
}

function truncate(text: string, max = 44): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// `base` is the document offset of the string these nodes were parsed from, so
// branch children (re-parsed from a substring) still map to a jump position.
function nodesToItems(nodes: TemplateNode[], base: number): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const node of nodes) {
    if (node.kind === 'raw') continue;
    const from = (node.start ?? 0) + base;
    const to = (node.end ?? 0) + base;
    if (node.kind === 'tool') {
      items.push({
        label: `{tools.${node.tool}}`,
        from,
        to,
        kind: 'tool',
        children: [],
      });
    } else if (node.kind === 'group') {
      items.push({
        label: 'optional group',
        from,
        to,
        kind: 'group',
        children: nodesToItems(node.nodes, base),
      });
    } else if (node.kind === 'expression') {
      const children: OutlineItem[] = [];
      if (node.check) {
        const branches: [string, string | undefined, number | undefined][] = [
          ['true', node.check.trueTemplate, node.check.trueStart],
          ['false', node.check.falseTemplate, node.check.falseStart],
          ['absent', node.check.absentTemplate, node.check.absentStart],
        ];
        for (const [name, text, start] of branches) {
          if (text === undefined || start === undefined) continue;
          children.push({
            label: `${name}: "${truncate(text, 28)}"`,
            from: start,
            to: start + text.length,
            kind: 'branch',
            children: nodesToItems(parseTemplate(text).nodes, start),
          });
        }
      }
      items.push({
        label: truncate(node.source),
        from,
        to,
        kind: 'expression',
        children,
      });
    }
  }
  return items;
}

const ICONS: Record<ItemKind, React.ReactNode> = {
  expression: <Braces className="w-3.5 h-3.5 text-[--sky]" />,
  group: <Layers className="w-3.5 h-3.5 text-[--violet]" />,
  branch: <GitBranch className="w-3.5 h-3.5 text-[--amber]" />,
  tool: <Wrench className="w-3.5 h-3.5 text-[--teal]" />,
};

function OutlineRow({
  item,
  depth,
  onJump,
}: {
  item: OutlineItem;
  depth: number;
  onJump: (item: OutlineItem) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = item.children.length > 0;
  return (
    <div>
      <div
        className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[--subtle] cursor-pointer text-xs"
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 text-[--muted] hover:text-[--foreground]"
          >
            {open ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {ICONS[item.kind]}
        <button
          type="button"
          onClick={() => onJump(item)}
          className="min-w-0 truncate font-mono text-left text-[--muted-highlight] hover:text-[--foreground]"
          title="Jump to this part of the template"
        >
          {item.label}
        </button>
      </div>
      {hasChildren && open && (
        <div>
          {item.children.map((child, i) => (
            <OutlineRow
              key={i}
              item={child}
              depth={depth + 1}
              onJump={onJump}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TemplateOutline({
  template,
  getView,
}: {
  template: string;
  getView: () => EditorView | null;
}) {
  const [open, setOpen] = useState(false);
  const items = useMemo(
    () => nodesToItems(parseTemplate(template).nodes, 0),
    [template]
  );

  const jump = (item: OutlineItem) => {
    const view = getView();
    if (!view) return;
    const len = view.state.doc.length;
    view.dispatch({
      selection: {
        anchor: Math.min(item.from, len),
        head: Math.min(item.to, len),
      },
      scrollIntoView: true,
    });
    view.focus();
  };

  if (items.length === 0) return null;

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-[--muted] hover:text-[--foreground]"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
        Structure ({items.length})
      </button>
      {open && (
        <div className="mt-1 max-h-56 overflow-y-auto rounded-md border border-[--border] bg-[--subtle] p-1">
          {items.map((item, i) => (
            <OutlineRow key={i} item={item} depth={0} onJump={jump} />
          ))}
        </div>
      )}
    </div>
  );
}
