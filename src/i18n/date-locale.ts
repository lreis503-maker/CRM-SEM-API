import { enUS, es, ko, ptBR } from 'date-fns/locale';
import { APP_LANGUAGE } from './locale';

/** Tradução de meses, dias da semana e intervalos relativos do date-fns. */
export const APP_DATE_LOCALE = { en: enUS, es, ko, pt: ptBR }[APP_LANGUAGE.catalogue];
