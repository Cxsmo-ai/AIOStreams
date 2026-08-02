import React, { useEffect, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { Code2, Type } from 'lucide-react';
import * as constants from '../../../../../core/src/utils/constants';
import { BUILTIN_FORMATTER_DEFINITIONS } from '../../../../../core/src/utils/formatter-definitions';
import { useUserData } from '@/context/userData';
import { UserData } from '@aiostreams/core';
import { SettingsCard } from '../../shared/settings-card';
import { Select } from '../../ui/select';
import { FormatterEditor } from './editor';
import { Textarea } from '../../ui/textarea';
import { Button } from '../../ui/button';
import { IconButton } from '../../ui/button';
import { Tooltip } from '../../ui/tooltip';
import { ImportModal } from '../../shared/import-modal';
import { useDisclosure } from '@/hooks/disclosure';
import { toast } from 'sonner';
import { FaFileImport, FaFileExport, FaSave } from 'react-icons/fa';
import { SnippetsButton } from './snippets-button';
import { SavedFormattersModal } from './saved-formatters-modal';
import { TemplateOutline } from './template-outline';
import { getTemplates } from './templates';

// Client-only UI preference (not synced to userData): a plain-textarea fallback.
const SIMPLE_EDITOR_KEY = 'aiostreams:formatter-simple-editor';
function loadSimpleEditorPref(): boolean {
  try {
    return localStorage.getItem(SIMPLE_EDITOR_KEY) === '1';
  } catch {
    return false;
  }
}

const formatterChoices = Object.values(constants.FORMATTER_DETAILS);

// Write name+description back into userData for whatever formatter is currently active.
function applyTemplates(
  prev: UserData,
  name: string,
  description: string
): UserData {
  const id = prev.formatter.id;
  if (id === constants.CUSTOM_FORMATTER) {
    return {
      ...prev,
      formatter: {
        ...prev.formatter,
        definitions: {
          ...prev.formatter.definitions,
          custom: { name, description },
        },
      },
    };
  }
  const builtin = BUILTIN_FORMATTER_DEFINITIONS[id];
  const matchesBuiltin =
    !!builtin && name === builtin.name && description === builtin.description;
  const nextOverrides = { ...(prev.formatter.definitions?.overrides ?? {}) };
  if (matchesBuiltin) {
    delete nextOverrides[id];
  } else {
    nextOverrides[id] = { name, description };
  }
  return {
    ...prev,
    formatter: {
      ...prev.formatter,
      definitions: {
        ...prev.formatter.definitions,
        overrides:
          Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined,
      },
    },
  };
}

export function FormatterSelection() {
  const { userData, setUserData } = useUserData();
  const importModalDisclosure = useDisclosure(false);
  const savedModalDisclosure = useDisclosure(false);

  // views for the outline's go-to and for inserting snippets at the caret
  const nameViewRef = useRef<EditorView | null>(null);
  const descViewRef = useRef<EditorView | null>(null);
  const focusedViewRef = useRef<EditorView | null>(null);

  const [simpleEditor, setSimpleEditor] =
    useState<boolean>(loadSimpleEditorPref);
  useEffect(() => {
    try {
      localStorage.setItem(SIMPLE_EDITOR_KEY, simpleEditor ? '1' : '0');
    } catch {
      // preference is best-effort; ignore storage failures
    }
  }, [simpleEditor]);

  // The rich editor and the plain textarea share the same value/onValueChange
  // contract, so either drops into the same slot.
  function renderEditor(
    value: string,
    onChange: (v: string) => void,
    placeholder: string,
    viewRef: React.MutableRefObject<EditorView | null>
  ) {
    if (simpleEditor) {
      return (
        <Textarea
          value={value}
          onValueChange={onChange}
          placeholder={placeholder}
        />
      );
    }
    return (
      <FormatterEditor
        value={value}
        onValueChange={onChange}
        placeholder={placeholder}
        onViewReady={(view) => (viewRef.current = view)}
        onFocusView={(view) => (focusedViewRef.current = view)}
      />
    );
  }

  function insertSnippet(value: string): boolean {
    const view = focusedViewRef.current;
    if (!view) return false;
    view.dispatch(view.state.replaceSelection(value));
    view.focus();
    return true;
  }

  const currentId = userData.formatter.id;
  const definitions = userData.formatter.definitions;

  // Derived directly from userData — no local mirror state needed.
  const { name: nameTemplate, description: descriptionTemplate } =
    getTemplates(userData);
  const isCustomised =
    currentId !== constants.CUSTOM_FORMATTER &&
    !!definitions?.overrides?.[currentId];
  const savedDefinitions = definitions?.saved ?? {};
  const showTemplates =
    currentId === constants.CUSTOM_FORMATTER ||
    !!BUILTIN_FORMATTER_DEFINITIONS[currentId];

  function handleIdChange(newId: string) {
    const typedId = newId as constants.FormatterType;
    setUserData((prev) => {
      // When switching to custom with no existing definition, seed it from whatever is active now.
      if (
        typedId === constants.CUSTOM_FORMATTER &&
        !prev.formatter.definitions?.custom
      ) {
        const { name, description } = getTemplates(prev);
        return {
          ...prev,
          formatter: {
            ...prev.formatter,
            id: typedId,
            definitions: {
              ...prev.formatter.definitions,
              custom: { name, description },
            },
          },
        };
      }
      return { ...prev, formatter: { ...prev.formatter, id: typedId } };
    });
  }

  function handleReset() {
    setUserData((prev) => {
      const id = prev.formatter.id;
      const nextOverrides = {
        ...(prev.formatter.definitions?.overrides ?? {}),
      };
      delete nextOverrides[id];
      return {
        ...prev,
        formatter: {
          ...prev.formatter,
          definitions: {
            ...prev.formatter.definitions,
            overrides:
              Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined,
          },
        },
      };
    });
  }

  function handleExport() {
    const data = { name: nameTemplate, description: descriptionTemplate };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'formatter.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('Formatter exported successfully');
  }

  function handleImport(data: any) {
    if (typeof data.name === 'string' && typeof data.description === 'string') {
      setUserData((prev) => applyTemplates(prev, data.name, data.description));
      toast.success('Formatter imported successfully');
    } else {
      toast.error('Invalid formatter format');
    }
  }

  function handleSaveCurrentFormatter(savedName: string) {
    const name = savedName.trim();
    if (!name) {
      toast.error('Please enter a name');
      return;
    }
    setUserData((prev) => {
      const { name: tName, description: tDesc } = getTemplates(prev);
      return {
        ...prev,
        formatter: {
          ...prev.formatter,
          definitions: {
            ...prev.formatter.definitions,
            saved: {
              ...(prev.formatter.definitions?.saved ?? {}),
              [name]: { name: tName, description: tDesc },
            },
          },
        },
      };
    });
    toast.success('Formatter saved');
  }

  function handleLoadSavedFormatter(savedName: string) {
    setUserData((prev) => {
      const saved = prev.formatter.definitions?.saved?.[savedName];
      if (!saved) return prev;
      return applyTemplates(prev, saved.name, saved.description);
    });
    toast.success(`Loaded "${savedName}"`);
  }

  function handleRenameSavedFormatter(oldName: string, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed) {
      toast.error('Name cannot be empty');
      return;
    }
    if (trimmed === oldName) return;
    if (savedDefinitions[trimmed]) {
      toast.error('A saved formatter with this name already exists');
      return;
    }
    setUserData((prev) => {
      const saved = prev.formatter.definitions?.saved ?? {};
      if (!saved[oldName]) return prev;
      const entries = Object.entries(saved).map(([k, v]) =>
        k === oldName ? [trimmed, v] : [k, v]
      );
      return {
        ...prev,
        formatter: {
          ...prev.formatter,
          definitions: {
            ...prev.formatter.definitions,
            saved: Object.fromEntries(entries),
          },
        },
      };
    });
    toast.success('Saved formatter renamed');
  }

  function handleDeleteSavedFormatter(savedName: string) {
    setUserData((prev) => {
      const saved = { ...(prev.formatter.definitions?.saved ?? {}) };
      if (!saved[savedName]) return prev;
      delete saved[savedName];
      return {
        ...prev,
        formatter: {
          ...prev.formatter,
          definitions: {
            ...prev.formatter.definitions,
            saved: Object.keys(saved).length > 0 ? saved : undefined,
          },
        },
      };
    });
    toast.success('Saved formatter deleted');
  }

  return (
    <>
      <SettingsCard
        title="Formatter Selection"
        id="formatter"
        description="Choose how your streams should be formatted"
      >
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <Select
              value={currentId}
              onValueChange={handleIdChange}
              options={formatterChoices.map((f) => ({
                label: f.name,
                value: f.id,
              }))}
            />
          </div>
          {currentId !== constants.CUSTOM_FORMATTER && (
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 min-w-[7.75rem] text-center ${
                isCustomised
                  ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
                  : 'bg-green-500/20 text-green-400 border-green-500/30'
              }`}
            >
              {isCustomised ? 'Customised' : 'Using built-in'}
            </span>
          )}
        </div>

        {currentId !== constants.CUSTOM_FORMATTER && (
          <p className="text-sm text-muted-foreground mt-2">
            {formatterChoices.find((f) => f.id === currentId)?.description}
          </p>
        )}

        {showTemplates && (
          <div className="space-y-4 mt-4">
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm text-gray-400">
                Type <span className="font-mono">{'{debug.jsonf}'}</span> to see
                all available variables. See the{' '}
                <a
                  href="https://docs.aiostreams.viren070.me/reference/custom-formatter"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[--brand] hover:text-[--brand]/80 hover:underline"
                >
                  docs
                </a>{' '}
                for a full reference.
              </div>
              <Tooltip
                trigger={
                  <IconButton
                    rounded
                    size="sm"
                    intent="primary-subtle"
                    className="shrink-0"
                    icon={
                      simpleEditor ? (
                        <Code2 className="w-4 h-4" />
                      ) : (
                        <Type className="w-4 h-4" />
                      )
                    }
                    onClick={() => setSimpleEditor((v) => !v)}
                  />
                }
              >
                {simpleEditor
                  ? 'Switch to the rich editor'
                  : 'Switch to a plain textarea'}
              </Tooltip>
            </div>

            <div>
              <label className="text-sm font-medium mb-2 block">
                Name Template
              </label>
              {renderEditor(
                nameTemplate,
                (v) =>
                  setUserData((prev) =>
                    applyTemplates(prev, v, getTemplates(prev).description)
                  ),
                'Enter a template for the stream name',
                nameViewRef
              )}
              {!simpleEditor && (
                <TemplateOutline
                  template={nameTemplate}
                  getView={() => nameViewRef.current}
                />
              )}
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">
                Description Template
              </label>
              {renderEditor(
                descriptionTemplate,
                (v) =>
                  setUserData((prev) =>
                    applyTemplates(prev, getTemplates(prev).name, v)
                  ),
                'Enter a template for the stream description',
                descViewRef
              )}
              {!simpleEditor && (
                <TemplateOutline
                  template={descriptionTemplate}
                  getView={() => descViewRef.current}
                />
              )}
            </div>

            <div className="flex gap-2 items-center flex-wrap">
              <SnippetsButton
                onInsert={simpleEditor ? undefined : insertSnippet}
              />
              {isCustomised && (
                <Button intent="white" size="sm" onClick={handleReset}>
                  Reset to built-in
                </Button>
              )}
              <div className="ml-auto flex gap-2">
                <Tooltip
                  trigger={
                    <IconButton
                      rounded
                      size="sm"
                      intent="primary-subtle"
                      icon={<FaSave />}
                      onClick={savedModalDisclosure.open}
                    />
                  }
                >
                  Saved formatters
                </Tooltip>
                <Tooltip
                  trigger={
                    <IconButton
                      rounded
                      size="sm"
                      intent="primary-subtle"
                      icon={<FaFileImport />}
                      onClick={importModalDisclosure.open}
                    />
                  }
                >
                  Import
                </Tooltip>
                <Tooltip
                  trigger={
                    <IconButton
                      rounded
                      size="sm"
                      intent="primary-subtle"
                      icon={<FaFileExport />}
                      onClick={handleExport}
                    />
                  }
                >
                  Export
                </Tooltip>
              </div>
            </div>
          </div>
        )}
      </SettingsCard>

      <ImportModal
        open={importModalDisclosure.isOpen}
        onOpenChange={importModalDisclosure.toggle}
        onImport={handleImport}
      />

      <SavedFormattersModal
        open={savedModalDisclosure.isOpen}
        onOpenChange={savedModalDisclosure.toggle}
        canSaveCurrent={
          currentId === constants.CUSTOM_FORMATTER || isCustomised
        }
        savedDefinitions={savedDefinitions}
        onSave={handleSaveCurrentFormatter}
        onLoad={handleLoadSavedFormatter}
        onRename={handleRenameSavedFormatter}
        onDelete={handleDeleteSavedFormatter}
      />
    </>
  );
}
