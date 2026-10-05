/**
 * Exact-match find-and-replace edits, the way coding agents edit files:
 * each old_string must match once (or set replace_all), and edits apply in order.
 */

export interface TextEdit {
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
}

export interface TextEditResult {
  readonly text: string;
  readonly replacements: number;
}

export const MAX_TEXT_EDITS = 50;

export function applyTextEdits(text: string, edits: readonly TextEdit[]): TextEditResult {
  if (edits.length === 0) throw new Error('Pass at least one edit.');
  return edits.reduce<TextEditResult>(
    (acc, edit, i) => {
      const next = applyTextEdit(acc.text, edit, `edit ${i + 1}`);
      return { text: next.text, replacements: acc.replacements + next.replacements };
    },
    { text, replacements: 0 },
  );
}

function applyTextEdit(text: string, edit: TextEdit, label: string): TextEditResult {
  const { old_string: oldString, new_string: newString } = edit;
  if (oldString === newString) {
    throw new Error(`${label}: old_string and new_string are the same, so there is nothing to change.`);
  }
  if (oldString === '') {
    if (text !== '') {
      throw new Error(`${label}: old_string is empty. That only works when the text is empty; otherwise quote the text to change.`);
    }
    return { text: newString, replacements: 1 };
  }

  const parts = text.split(oldString);
  const matches = parts.length - 1;
  if (matches === 0) {
    throw new Error(
      `${label}: old_string was not found. It must match the current text exactly, including spaces and line breaks. ` +
        'Read the text again before retrying.',
    );
  }
  if (matches > 1 && edit.replace_all !== true) {
    throw new Error(`${label}: old_string matches ${matches} places. Add nearby text so it matches once, or set replace_all to change every match.`);
  }
  if (edit.replace_all === true) {
    return { text: parts.join(newString), replacements: matches };
  }
  return { text: text.replace(oldString, () => newString), replacements: 1 };
}

/** Check agent input at the tool boundary before any edit runs. */
export function parseTextEdits(value: unknown): TextEdit[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('edits must be a non-empty array of { old_string, new_string, replace_all? } objects.');
  }
  if (value.length > MAX_TEXT_EDITS) {
    throw new Error(`Pass at most ${MAX_TEXT_EDITS} edits per call.`);
  }
  return value.map((item, i) => {
    const label = `edit ${i + 1}`;
    if (typeof item !== 'object' || item === null) throw new Error(`${label} must be an object.`);
    const { old_string: oldString, new_string: newString, replace_all: replaceAll } = item as Record<string, unknown>;
    if (typeof oldString !== 'string') throw new Error(`${label}: old_string must be a string.`);
    if (typeof newString !== 'string') throw new Error(`${label}: new_string must be a string.`);
    if (replaceAll !== undefined && typeof replaceAll !== 'boolean') throw new Error(`${label}: replace_all must be true or false.`);
    return { old_string: oldString, new_string: newString, replace_all: replaceAll === true };
  });
}
