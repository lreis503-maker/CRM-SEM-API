/**
 * What a tag picker should show for a given account, contact and search
 * box.
 *
 * Kept pure so the decisions that are easy to get subtly wrong — an
 * exact-name match hiding the "create" row, a tag already on the contact
 * still appearing as new, case and accent differences counting as
 * different tags — are testable without rendering anything.
 */

import type { Tag } from '@/types';

export interface TagPickerInput {
  /** Every tag the account has, in display order. */
  allTags: Tag[];
  /** Ids of the tags already on this contact. */
  selectedIds: string[];
  /** What the user typed. */
  search: string;
}

export interface TagPickerOption {
  tag: Tag;
  selected: boolean;
}

export interface TagPickerView {
  options: TagPickerOption[];
  /**
   * The name a "create and apply" row should offer, or null when there
   * is nothing to create: an empty box, or a name the account already
   * has.
   */
  creatableName: string | null;
  /** True when the account has tags but none match the search. */
  emptyBecauseOfSearch: boolean;
  /** True when the account has no tags at all yet. */
  noTagsYet: boolean;
}

/**
 * Compares names the way a person would: "Lead Quente", "lead quente"
 * and "LEAD QUENTE" are one tag, not three. Accents are folded too, so
 * someone typing without them does not create a duplicate nobody can
 * tell apart in the list.
 */
export function normalizeTagName(name: string): string {
  return name
    .trim()
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export function deriveTagPickerView(input: TagPickerInput): TagPickerView {
  const selected = new Set(input.selectedIds);
  const query = normalizeTagName(input.search);

  const options = input.allTags
    .filter((tag) => query === '' || normalizeTagName(tag.name).includes(query))
    .map((tag) => ({ tag, selected: selected.has(tag.id) }));

  const typed = input.search.trim();
  const alreadyExists = input.allTags.some(
    (tag) => normalizeTagName(tag.name) === query
  );

  return {
    options,
    creatableName: typed === '' || alreadyExists ? null : typed,
    emptyBecauseOfSearch: input.allTags.length > 0 && options.length === 0,
    noTagsYet: input.allTags.length === 0,
  };
}

/**
 * Colours for a tag created from the picker.
 *
 * The picker does not ask for a colour — that would turn a one-keystroke
 * action into a form. It picks the next unused one instead, so a handful
 * of tags made in a row are still told apart at a glance, and only wraps
 * around once every colour is taken.
 */
export const TAG_COLORS = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#10b981',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
] as const;

export function nextTagColor(existing: Tag[]): string {
  const used = new Set(existing.map((tag) => (tag.color ?? '').toLowerCase()));
  return (
    TAG_COLORS.find((color) => !used.has(color)) ??
    TAG_COLORS[existing.length % TAG_COLORS.length]
  );
}
