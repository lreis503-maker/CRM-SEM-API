/** Idioma da aplicação e formato regional usados em toda a interface. */
export function resolveAppLocale(value?: string): {
  locale: string;
  catalogue: 'pt' | 'en' | 'es' | 'ko';
} {
  const requested = value?.trim().replaceAll('_', '-').toLowerCase();
  switch (requested) {
    case 'en':
    case 'en-us':
      return { locale: 'en-US', catalogue: 'en' };
    case 'es':
      return { locale: 'es', catalogue: 'es' };
    case 'ko':
    case 'ko-kr':
      return { locale: 'ko-KR', catalogue: 'ko' };
    default:
      return { locale: 'pt-BR', catalogue: 'pt' };
  }
}

export const APP_LANGUAGE = resolveAppLocale(process.env.NEXT_PUBLIC_APP_LOCALE);
export const APP_LOCALE = APP_LANGUAGE.locale;
