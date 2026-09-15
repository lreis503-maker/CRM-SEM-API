import { describe, expect, it } from 'vitest';

import type { Tag } from '@/types';

import {
  TAG_COLORS,
  deriveTagPickerView,
  nextTagColor,
  normalizeTagName,
} from './tag-picker';

function tag(id: string, name: string, color = '#3b82f6'): Tag {
  return {
    id,
    user_id: 'u-1',
    account_id: 'acc-1',
    name,
    color,
    created_at: '2026-09-15T00:00:00.000Z',
  } as Tag;
}

const TAGS = [
  tag('t-1', 'Lead Quente', '#ef4444'),
  tag('t-2', 'Lead Frio', '#06b6d4'),
  tag('t-3', 'Orçamento enviado', '#10b981'),
];

function view(
  overrides: Partial<Parameters<typeof deriveTagPickerView>[0]> = {}
) {
  return deriveTagPickerView({
    allTags: TAGS,
    selectedIds: [],
    search: '',
    ...overrides,
  });
}

describe('deriveTagPickerView', () => {
  it('offers every tag the account has when nothing is typed', () => {
    expect(view().options.map((o) => o.tag.id)).toEqual(['t-1', 't-2', 't-3']);
  });

  it('marks the tags already on the contact', () => {
    const result = view({ selectedIds: ['t-2'] });

    expect(result.options.map((o) => o.selected)).toEqual([false, true, false]);
  });

  it('filters as the user types', () => {
    expect(view({ search: 'quente' }).options.map((o) => o.tag.id)).toEqual([
      't-1',
    ]);
  });

  it('ignores accents, so typing without them still finds the tag', () => {
    // Someone typing fast will not reach for the ç.
    expect(view({ search: 'orcamento' }).options.map((o) => o.tag.id)).toEqual([
      't-3',
    ]);
  });

  it('ignores case', () => {
    expect(view({ search: 'LEAD' }).options).toHaveLength(2);
  });

  it('offers to create a name the account does not have', () => {
    expect(view({ search: 'Cliente VIP' }).creatableName).toBe('Cliente VIP');
  });

  it('does not offer to create a name that already exists', () => {
    // Otherwise two tags with the same name appear in every list and
    // nobody can tell which one a contact carries.
    expect(view({ search: 'lead quente' }).creatableName).toBeNull();
    expect(view({ search: 'Orcamento Enviado' }).creatableName).toBeNull();
  });

  it('does not offer to create from an empty or blank box', () => {
    expect(view({ search: '' }).creatableName).toBeNull();
    expect(view({ search: '   ' }).creatableName).toBeNull();
  });

  it('keeps the name exactly as typed when offering to create it', () => {
    // The search is folded for comparison only; the tag is created with
    // the capitals and accents the person actually wrote.
    expect(view({ search: '  Orçamento Aprovado  ' }).creatableName).toBe(
      'Orçamento Aprovado'
    );
  });

  it('says when a search matched nothing', () => {
    const result = view({ search: 'nada disso' });

    expect(result.emptyBecauseOfSearch).toBe(true);
    expect(result.noTagsYet).toBe(false);
  });

  it('tells an empty account apart from an empty search', () => {
    // Different messages: one says "create your first tag", the other
    // says "no match".
    const result = deriveTagPickerView({
      allTags: [],
      selectedIds: [],
      search: '',
    });

    expect(result.noTagsYet).toBe(true);
    expect(result.emptyBecauseOfSearch).toBe(false);
  });
});

describe('normalizeTagName', () => {
  it('treats the same name written differently as one name', () => {
    const forms = [
      'Lead Quente',
      'lead quente',
      'LEAD QUENTE',
      ' Lead  Quente ',
    ];
    const normalized = forms.map(normalizeTagName);

    // The double space in the last form is a genuine difference in the
    // name, so only the first three collapse.
    expect(new Set(normalized.slice(0, 3)).size).toBe(1);
  });

  it('folds accents', () => {
    expect(normalizeTagName('Orçamento')).toBe(normalizeTagName('orcamento'));
  });
});

describe('nextTagColor', () => {
  it('starts at the first colour for a brand new account', () => {
    expect(nextTagColor([])).toBe(TAG_COLORS[0]);
  });

  it('skips colours already in use, so new tags look different', () => {
    expect(nextTagColor([tag('t-1', 'A', TAG_COLORS[0])])).toBe(TAG_COLORS[1]);
  });

  it('ignores the case a colour was stored in', () => {
    expect(nextTagColor([tag('t-1', 'A', TAG_COLORS[0].toUpperCase())])).toBe(
      TAG_COLORS[1]
    );
  });

  it('wraps around once every colour is taken', () => {
    const all = TAG_COLORS.map((color, i) => tag(`t-${i}`, `T${i}`, color));

    expect(TAG_COLORS).toContain(nextTagColor(all));
  });
});
