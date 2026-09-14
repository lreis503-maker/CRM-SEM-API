import { getRequestConfig } from 'next-intl/server';
import { APP_LANGUAGE } from './locale';

export default getRequestConfig(async () => {
  // Português brasileiro é o padrão, inclusive para valores desconhecidos.
  const { locale, catalogue } = APP_LANGUAGE;
  const messages = (await import(`../../messages/${catalogue}.json`)).default;

  return {
    locale,
    messages
  };
});
