import en from './en';
import zhCN from './zh-CN';
import zhTW from './zh-TW';
import es from './es';
import fr from './fr';
import ru from './ru';
import hi from './hi';
import ar from './ar';

export type TranslationDict = typeof en;
export type SupportedLocale = 'en' | 'zh-CN' | 'zh-TW' | 'es' | 'fr' | 'ru' | 'hi' | 'ar';

const DICTIONARIES: Record<SupportedLocale, TranslationDict> = {
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  es,
  fr,
  ru,
  hi,
  ar,
};

const FALLBACK: SupportedLocale = 'en';

/**
 * Map browser/OS language codes to our supported locales.
 */
function resolveLocale(raw: string): SupportedLocale {
  const code = raw.replace(/_/g, '-');

  // Exact match
  if (code in DICTIONARIES) return code as SupportedLocale;

  // Match language prefix
  const lang = code.split('-')[0];

  switch (lang) {
    case 'zh': {
      // Traditional Chinese if region is HK/MO/TW
      const region = code.split('-')[1] || '';
      if (region === 'TW' || region === 'HK' || region === 'MO') return 'zh-TW';
      return 'zh-CN';
    }
    case 'es':
      return 'es';
    case 'fr':
      return 'fr';
    case 'ru':
      return 'ru';
    case 'hi':
      return 'hi';
    case 'ar':
      return 'ar';
    default:
      return FALLBACK;
  }
}

/**
 * Deep key lookup: t('settings.auth.title') → "Authentication"
 */
function resolveKey(dict: TranslationDict, path: string): string {
  const keys = path.split('.');
  let val: any = dict;
  for (const k of keys) {
    if (val === undefined || val === null) return path;
    val = val[k];
  }
  return typeof val === 'string' ? val : path;
}

export class I18n {
  private locale: SupportedLocale;
  private dict: TranslationDict;

  constructor() {
    const raw = typeof navigator !== 'undefined'
      ? (navigator.language || 'en')
      : 'en';
    this.locale = resolveLocale(raw);
    this.dict = DICTIONARIES[this.locale] || DICTIONARIES[FALLBACK];
  }

  /** Get the resolved locale code. */
  getLocale(): SupportedLocale {
    return this.locale;
  }

  /** Is the current locale right-to-left? */
  isRTL(): boolean {
    return this.locale === 'ar';
  }

  /** Translate a dot-separated key. */
  t(path: string): string {
    return resolveKey(this.dict, path);
  }

  /** Re-init with a specific locale (useful for testing or manual override). */
  setLocale(locale: SupportedLocale): void {
    this.locale = locale;
    this.dict = DICTIONARIES[locale] || DICTIONARIES[FALLBACK];
  }
}

/** Singleton i18n instance. */
export const i18n = new I18n();
