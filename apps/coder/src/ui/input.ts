import type { Key } from "ink";

export interface InputState {
  text: string;
  cursor: number; // index in text the next character goes to
}

export const emptyInput: InputState = { text: "", cursor: 0 };

/** One keypress applied to the input line. Keys it does not handle leave the state as it is. */
export function editInput(state: InputState, value: string, key: Partial<Key>): InputState {
  const { text, cursor } = state;

  if (key.leftArrow) return { text, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow) return { text, cursor: Math.min(text.length, cursor + 1) };
  if (key.backspace || key.delete) {
    if (cursor === 0) return state;
    return { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 };
  }
  if (key.ctrl) {
    if (value === "a") return { text, cursor: 0 };
    if (value === "e") return { text, cursor: text.length };
    if (value === "u") return emptyInput;
    return state;
  }
  if (!value || key.meta) return state;

  // A paste arrives as one value; its line breaks must not read as Enter.
  const typed = value.replace(/[\r\n]+/g, " ");
  return { text: text.slice(0, cursor) + typed + text.slice(cursor), cursor: cursor + typed.length };
}
