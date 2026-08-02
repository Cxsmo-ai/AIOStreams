import * as constants from '../../../../../core/src/utils/constants';
import { BUILTIN_FORMATTER_DEFINITIONS } from '../../../../../core/src/utils/formatter-definitions';
import { UserData } from '@aiostreams/core';

// Read the active name/description templates from userData — single source of truth.
export function getTemplates(data: UserData): {
  name: string;
  description: string;
} {
  const id = data.formatter.id;
  const defs = data.formatter.definitions;
  if (id === constants.CUSTOM_FORMATTER) {
    return {
      name: defs?.custom?.name ?? '',
      description: defs?.custom?.description ?? '',
    };
  }
  const override = defs?.overrides?.[id];
  if (override)
    return { name: override.name, description: override.description };
  const builtin = BUILTIN_FORMATTER_DEFINITIONS[id];
  return { name: builtin?.name ?? '', description: builtin?.description ?? '' };
}
