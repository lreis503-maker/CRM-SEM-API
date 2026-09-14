import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { format, formatDistance } from 'date-fns';
import messages from '../../messages/pt.json';
import { resolveAppLocale } from './locale';
import { APP_DATE_LOCALE } from './date-locale';

describe('português brasileiro', () => {
  it.each([undefined, '', 'pt', 'pt-BR', 'pt_BR', ' PT-br ', 'invalid'])
    ('usa o catálogo em português para %s', (value) => {
      expect(resolveAppLocale(value)).toEqual({ locale: 'pt-BR', catalogue: 'pt' });
    });

  it('mantém os outros idiomas disponíveis', () => {
    expect(resolveAppLocale('en')).toEqual({ locale: 'en-US', catalogue: 'en' });
    expect(resolveAppLocale('es')).toEqual({ locale: 'es', catalogue: 'es' });
    expect(resolveAppLocale('ko')).toEqual({ locale: 'ko-KR', catalogue: 'ko' });
  });

  it('traduz datas e intervalos relativos', () => {
    const start = new Date(2026, 8, 14, 12);
    expect(format(start, 'MMMM', { locale: APP_DATE_LOCALE })).toBe('setembro');
    expect(formatDistance(new Date(2026, 8, 14, 12, 5), start, {
      locale: APP_DATE_LOCALE, addSuffix: true,
    })).toBe('em 5 minutos');
  });

  it('traduz o carregamento, modos visuais e avisos sem perder variáveis', () => {
    const errors: unknown[] = [];
    const t = createTranslator({ locale: 'pt-BR', messages, onError: error => errors.push(error) });
    expect(t('Common.loading')).toBe('Carregando...');
    expect(t('ModeToggle.switchMode', { mode: t('ModeToggle.modes.dark') })).toBe('Mudar para o modo Escuro');
    expect(t('Contacts.importModal.toastInvalidPhone_plural', { count: 2 })).toBe('2 contatos não tinham um número de telefone válido');
    expect(t('Settings.overview.tagsCount', { count: 2 })).toBe('2 etiquetas');
    expect(errors).toEqual([]);
  });
});
